import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRevisionStore } from '../lib/core/revisions.js';
import { buildManifest, compareManifests } from '../lib/core/hash.js';
import { makeTempDir, writeText, pathExists } from './helpers.js';

async function setup(label) {
  const base = await makeTempDir(label);
  const dataDir = path.join(base, 'data');
  const rootDir = path.join(base, 'skills');
  const skillDir = path.join(rootDir, 'demo');
  await writeText(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: 原始\n---\n\n第一行\n第二行\n');
  await writeText(path.join(skillDir, 'references', 'a.md'), 'A 内容\n');
  const store = createRevisionStore({ dataDir });
  return { base, dataDir, rootDir, skillDir, store };
}

export default function register(t) {
  t('捕获 → 幂等 → 变更产生新修订', async () => {
    const { skillDir, store } = await setup('rev-basic');
    const first = await store.capture({ sourceKey: 'user-dsh', name: 'demo', target: skillDir });
    assert.equal(first.created, true);
    assert.equal(first.entry.fileCount, 2);
    assert.ok(first.entry.contentHash.length === 64);

    const again = await store.capture({ sourceKey: 'user-dsh', name: 'demo', target: skillDir });
    assert.equal(again.created, false, '内容未变不应产生新修订');
    assert.equal((await store.list('user-dsh', 'demo')).length, 1);

    await writeText(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: 改过\n---\n\n第一行\n第二行改\n');
    const third = await store.capture({ sourceKey: 'user-dsh', name: 'demo', target: skillDir, note: '改了正文' });
    assert.equal(third.created, true);
    const timeline = await store.list('user-dsh', 'demo');
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].note, '改了正文');
    assert.notEqual(timeline[0].contentHash, timeline[1].contentHash);
  });

  t('对象库按内容去重', async () => {
    const { skillDir, store } = await setup('rev-dedupe');
    await store.capture({ sourceKey: 's', name: 'demo', target: skillDir });
    const before = await store.stats();
    assert.equal(before.objectCount, 2);
    // 只改 SKILL.md，references/a.md 内容不变 → 只多存一个对象
    await writeText(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: 新\n---\n\n内容\n');
    await store.capture({ sourceKey: 's', name: 'demo', target: skillDir });
    const after = await store.stats();
    assert.equal(after.objectCount, 3, '未变文件不应重复入库');
  });

  t('逐文件差异与行级 diff', async () => {
    const { skillDir, store } = await setup('rev-diff');
    const r1 = await store.capture({ sourceKey: 's', name: 'demo', target: skillDir });
    await writeText(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: 原始\n---\n\n第一行\n第二行被改\n新增行\n');
    await fs.rm(path.join(skillDir, 'references', 'a.md'));
    await writeText(path.join(skillDir, 'references', 'b.md'), 'B 内容\n');
    const r2 = await store.capture({ sourceKey: 's', name: 'demo', target: skillDir });

    const cmp = await store.compare('s', 'demo', r1.entry.contentHash, r2.entry.contentHash);
    assert.equal(cmp.changed.length, 1);
    assert.equal(cmp.changed[0].path, 'SKILL.md');
    assert.deepEqual(cmp.removed.map((f) => f.path), ['references/a.md']);
    assert.deepEqual(cmp.added.map((f) => f.path), ['references/b.md']);

    const fd = await store.fileDiff('s', 'demo', r1.entry.contentHash, r2.entry.contentHash, 'SKILL.md');
    assert.equal(fd.status, 'changed');
    assert.match(fd.diff.text, /^--- a\/SKILL\.md/m);
    assert.match(fd.diff.text, /\+新增行/);
    assert.match(fd.diff.text, /-第二行/);

    const removed = await store.fileDiff('s', 'demo', r1.entry.contentHash, r2.entry.contentHash, 'references/a.md');
    assert.equal(removed.status, 'removed');
  });

  t('回滚恢复字节一致，且回滚本身可逆', async () => {
    const { skillDir, store } = await setup('rev-restore');
    const original = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
    const r1 = await store.capture({ sourceKey: 's', name: 'demo', target: skillDir });

    await writeText(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: 破坏\n---\n\n垃圾\n');
    await writeText(path.join(skillDir, 'junk.txt'), '不该存在');
    const r2 = await store.capture({ sourceKey: 's', name: 'demo', target: skillDir });

    const result = await store.restore({ sourceKey: 's', name: 'demo', id: r1.entry.contentHash, target: skillDir });
    assert.equal(result.restored, true);
    assert.ok(result.backupRevision, '回滚前应存在可回退的快照');
    assert.equal(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'), original);
    assert.equal(await pathExists(path.join(skillDir, 'junk.txt')), false, '回滚应清掉快照里没有的文件');
    // 破坏版此前已被捕获，因此这次回滚不必再产生重复快照：时间线仍是 2 条，头部指向破坏版
    // → 回滚本身可逆（随时能再回到破坏版）
    const timeline = await store.list('s', 'demo');
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].contentHash, r2.entry.contentHash);

    // 磁盘上有"未捕获的改动"时，回滚会先自动备份
    await writeText(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: 未提交\n---\n\n???\n');
    const back = await store.restore({ sourceKey: 's', name: 'demo', id: r2.entry.contentHash, target: skillDir });
    assert.ok(back.backupRevision, '未捕获的改动必须被备份');
    assert.equal((await store.list('s', 'demo')).length, 3);
    assert.match(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'), /description: 破坏/);

    // 回滚到 r1 后重新捕获，内容与 r1 相同 → 幂等（内容寻址）
    await store.restore({ sourceKey: 's', name: 'demo', id: r1.entry.contentHash, target: skillDir });
    const after = await buildManifest(skillDir);
    assert.equal(after.sha256, r1.entry.contentHash);
  });

  t('平铺 .md 技能也能版本跟踪与回滚', async () => {
    const base = await makeTempDir('rev-flat');
    const flat = path.join(base, 'flat.md');
    await writeText(flat, '---\nname: flat\ndescription: 平铺\n---\n\n甲\n');
    const store = createRevisionStore({ dataDir: path.join(base, 'data') });
    const r1 = await store.capture({ sourceKey: 's', name: 'flat', target: flat });
    assert.equal(r1.entry.fileCount, 1);
    await writeText(flat, '---\nname: flat\ndescription: 平铺\n---\n\n乙\n');
    const r2 = await store.capture({ sourceKey: 's', name: 'flat', target: flat });
    assert.equal(r2.created, true);
    await store.restore({ sourceKey: 's', name: 'flat', id: r1.entry.contentHash, target: flat });
    assert.match(await fs.readFile(flat, 'utf8'), /甲/);
  });

  t('prune：只删无引用对象，且默认 dry-run', async () => {
    const { skillDir, dataDir, store } = await setup('rev-prune');
    await store.capture({ sourceKey: 's', name: 'demo', target: skillDir });
    const stray = path.join(dataDir, 'objects', 'ff', 'f'.repeat(64));
    await writeText(stray, '孤儿对象');

    const dry = await store.prune({ dryRun: true });
    assert.equal(dry.unreferenced, 1);
    assert.equal(await pathExists(stray), true, 'dry-run 不应删除');

    const real = await store.prune({ dryRun: false });
    assert.equal(real.removed, 1);
    assert.equal(await pathExists(stray), false);
    assert.equal((await store.stats()).objectCount, 2);
  });

  t('安全：修订里带逃逸路径时拒绝回滚', async () => {
    const { skillDir, dataDir, store } = await setup('rev-evil');
    await store.capture({ sourceKey: 's', name: 'demo', target: skillDir });
    const evilId = 'e'.repeat(64);
    const evilManifest = {
      schema: 'dsh-skill-bundle-1',
      sha256: evilId,
      totalBytes: 4,
      files: [{ path: '../evil.txt', bytes: 4, sha256: 'a'.repeat(64) }],
    };
    await writeText(path.join(dataDir, 'revisions', 's', 'demo', `${evilId}.json`), JSON.stringify(evilManifest));
    await assert.rejects(
      () => store.restore({ sourceKey: 's', name: 'demo', id: evilId, target: skillDir }),
      /路径不安全|路径逃逸/,
    );
    assert.equal(await pathExists(path.join(path.dirname(skillDir), 'evil.txt')), false);
  });

  t('hash：manifest 摘要只由内容决定', async () => {
    const base = await makeTempDir('rev-hash');
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    await writeText(path.join(a, 'SKILL.md'), '同样内容\n');
    await writeText(path.join(b, 'SKILL.md'), '同样内容\n');
    const ma = await buildManifest(a);
    const mb = await buildManifest(b);
    assert.equal(ma.sha256, mb.sha256, '路径不同不应影响摘要');
    await writeText(path.join(b, 'SKILL.md'), '不同内容\n');
    const mc = await buildManifest(b);
    assert.notEqual(ma.sha256, mc.sha256);
    const cmp = compareManifests(ma, mc);
    assert.equal(cmp.identical, false);
    assert.equal(cmp.changed.length, 1);
  });
}
