import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createPolicyStore } from '../lib/core/policy.js';
import { createRevisionStore } from '../lib/core/revisions.js';
import { createOverlayProvider, OVERLAY_PROVIDER, OVERLAY_RANK } from '../lib/host/overlay.js';
import { createHandlers, ROUTES } from '../lib/routes.js';
import { readPackage } from '../lib/core/pack.js';
import { readZip } from '../lib/core/zip.js';
import { makeTempDir, writeText, pathExists } from './helpers.js';

const SKILL_MD = (name, desc = '说明') => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n正文\n`;

async function setupHost(label) {
  const base = await makeTempDir(label);
  const dataDir = path.join(base, 'data');
  const rootDir = path.join(base, 'skills');
  await writeText(path.join(rootDir, 'alpha', 'SKILL.md'), SKILL_MD('alpha', '第一个技能'));
  await writeText(path.join(rootDir, 'alpha', 'references', 'a.md'), 'A\n');
  await writeText(path.join(rootDir, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: 第二个\nuser-invocable: false\n---\n\n正文\n');
  const policy = createPolicyStore({ dataDir });
  const store = createRevisionStore({ dataDir });
  const rootsOf = () => [{ key: 'user-dsh', rank: 400, dir: rootDir, label: '测试技能根', managed: true, skipSystem: true }];
  const overlay = { provider: createOverlayProvider({ policy, logger: { warn: () => {}, error: () => {} } }), state: { global: true, scopes: 0 } };
  const handlers = createHandlers({
    dataDir,
    policy,
    store,
    rootsOf,
    overlay,
    officialCatalog: async () => ({ complete: true, skills: [{ name: 'alpha' }, { name: 'bundled-only' }] }),
  });
  const get = (route, query = '') => new Request(`http://127.0.0.1:43120${route}${query}`, { method: 'GET' });
  const post = (route, body) =>
    new Request(`http://127.0.0.1:43120${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  return { base, dataDir, rootDir, policy, store, overlay, handlers, get, post };
}

export default function register(t) {
  t('ping：路由表完整且可应答', async () => {
    const { handlers, get } = await setupHost('host-ping');
    const res = await handlers.ping(get(ROUTES.ping));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.routes.includes('/api/skill-manager.list'));
    assert.ok(body.routes.includes('/api/skill-manager.layout'));
    assert.ok(body.policies.includes('disabled'));
    assert.equal(body.routes.length, 14);
  });

  t('list：磁盘真源 + 策略/版本字段 + 与官方目录对照', async () => {
    const { handlers, get } = await setupHost('host-list');
    const res = await handlers.list(get(ROUTES.list));
    const body = await res.json();
    assert.deepEqual(body.skills.map((s) => s.name).sort(), ['alpha', 'beta']);
    const alpha = body.skills.find((s) => s.name === 'alpha');
    assert.equal(alpha.policyId, 'follow');
    assert.equal(alpha.followFile, true);
    assert.equal(alpha.fileCount, 2);
    assert.equal(alpha.revisionCount, 0);
    const beta = body.skills.find((s) => s.name === 'beta');
    assert.equal(beta.filePolicyId, 'modelOnly');
    assert.equal(body.roots[0].key, 'user-dsh');
    assert.equal(body.roots[0].rank, 400);
    // 对照：alpha 两边都有；bundled-only 只在官方；磁盘上没有 disk-only
    assert.equal(body.official.available, true);
    const kinds = Object.fromEntries(body.official.items.map((i) => [i.name, i.kind]));
    assert.equal(kinds['bundled-only'], 'official-only');
  });

  t('policy：设置停用 → 覆盖 provider 立刻复报改写后的同名技能', async () => {
    const { handlers, post, get, overlay, rootDir } = await setupHost('host-policy');
    const set = await handlers.policy(post(ROUTES.policy, { sourceKey: 'user-dsh', name: 'alpha', policy: 'disabled' }));
    assert.equal(set.status, 200);
    const setBody = await set.json();
    assert.equal(setBody.policy, 'disabled');
    assert.equal(setBody.overlayActive.length, 1);
    assert.equal(setBody.overlayActive[0].ok, true);

    const candidates = await overlay.provider.list();
    assert.equal(candidates.length, 1);
    const candidate = candidates[0];
    assert.equal(candidate.name, 'alpha');
    assert.equal(candidate.provider, OVERLAY_PROVIDER);
    assert.equal(candidate.rank, OVERLAY_RANK);
    assert.equal(candidate.source, 'user-dsh');
    assert.deepEqual(candidate.invocation, { modelInvocable: false, userInvocable: false });
    assert.ok(candidate.description.length > 0);
    assert.equal(candidate.locator.path, path.join(rootDir, 'alpha', 'SKILL.md'));
    assert.equal(candidate.locator.directory, path.join(rootDir, 'alpha'));

    const definition = await overlay.provider.get(candidate);
    assert.deepEqual(definition.invocation, { modelInvocable: false, userInvocable: false });
    assert.equal(definition.provider, OVERLAY_PROVIDER);
    assert.equal(definition.source, 'user-dsh');
    assert.match(definition.content, /正文/);
    assert.equal(definition.resourceBase.kind, 'directory');

    // 列表接口应反映出覆盖后的策略
    const list = await (await handlers.list(get(ROUTES.list))).json();
    assert.equal(list.skills.find((s) => s.name === 'alpha').policyId, 'disabled');

    // 回到跟随文件 → 覆盖消失
    await handlers.policy(post(ROUTES.policy, { sourceKey: 'user-dsh', name: 'alpha', policy: 'follow' }));
    assert.equal((await overlay.provider.list()).length, 0);
  });

  t('policy：非法参数与未知策略被拒', async () => {
    const { handlers, post } = await setupHost('host-policy-bad');
    assert.equal((await handlers.policy(post(ROUTES.policy, { sourceKey: 'user-dsh' }))).status, 400);
    assert.equal((await handlers.policy(post(ROUTES.policy, { sourceKey: 'user-dsh', name: 'alpha', policy: 'nope' }))).status, 400);
    const raw = new Request(`http://127.0.0.1:43120${ROUTES.policy}`, { method: 'POST', body: 'not-json' });
    assert.equal((await handlers.policy(raw)).status, 400);
  });

  t('版本闭环：capture → 改动 → compare → restore → detail', async () => {
    const { handlers, get, post, rootDir } = await setupHost('host-version');
    const first = await (await handlers.capture(post(ROUTES.capture, { sourceKey: 'user-dsh', name: 'alpha', note: '初版' }))).json();
    assert.equal(first.created, true);
    assert.ok(first.entry.contentHash);

    await writeText(path.join(rootDir, 'alpha', 'SKILL.md'), SKILL_MD('alpha', '改过的说明'));
    const second = await (await handlers.capture(post(ROUTES.capture, { sourceKey: 'user-dsh', name: 'alpha' }))).json();
    assert.equal(second.created, true);

    const timeline = await (await handlers.revisions(get(ROUTES.revisions, '?sourceKey=user-dsh&name=alpha'))).json();
    assert.equal(timeline.entries.length, 2);
    assert.equal(timeline.current.matchesHead, true);
    assert.equal(timeline.current.dirty, false);

    const cmp = await (
      await handlers.compare(get(ROUTES.compare, `?sourceKey=user-dsh&name=alpha&a=${first.entry.contentHash}&b=${second.entry.contentHash}`))
    ).json();
    assert.equal(cmp.changed.length, 1);
    assert.equal(cmp.changed[0].path, 'SKILL.md');

    const lineDiff = await (
      await handlers.compare(
        get(ROUTES.compare, `?sourceKey=user-dsh&name=alpha&a=${first.entry.contentHash}&b=${second.entry.contentHash}&path=SKILL.md`),
      )
    ).json();
    assert.equal(lineDiff.status, 'changed');
    assert.match(lineDiff.diff.text, /\+description: 改过的说明/);

    // 打标签
    const annotated = await (
      await handlers.annotate(post(ROUTES.annotate, { sourceKey: 'user-dsh', name: 'alpha', revisionId: first.entry.contentHash, tag: 'v1' }))
    ).json();
    assert.equal(annotated.entry.tag, 'v1');

    // 回滚
    const restored = await (
      await handlers.restore(post(ROUTES.restore, { sourceKey: 'user-dsh', name: 'alpha', revisionId: first.entry.contentHash }))
    ).json();
    assert.equal(restored.restored, true);
    assert.match(await fs.readFile(path.join(rootDir, 'alpha', 'SKILL.md'), 'utf8'), /description: 第一个技能/);

    const detail = await (await handlers.detail(get(ROUTES.detail, '?sourceKey=user-dsh&name=alpha'))).json();
    assert.equal(detail.parsed.name, 'alpha');
    assert.equal(detail.files.files.length, 2);
    assert.equal(detail.revisions.length, 2);
  });

  t('export：返回可被 readPackage 校验的 zip；import：先计划后落盘', async () => {
    const { handlers, get, post, base } = await setupHost('host-pack');
    const response = await handlers.export(post(ROUTES.export, { items: [{ sourceKey: 'user-dsh', name: 'alpha' }] }));
    assert.equal(response.headers.get('content-type'), 'application/zip');
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.ok(buffer.length > 0);
    const pkg = await readPackage(buffer);
    assert.equal(pkg.problems.length, 0);
    assert.deepEqual(pkg.skills.map((s) => s.name), ['alpha']);
    assert.equal(pkg.skills[0].problems.length, 0);

    // 导入计划（dry-run）
    const targetDir = path.join(base, 'imported');
    const dryPlan = await (
      await handlers.import(
        new Request(`http://127.0.0.1:43120${ROUTES.import}?targetDir=${encodeURIComponent(targetDir)}`, {
          method: 'POST',
          body: buffer,
        }),
      )
    ).json();
    assert.equal(dryPlan.applied, false);
    assert.equal(dryPlan.plan.summary.create, 1);
    assert.equal(await pathExists(path.join(targetDir, 'alpha')), false, 'dry-run 不应落盘');

    // 真正落盘
    const applied = await (
      await handlers.import(
        new Request(`http://127.0.0.1:43120${ROUTES.import}?apply=1&targetDir=${encodeURIComponent(targetDir)}`, {
          method: 'POST',
          body: buffer,
        }),
      )
    ).json();
    assert.equal(applied.applied, true);
    assert.equal(await pathExists(path.join(targetDir, 'alpha', 'references', 'a.md')), true);

    // 空包 → 400
    const empty = await handlers.import(new Request(`http://127.0.0.1:43120${ROUTES.import}`, { method: 'POST', body: Buffer.alloc(0) }));
    assert.equal(empty.status, 400);
  });

  t('export：历史修订导出的是旧内容', async () => {
    const { handlers, post, rootDir } = await setupHost('host-export-rev');
    const first = await (await handlers.capture(post(ROUTES.capture, { sourceKey: 'user-dsh', name: 'alpha' }))).json();
    const oldText = await fs.readFile(path.join(rootDir, 'alpha', 'SKILL.md'), 'utf8');
    await writeText(path.join(rootDir, 'alpha', 'SKILL.md'), SKILL_MD('alpha', '第二版'));
    const response = await handlers.export(
      post(ROUTES.export, { items: [{ sourceKey: 'user-dsh', name: 'alpha', revisionId: first.entry.contentHash }] }),
    );
    const pkg = await readPackage(Buffer.from(await response.arrayBuffer()));
    const exported = pkg.skills[0].files.find((f) => f.path === 'SKILL.md').data.toString('utf8');
    assert.equal(exported, oldText);
    assert.match(await fs.readFile(path.join(rootDir, 'alpha', 'SKILL.md'), 'utf8'), /第二版/);
  });

  t('export：多技能合并成一个包', async () => {
    const { handlers, post } = await setupHost('host-export-multi');
    const response = await handlers.export(
      post(ROUTES.export, {
        items: [
          { sourceKey: 'user-dsh', name: 'alpha' },
          { sourceKey: 'user-dsh', name: 'beta' },
        ],
      }),
    );
    const pkg = await readPackage(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual(pkg.skills.map((s) => s.name).sort(), ['alpha', 'beta']);
    assert.equal(pkg.problems.length, 0);
  });

  t('baseline：一键建立基线，重复调用幂等，dirty 模式不产生空修订', async () => {
    const { handlers, post } = await setupHost('host-baseline');
    const first = await (await handlers.baseline(post(ROUTES.baseline, { mode: 'missing' }))).json();
    assert.equal(first.ok, true);
    assert.equal(first.mode, 'missing');
    assert.equal(first.created, 2, 'alpha/beta 都应建立基线');
    assert.equal(first.skipped, 0);

    const second = await (await handlers.baseline(post(ROUTES.baseline, { mode: 'missing' }))).json();
    assert.equal(second.created, 0);
    assert.equal(second.skipped, 2, '已有基线的技能应跳过');

    const dirty = await (await handlers.baseline(post(ROUTES.baseline, { mode: 'dirty' }))).json();
    assert.equal(dirty.created, 0);
    assert.equal(dirty.unchanged, 2, '内容未变不应产生新修订');

    // 非法 mode 退化为 missing，不报错
    const fallback = await (await handlers.baseline(post(ROUTES.baseline, { mode: 'nope' }))).json();
    assert.equal(fallback.mode, 'missing');
  });

  t('status：报告未捕获改动与未建基线', async () => {
    const { handlers, get, post, rootDir } = await setupHost('host-status');
    await handlers.capture(post(ROUTES.capture, { sourceKey: 'user-dsh', name: 'alpha' }));
    await writeText(path.join(rootDir, 'alpha', 'SKILL.md'), SKILL_MD('alpha', '改过的说明'));

    const body = await (await handlers.status(get(ROUTES.status))).json();
    assert.equal(body.ok, true);
    const alpha = body.items.find((i) => i.name === 'alpha');
    const beta = body.items.find((i) => i.name === 'beta');
    assert.equal(alpha.hasRevision, true);
    assert.equal(alpha.dirty, true, '改过之后应报告 dirty');
    assert.equal(beta.hasRevision, false);
    assert.equal(beta.dirty, null, '未建基线时 dirty 为 null（不是 false）');
    assert.equal(body.counts.total, 2);
    assert.equal(body.counts.dirty, 1);
    assert.equal(body.counts.missingBaseline, 1);
    assert.equal(body.counts.errored, 0);
  });

  t('export：同名多副本共存的包，条目唯一且内容不丢', async () => {
    const base = await makeTempDir('host-export-dup');
    const dataDir = path.join(base, 'data');
    const rootA = path.join(base, 'rootA');
    const rootB = path.join(base, 'rootB');
    await writeText(path.join(rootA, 'dup', 'SKILL.md'), SKILL_MD('dup', '来自A'));
    await writeText(path.join(rootB, 'dup', 'SKILL.md'), SKILL_MD('dup', '来自B'));
    const policy = createPolicyStore({ dataDir });
    const store = createRevisionStore({ dataDir });
    const rootsOf = () => [
      { key: 'project-dsh', rank: 100, dir: rootA, label: '项目根', managed: true, skipSystem: false },
      { key: 'user-dsh', rank: 400, dir: rootB, label: '用户根', managed: true, skipSystem: true },
    ];
    const handlers = createHandlers({ dataDir, policy, store, rootsOf });

    const response = await handlers.export(
      new Request(`http://127.0.0.1:43120${ROUTES.export}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [
            { sourceKey: 'project-dsh', name: 'dup' },
            { sourceKey: 'user-dsh', name: 'dup' },
          ],
        }),
      }),
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    const raw = readZip(buffer);
    const names = raw.entries.map((e) => e.name);
    assert.equal(new Set(names).size, names.length, `zip 条目名重复：${names.join(', ')}`);

    const pkg = await readPackage(buffer);
    assert.equal(pkg.problems.length, 0, JSON.stringify(pkg.problems));
    assert.equal(pkg.skills.length, 2);
    const texts = pkg.skills.map((s) => s.files.find((f) => f.path === 'SKILL.md').data.toString('utf8'));
    assert.ok(texts.some((t) => /来自A/.test(t)));
    assert.ok(texts.some((t) => /来自B/.test(t)));
  });

  t('找不到技能时返回 404', async () => {
    const { handlers, get, post } = await setupHost('host-404');
    assert.equal((await handlers.detail(get(ROUTES.detail, '?sourceKey=user-dsh&name=ghost'))).status, 200);
    assert.equal((await handlers.capture(post(ROUTES.capture, { sourceKey: 'user-dsh', name: 'ghost' }))).status, 404);
    assert.equal((await handlers.restore(post(ROUTES.restore, { sourceKey: 'user-dsh', name: 'ghost', revisionId: 'x' }))).status, 404);
    assert.equal((await handlers.export(post(ROUTES.export, { items: [{ sourceKey: 'user-dsh', name: 'ghost' }] }))).status, 404);
  });

  t('覆盖 provider：源文件消失时安全跳过并记录告警', async () => {
    const base = await makeTempDir('host-overlay-missing');
    const policy = createPolicyStore({ dataDir: path.join(base, 'data') });
    await policy.setPolicy('user-dsh', 'ghost', 'disabled', { path: path.join(base, 'nope', 'SKILL.md') });
    const provider = createOverlayProvider({ policy, logger: { warn: () => {} } });
    assert.deepEqual(await provider.list(), []);
    const info = await provider.inspect();
    assert.equal(info.active.length, 1);
    assert.equal(info.active[0].ok, false);
    assert.ok(info.warnings.length >= 1, '应记录"源文件不存在"的告警');
  });

  /* ---------------- 分组与排序 ---------------- */

  t('registerRoutes：ROUTES 里的每条路径都真的被注册了', async () => {
    /*
     * 这条用例的存在理由：曾经给 ROUTES 加了 layout、给 createHandlers 加了 handler，
     * 却漏了 registerRoutes 里那张表。所有测试都直接调 handlers.layout，因此全绿；
     * 而真实宿主按表注册，那条路由根本不存在，界面上表现为永远 HTTP 404。
     * 断言"表 ⊇ ROUTES"才能在离线阶段抓住这种错位。
     */
    const registered = [];
    const fakeCtx = {
      connection: {
        fetch: {
          register(entry) {
            registered.push({ path: entry.path, methods: entry.methods });
            return () => {};
          },
        },
      },
      logger: { error: () => {}, warn: () => {} },
    };
    const { registerRoutes } = await import('../lib/routes.js');
    const base = await makeTempDir('routes-table');
    registerRoutes(fakeCtx, {
      dataDir: base,
      policy: createPolicyStore({ dataDir: path.join(base, 'policy') }),
      store: createRevisionStore({ dataDir: path.join(base, 'store') }),
      rootsOf: () => [],
    });

    const expected = Object.values(ROUTES).sort();
    const actual = registered.map((r) => r.path).sort();
    assert.deepEqual(actual, expected, `注册表与 ROUTES 不一致\n注册：${actual.join(', ')}\n应为：${expected.join(', ')}`);

    for (const entry of registered) {
      assert.ok(Array.isArray(entry.methods) && entry.methods.length > 0, `${entry.path} 没有声明方法`);
      for (const method of entry.methods) {
        assert.ok(['GET', 'POST'].includes(method), `${entry.path} 出现意外方法 ${method}`);
      }
    }
  });

  t('registerRoutes：layout 同时接受 GET 与 POST', async () => {
    const registered = [];
    const fakeCtx = {
      connection: { fetch: { register(entry) { registered.push(entry); return () => {}; } } },
      logger: { error: () => {}, warn: () => {} },
    };
    const { registerRoutes } = await import('../lib/routes.js');
    const base = await makeTempDir('layout-methods');
    registerRoutes(fakeCtx, {
      dataDir: base,
      policy: createPolicyStore({ dataDir: path.join(base, 'p') }),
      store: createRevisionStore({ dataDir: path.join(base, 's') }),
      rootsOf: () => [],
    });
    const entry = registered.find((r) => r.path === ROUTES.layout);
    assert.ok(entry, 'layout 必须被注册');
    assert.deepEqual([...entry.methods].sort(), ['GET', 'POST']);
  });

  t('layout：list 随清单下发空布局', async () => {
    const { handlers, get } = await setupHost('host-layout-empty');
    const body = await (await handlers.list(get(ROUTES.list))).json();
    assert.deepEqual(body.layout, { version: 1, groups: [], assignments: {}, order: [] });
  });

  t('layout：GET 读、POST 写，双向一致', async () => {
    const { handlers, get, post } = await setupHost('host-layout-rw');
    const put = await handlers.layout(
      post(ROUTES.layout, {
        groups: [{ name: '工具类' }, { name: '流程类' }],
        assignments: { 'user-dsh::alpha': null },
        order: ['user-dsh::beta', 'user-dsh::alpha'],
      }),
    );
    assert.equal(put.status, 200);
    const saved = (await put.json()).layout;
    assert.deepEqual(saved.groups.map((g) => g.name), ['工具类', '流程类']);
    assert.deepEqual(saved.order, ['user-dsh::beta', 'user-dsh::alpha']);

    const read = await (await handlers.layout(get(ROUTES.layout))).json();
    assert.deepEqual(read.layout, saved);

    // list 也要带上同一份布局，界面才能一次请求画完
    const listed = await (await handlers.list(get(ROUTES.list))).json();
    assert.deepEqual(listed.layout, saved);
  });

  t('layout：技能→分组归属可写入并读回', async () => {
    const { handlers, get, post } = await setupHost('host-layout-assign');
    const first = (await (await handlers.layout(post(ROUTES.layout, { groups: [{ name: 'G' }] }))).json()).layout;
    const gid = first.groups[0].id;
    const res = await handlers.layout(post(ROUTES.layout, { assignments: { 'user-dsh::alpha': gid } }));
    assert.equal(res.status, 200);
    const layout = (await res.json()).layout;
    assert.deepEqual(layout.assignments, { 'user-dsh::alpha': gid });
  });

  t('layout：拒绝非法请求体', async () => {
    const { handlers, post } = await setupHost('host-layout-bad');
    const cases = [
      post(ROUTES.layout, {}),
      post(ROUTES.layout, { groups: 'nope' }),
      post(ROUTES.layout, { groups: [{ name: '  ' }] }),
      post(ROUTES.layout, { groups: [{ id: 'not-prefixed', name: 'x' }] }),
      post(ROUTES.layout, { groups: [{ id: 'g_a', name: 'x' }], assignments: { 'user-dsh::alpha': 'g_zzz' } }),
      post(ROUTES.layout, { order: 'nope' }),
    ];
    for (const request of cases) {
      const res = await handlers.layout(request);
      assert.equal(res.status, 400, `应拒绝：${await res.clone().text()}`);
    }
  });

  t('layout：不存在的技能不会被写进排序（清单为准）', async () => {
    const { handlers, post } = await setupHost('host-layout-ghost');
    const res = await handlers.layout(
      post(ROUTES.layout, { order: ['user-dsh::alpha', 'user-dsh::ghost', 'user-dsh::beta'] }),
    );
    const layout = (await res.json()).layout;
    assert.deepEqual(layout.order, ['user-dsh::alpha', 'user-dsh::beta']);
  });

  t('layout：改排序不影响策略，改策略不影响排序', async () => {
    const { handlers, get, post } = await setupHost('host-layout-isolation');
    await handlers.policy(post(ROUTES.policy, { sourceKey: 'user-dsh', name: 'alpha', policy: 'disabled' }));
    await handlers.layout(post(ROUTES.layout, { order: ['user-dsh::beta', 'user-dsh::alpha'] }));

    let body = await (await handlers.list(get(ROUTES.list))).json();
    assert.equal(body.skills.find((s) => s.name === 'alpha').policyId, 'disabled', '策略仍在');
    assert.deepEqual(body.layout.order, ['user-dsh::beta', 'user-dsh::alpha'], '排序仍在');

    await handlers.policy(post(ROUTES.policy, { sourceKey: 'user-dsh', name: 'alpha', policy: 'follow' }));
    body = await (await handlers.list(get(ROUTES.list))).json();
    assert.equal(body.skills.find((s) => s.name === 'alpha').policyId, 'follow');
    assert.deepEqual(body.layout.order, ['user-dsh::beta', 'user-dsh::alpha'], '排序没被策略操作清掉');
  });
}
