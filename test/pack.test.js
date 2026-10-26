import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  exportFromDisk,
  exportFromRevision,
  mergePackages,
  readPackage,
  planImport,
  applyImport,
  scaffoldSkill,
  validatePackedSkill,
  PACKAGE_MANIFEST,
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
} from '../lib/core/pack.js';
import { createZip, readZip } from '../lib/core/zip.js';
import { sha256Hex } from '../lib/core/hash.js';
import { createRevisionStore } from '../lib/core/revisions.js';
import { parseSkillDocument } from '../lib/core/frontmatter.js';
import { makeTempDir, writeText, pathExists } from './helpers.js';

const SKILL_MD = (name, desc = '说明') => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n正文内容\n`;

async function makeSkill(rootDir, name, extra = {}) {
  const dir = path.join(rootDir, name);
  await writeText(path.join(dir, 'SKILL.md'), SKILL_MD(name));
  for (const [rel, content] of Object.entries(extra)) {
    await writeText(path.join(dir, ...rel.split('/')), content);
  }
  return dir;
}

export default function register(t) {
  t('导出 → 读取 → 完整性校验通过（含中文文件名）', async () => {
    const base = await makeTempDir('pack-export');
    const dir = await makeSkill(base, 'demo-skill', {
      'references/线框DSL规范V0.1.md': '中文文件名内容\n',
      'references/note.md': 'note\n',
      'assets/logo.svg': '<svg/>',
    });
    const { buffer, manifest } = await exportFromDisk({
      skills: [{ name: 'demo-skill', dir, sourceKey: 'user-dsh', description: '说明', policyId: 'enabled' }],
    });
    assert.ok(buffer.length > 0);
    assert.equal(manifest.format, PACKAGE_FORMAT);
    assert.equal(manifest.formatVersion, PACKAGE_FORMAT_VERSION);
    assert.equal(manifest.skills[0].files.length, 4);

    const pkg = await readPackage(buffer);
    assert.equal(pkg.ok, true);
    assert.equal(pkg.problems.length, 0, `不应有问题：${JSON.stringify(pkg.problems)}`);
    assert.equal(pkg.skills.length, 1);
    assert.equal(pkg.skills[0].name, 'demo-skill');
    assert.equal(pkg.skills[0].problems.length, 0, JSON.stringify(pkg.skills[0].problems));
    const names = pkg.skills[0].files.map((f) => f.path).sort();
    assert.deepEqual(names, ['SKILL.md', 'assets/logo.svg', 'references/note.md', 'references/线框DSL规范V0.1.md']);
    const chinese = pkg.skills[0].files.find((f) => f.path.includes('线框'));
    assert.equal(chinese.data.toString('utf8'), '中文文件名内容\n');
  });

  t('篡改文件内容 → 清单校验失败', async () => {
    const manifest = {
      format: PACKAGE_FORMAT,
      formatVersion: PACKAGE_FORMAT_VERSION,
      exportedAt: new Date(0).toISOString(),
      generator: { name: 'test', version: '0' },
      skills: [
        {
          name: 'evil',
          files: [{ path: 'SKILL.md', bytes: 10, sha256: '0'.repeat(64) }],
          totalBytes: 10,
        },
      ],
    };
    const buffer = createZip([
      { name: PACKAGE_MANIFEST, data: JSON.stringify(manifest) },
      { name: 'evil/SKILL.md', data: SKILL_MD('evil') },
    ]);
    const pkg = await readPackage(buffer);
    assert.equal(pkg.skills.length, 1);
    assert.ok(pkg.skills[0].problems.some((p) => p.code === 'hash-mismatch'), JSON.stringify(pkg.skills[0].problems));
  });

  t('裸包（无清单）仍可识别并标注未验证', async () => {
    const buffer = createZip([
      { name: 'bare/SKILL.md', data: SKILL_MD('bare') },
      { name: 'bare/references/x.md', data: 'x' },
    ]);
    const pkg = await readPackage(buffer);
    assert.equal(pkg.manifest, null);
    assert.equal(pkg.skills.length, 1);
    assert.equal(pkg.skills[0].name, 'bare');
    assert.ok(pkg.skills[0].problems.some((p) => p.code === 'no-manifest'));
    assert.equal(validatePackedSkill(pkg.skills[0]).ok, true);
  });

  t('裸包：根目录单个 SKILL.md', async () => {
    const buffer = createZip([{ name: 'SKILL.md', data: SKILL_MD('rooted') }]);
    const pkg = await readPackage(buffer);
    assert.equal(pkg.skills.length, 1);
    assert.equal(pkg.skills[0].name, 'rooted');
  });

  t('危险路径条目被拒绝（写入侧或读取侧）', async () => {
    let buffer;
    try {
      buffer = createZip([{ name: '../evil.md', data: 'x' }]);
    } catch {
      return; // 写入侧已拒绝，符合预期
    }
    const pkg = await readPackage(buffer);
    const flagged = pkg.problems.some((p) => p.code === 'unsafe-path') || pkg.skills.length === 0;
    assert.equal(flagged, true, JSON.stringify(pkg));
  });

  t('导入规划：create / overwrite / rename / skip / invalid', async () => {
    const base = await makeTempDir('pack-plan');
    const dir = await makeSkill(base, 'dup-skill');
    const { buffer } = await exportFromDisk({ skills: [{ name: 'dup-skill', dir }] });
    const pkg = await readPackage(buffer);

    const fresh = planImport({ skills: pkg.skills, existing: [], strategy: 'keep-both' });
    assert.equal(fresh.summary.create, 1);

    const clash = planImport({ skills: pkg.skills, existing: [{ name: 'dup-skill', dir }], strategy: 'keep-both' });
    assert.equal(clash.actions[0].kind, 'rename');
    assert.equal(clash.actions[0].to, 'dup-skill-2');

    const over = planImport({ skills: pkg.skills, existing: [{ name: 'dup-skill', dir }], strategy: 'overwrite' });
    assert.equal(over.actions[0].kind, 'overwrite');

    const skip = planImport({ skills: pkg.skills, existing: [{ name: 'dup-skill', dir }], strategy: 'skip' });
    assert.equal(skip.actions[0].kind, 'skip');

    // 非法技能（frontmatter 有 camelCase 旧键）→ invalid
    const badBuffer = createZip([
      { name: 'bad/SKILL.md', data: '---\nname: bad\ndescription: x\nuserInvocable: false\n---\n' },
    ]);
    const badPkg = await readPackage(badBuffer);
    const badPlan = planImport({ skills: badPkg.skills, existing: [], strategy: 'keep-both' });
    assert.equal(badPlan.summary.invalid, 1);
  });

  t('落盘导入：暂存 + 原子替换，导入后 frontmatter 可解析', async () => {
    const base = await makeTempDir('pack-apply');
    const src = await makeSkill(base, 'importable', { 'references/a.md': 'A\n' });
    const { buffer } = await exportFromDisk({ skills: [{ name: 'importable', dir: src }] });
    const pkg = await readPackage(buffer);
    const targetRoot = path.join(base, 'target');
    const plan = planImport({ skills: pkg.skills, existing: [], strategy: 'keep-both' });
    const result = await applyImport({ pkg, plan, targetDir: targetRoot });
    assert.equal(result.written.length, 1);
    const parsed = parseSkillDocument(await fs.readFile(path.join(targetRoot, 'importable', 'SKILL.md'), 'utf8'));
    assert.equal(parsed.ok, true);

    // 再导一次 → 冲突 → rename 成 importable-2
    const plan2 = planImport({
      skills: pkg.skills,
      existing: [{ name: 'importable', dir: path.join(targetRoot, 'importable') }],
      strategy: 'keep-both',
    });
    const result2 = await applyImport({ pkg, plan: plan2, targetDir: targetRoot });
    assert.equal(path.basename(result2.written[0].dest), 'importable-2');
    assert.equal(await pathExists(path.join(targetRoot, 'importable-2', 'references', 'a.md')), true);

    // overwrite 路径要能替换且不残留旧文件
    await writeText(path.join(targetRoot, 'importable', 'stale.txt'), '旧文件');
    const plan3 = planImport({ skills: pkg.skills, existing: [{ name: 'importable', dir: '' }], strategy: 'overwrite' });
    await applyImport({ pkg, plan: plan3, targetDir: targetRoot });
    assert.equal(await pathExists(path.join(targetRoot, 'importable', 'stale.txt')), false);
    assert.equal(await pathExists(path.join(targetRoot, 'importable', 'SKILL.md')), true);
  });

  t('导出历史修订（不影响磁盘当前内容）', async () => {
    const base = await makeTempDir('pack-revision');
    const dir = await makeSkill(base, 'versioned');
    const dataDir = path.join(base, 'data');
    const store = createRevisionStore({ dataDir });
    const r1 = await store.capture({ sourceKey: 'user-dsh', name: 'versioned', target: dir });
    const oldContent = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
    await writeText(path.join(dir, 'SKILL.md'), SKILL_MD('versioned', '第二版说明'));

    const { buffer, manifest } = await exportFromRevision({
      store,
      sourceKey: 'user-dsh',
      name: 'versioned',
      revisionId: r1.entry.contentHash,
      meta: { description: '说明' },
    });
    assert.equal(manifest.skills[0].revisionId, r1.entry.contentHash);
    const pkg = await readPackage(buffer);
    assert.equal(pkg.problems.length, 0);
    const exported = pkg.skills[0].files.find((f) => f.path === 'SKILL.md').data.toString('utf8');
    assert.equal(exported, oldContent);
    // 磁盘没被改动
    assert.match(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'), /第二版说明/);
  });

  t('脚手架生成新技能并拒绝重名/非法名', async () => {
    const base = await makeTempDir('pack-scaffold');
    const targetRoot = path.join(base, 'skills');
    const created = await scaffoldSkill(targetRoot, {
      name: 'brand-new',
      description: '新建技能',
      whenToUse: '当需要新建时',
      policyId: 'modelOnly',
      body: '# New\n\n内容',
    });
    const parsed = parseSkillDocument(await fs.readFile(created.path, 'utf8'));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.skill.policyId, 'modelOnly');
    await assert.rejects(
      () => scaffoldSkill(targetRoot, { name: 'brand-new', description: '重复' }),
      /已存在/,
    );
    await assert.rejects(() => scaffoldSkill(targetRoot, { name: 'Bad Name', description: 'x' }), /kebab-case/);
    await assert.rejects(() => scaffoldSkill(targetRoot, { name: 'ok-name', description: '' }), /description/);
  });

  t('同名两副本导出：条目名唯一，读回与导入都不丢内容', async () => {
    const base = await makeTempDir('pack-dup');
    const rootA = path.join(base, 'rootA');
    const rootB = path.join(base, 'rootB');
    const dirA = path.join(rootA, 'dup');
    const dirB = path.join(rootB, 'dup');
    // 同一技能名、两个来源、内容不同 —— 这正是本插件会显式展示的 shadowed 场景
    await writeText(path.join(dirA, 'SKILL.md'), SKILL_MD('dup', '来自A'));
    await writeText(path.join(dirA, 'references', 'a.md'), 'A 的引用\n');
    await writeText(path.join(dirB, 'SKILL.md'), SKILL_MD('dup', '来自B'));

    const { buffer, manifest } = await exportFromDisk({
      skills: [
        { name: 'dup', kind: 'bundle', dir: dirA, path: path.join(dirA, 'SKILL.md'), sourceKey: 'project-dsh' },
        { name: 'dup', kind: 'bundle', dir: dirB, path: path.join(dirB, 'SKILL.md'), sourceKey: 'user-dsh' },
      ],
    });

    // 顶层目录必须唯一；第二个副本带来源后缀
    const roots = manifest.skills.map((s) => s.entryRoot);
    assert.equal(new Set(roots).size, 2, `entryRoot 必须唯一：${roots.join(',')}`);
    assert.deepEqual(roots, ['dup', 'dup--user-dsh']);

    // zip 条目名必须唯一（否则第三方解压会静默覆盖）
    const raw = readZip(buffer);
    const names = raw.entries.map((e) => e.name);
    assert.equal(new Set(names).size, names.length, `zip 条目名重复：${names.join(', ')}`);
    assert.ok(names.includes('dup/SKILL.md'));
    assert.ok(names.includes('dup--user-dsh/SKILL.md'));

    // 读回：两条记录、内容各自独立
    const pkg = await readPackage(buffer);
    assert.equal(pkg.problems.length, 0, JSON.stringify(pkg.problems));
    assert.equal(pkg.skills.length, 2);
    const bySource = Object.fromEntries(pkg.skills.map((s) => [s.sourceKey, s]));
    assert.match(bySource['project-dsh'].files.find((f) => f.path === 'SKILL.md').data.toString('utf8'), /来自A/);
    assert.match(bySource['user-dsh'].files.find((f) => f.path === 'SKILL.md').data.toString('utf8'), /来自B/);
    assert.equal(pkg.skills.every((s) => s.problems.length === 0), true, JSON.stringify(pkg.skills.map((s) => s.problems)));

    // 导入：重名 → dup / dup-2，两份内容各自正确（修复前 A 会丢）
    const targetDir = path.join(base, 'target');
    const plan = planImport({ skills: pkg.skills, existing: [], strategy: 'keep-both' });
    assert.deepEqual(plan.actions.map((a) => a.to ?? a.name), ['dup', 'dup-2']);
    await applyImport({ pkg, plan, targetDir });
    assert.match(await fs.readFile(path.join(targetDir, 'dup', 'SKILL.md'), 'utf8'), /来自A/);
    assert.match(await fs.readFile(path.join(targetDir, 'dup-2', 'SKILL.md'), 'utf8'), /来自B/);
    assert.equal(await pathExists(path.join(targetDir, 'dup', 'references', 'a.md')), true);

    // 再往返一次：导出 → 读回，内容仍然完整（幂等）
    const again = await exportFromDisk({
      skills: [
        { name: 'dup', kind: 'bundle', dir: path.join(targetDir, 'dup'), path: path.join(targetDir, 'dup', 'SKILL.md'), sourceKey: 'project-dsh' },
        { name: 'dup', kind: 'bundle', dir: path.join(targetDir, 'dup-2'), path: path.join(targetDir, 'dup-2', 'SKILL.md'), sourceKey: 'user-dsh' },
      ],
    });
    const pkgAgain = await readPackage(again.buffer);
    assert.equal(pkgAgain.skills.length, 2);
    assert.equal(pkgAgain.skills.every((s) => s.problems.length === 0), true);
  });

  t('合并导出：磁盘现状 + 历史修订中的同名副本不冲突', async () => {
    const base = await makeTempDir('pack-merge-dup');
    const dataDir = path.join(base, 'data');
    const store = createRevisionStore({ dataDir });
    const dirA = path.join(base, 'rootA', 'dup');
    await writeText(path.join(dirA, 'SKILL.md'), SKILL_MD('dup', '修订A1'));
    const revision = await store.capture({ sourceKey: 'user-dsh', name: 'dup', target: dirA });
    // 磁盘改成 A2，历史修订里仍是 A1
    await writeText(path.join(dirA, 'SKILL.md'), SKILL_MD('dup', '磁盘A2'));
    const dirB = path.join(base, 'rootB', 'dup');
    await writeText(path.join(dirB, 'SKILL.md'), SKILL_MD('dup', '来自B'));

    const livePart = await exportFromDisk({
      skills: [{ name: 'dup', kind: 'bundle', dir: dirB, path: path.join(dirB, 'SKILL.md'), sourceKey: 'project-dsh' }],
    });
    const revisionPart = await exportFromRevision({
      store,
      sourceKey: 'user-dsh',
      name: 'dup',
      revisionId: revision.entry.contentHash,
    });
    const merged = mergePackages([livePart, revisionPart]);

    const raw = readZip(merged.buffer);
    const names = raw.entries.map((e) => e.name);
    assert.equal(new Set(names).size, names.length, `合并包条目名重复：${names.join(', ')}`);
    const pkg = await readPackage(merged.buffer);
    assert.equal(pkg.problems.length, 0, JSON.stringify(pkg.problems));
    assert.equal(pkg.skills.length, 2);
    const texts = pkg.skills.map((s) => s.files.find((f) => f.path === 'SKILL.md').data.toString('utf8'));
    assert.ok(texts.some((t) => /修订A1/.test(t)), '历史修订内容应保留');
    assert.ok(texts.some((t) => /来自B/.test(t)), '磁盘现状内容应保留');
    assert.equal(texts.some((t) => /磁盘A2/.test(t)), false, '历史修订导出不应带出磁盘当前版本');
  });

  t('createZip 拒绝重复条目名（防解压静默覆盖）', () => {
    assert.throws(
      () =>
        createZip([
          { name: 'dup/SKILL.md', data: 'A' },
          { name: 'dup/SKILL.md', data: 'B' },
        ]),
      /条目名重复/,
    );
  });

  t('旧格式包（清单无 entryRoot）仍可读', async () => {
    const text = SKILL_MD('legacy', '旧包');
    const manifest = {
      format: PACKAGE_FORMAT,
      formatVersion: PACKAGE_FORMAT_VERSION,
      exportedAt: new Date(0).toISOString(),
      generator: { name: 'test', version: '0' },
      skills: [
        {
          name: 'legacy',
          files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(text), sha256: sha256Hex(text) }],
          totalBytes: Buffer.byteLength(text),
        },
      ],
    };
    const buffer = createZip([
      { name: PACKAGE_MANIFEST, data: JSON.stringify(manifest) },
      { name: 'legacy/SKILL.md', data: text },
    ]);
    const pkg = await readPackage(buffer);
    assert.equal(pkg.problems.length, 0, JSON.stringify(pkg.problems));
    assert.equal(pkg.skills.length, 1);
    assert.equal(pkg.skills[0].name, 'legacy');
    assert.equal(pkg.skills[0].entryRoot, 'legacy');
    assert.equal(pkg.skills[0].problems.length, 0);
    assert.equal(validatePackedSkill(pkg.skills[0]).ok, true);
  });

  t('清单里 entryRoot 重复 → 报 problem 且不重复计算技能', async () => {
    const text = SKILL_MD('dup');
    const stable = {
      path: 'SKILL.md',
      bytes: Buffer.byteLength(text),
      sha256: sha256Hex(text),
    };
    const manifest = {
      format: PACKAGE_FORMAT,
      formatVersion: PACKAGE_FORMAT_VERSION,
      exportedAt: new Date(0).toISOString(),
      generator: { name: 'test', version: '0' },
      skills: [
        { name: 'dup', entryRoot: 'dup', files: [stable], totalBytes: stable.bytes },
        { name: 'dup', entryRoot: 'dup', files: [stable], totalBytes: stable.bytes },
      ],
    };
    const buffer = createZip([
      { name: PACKAGE_MANIFEST, data: JSON.stringify(manifest) },
      { name: 'dup/SKILL.md', data: text },
    ]);
    const pkg = await readPackage(buffer);
    assert.equal(pkg.skills.length, 1, '同一 entryRoot 只应算一个技能');
    assert.ok(pkg.problems.some((p) => p.code === 'duplicate-entry-root'), JSON.stringify(pkg.problems));
  });

  t('真实技能库：整库导出再读回，全部通过完整性校验', async () => {
    const { dshHome } = await import('./helpers.js');
    const dir = path.join(dshHome(), 'skills', 'grilling');
    const { buffer } = await exportFromDisk({
      skills: [{ name: 'grilling', dir, sourceKey: 'user-dsh', description: 'grilling' }],
    });
    const pkg = await readPackage(buffer);
    assert.equal(pkg.problems.length, 0);
    assert.equal(pkg.skills[0].problems.length, 0);
    const raw = readZip(buffer);
    assert.ok(raw.entries.some((e) => e.name === PACKAGE_MANIFEST));
    assert.ok(raw.entries.some((e) => e.name === 'grilling/SKILL.md'));
  });
}
