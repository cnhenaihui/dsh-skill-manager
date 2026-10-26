import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { managedRoots, importSources, RANK, resolveProjectRoot } from '../lib/core/roots.js';
import { inventory, groupByName, listBundleFiles } from '../lib/core/scan.js';
import { makeTempDir, dshHome, writeText, pathExists } from './helpers.js';

const SKILL_OK = (name, extra = '') => `---\nname: ${name}\ndescription: ${name} 的说明\n${extra}---\n\n# ${name}\n`;

export default function register(t) {
  t('根表与官方 rank 一致', async () => {
    const roots = managedRoots({ cwd: process.cwd(), dshHome: 'C:/fake/.dsh', agentsHome: 'C:/fake/.agents' });
    const byKey = Object.fromEntries(roots.map((r) => [r.key, r]));
    assert.equal(byKey['user-dsh'].rank, RANK.USER_DSH);
    assert.equal(byKey['user-dsh'].skipSystem, true);
    assert.equal(byKey['project-dsh'].rank, RANK.PROJECT_DSH);
    assert.equal(byKey['project-agents'].rank, RANK.PROJECT_AGENTS);
    assert.equal(byKey['user-agents'].rank, RANK.USER_AGENTS);
    assert.equal(byKey['user-dsh'].dir, path.join('C:/fake/.dsh', 'skills'));
  });

  t('项目根回退到 cwd（无 .git 时）', async () => {
    const dir = await makeTempDir('proj');
    const root = resolveProjectRoot(dir);
    assert.equal(root, path.resolve(dir));
  });

  t('扫描形状只有一层，且跳过 .system', async () => {
    const rootDir = await makeTempDir('scanroot');
    await writeText(path.join(rootDir, 'alpha', 'SKILL.md'), SKILL_OK('alpha'));
    await writeText(path.join(rootDir, 'flat.md'), SKILL_OK('flat'));
    await writeText(path.join(rootDir, 'deep', 'beta', 'SKILL.md'), SKILL_OK('beta'));
    await writeText(path.join(rootDir, '.system', 'sys', 'SKILL.md'), SKILL_OK('sys'));
    await writeText(path.join(rootDir, 'notaskill', 'readme.md'), 'hello');
    const root = { key: 'test', rank: 400, dir: rootDir, label: 'test', skipSystem: true, managed: true };
    const inv = await inventory({ roots: [root] });
    const names = inv.skills.map((s) => s.name).sort();
    assert.deepEqual(names, ['alpha', 'flat']);
    assert.equal(inv.invalid.length, 0);
  });

  t('非法 frontmatter 被单独列出（官方会静默丢弃）', async () => {
    const rootDir = await makeTempDir('scanbad');
    await writeText(path.join(rootDir, 'good', 'SKILL.md'), SKILL_OK('good'));
    await writeText(path.join(rootDir, 'camel', 'SKILL.md'), '---\nname: camel\ndescription: x\nuserInvocable: false\n---\n');
    await writeText(path.join(rootDir, 'nodesc', 'SKILL.md'), '---\nname: nodesc\n---\n');
    await writeText(path.join(rootDir, 'badname', 'SKILL.md'), '---\nname: BadName\ndescription: x\n---\n');
    const root = { key: 'test', rank: 400, dir: rootDir, label: 'test', skipSystem: true, managed: true };
    const inv = await inventory({ roots: [root] });
    assert.deepEqual(inv.skills.map((s) => s.name), ['good']);
    const codes = inv.invalid.map((i) => `${i.code}`).sort();
    assert.deepEqual(codes, ['invalid-name', 'legacy-invocation-key', 'missing-description']);
  });

  t('同名遮蔽检测（rank 小者胜）', async () => {
    const low = await makeTempDir('shadow-low');
    const high = await makeTempDir('shadow-high');
    await writeText(path.join(low, 'dup', 'SKILL.md'), SKILL_OK('dup'));
    await writeText(path.join(high, 'dup', 'SKILL.md'), SKILL_OK('dup'));
    const roots = [
      { key: 'high', rank: 100, dir: high, label: 'high', managed: true },
      { key: 'low', rank: 400, dir: low, label: 'low', managed: true },
    ];
    const inv = await inventory({ roots });
    const grouped = groupByName(inv.skills);
    const group = grouped.get('dup');
    assert.equal(group.length, 2);
    assert.equal(group[0].rank, 100);
    assert.equal(group[0].shadowed, false);
    assert.equal(group[1].shadowed, true);
    assert.equal(group[1].shadowedBy, group[0].path);
  });

  t('真实技能库：13 个技能全部有效且清单可读', async () => {
    const skillsDir = path.join(dshHome(), 'skills');
    const roots = managedRoots({ cwd: process.cwd(), dshHome: dshHome() });
    const inv = await inventory({ roots: roots.filter((r) => r.key === 'user-dsh') });
    assert.ok(inv.skills.length >= 13, `期望 >= 13 个技能，实际 ${inv.skills.length}`);
    assert.equal(inv.invalid.length, 0, `不应有非法条目：${JSON.stringify(inv.invalid)}`);
    const names = inv.skills.map((s) => s.name);
    for (const expected of ['baa-generator', 'grilling', 'srs-generator', 'hyperframes-cli', 'find-skills']) {
      assert.ok(names.includes(expected), `缺少 ${expected}`);
    }
    for (const skill of inv.skills) {
      assert.equal(skill.sourceKey, 'user-dsh');
      assert.equal(skill.rank, 400);
      assert.ok(skill.bytes > 0);
      assert.ok(await pathExists(path.join(skillsDir, skill.name, 'SKILL.md')));
    }
  });

  t('真实技能库：srs-generator 是带资源的多文件 bundle', async () => {
    const dir = path.join(dshHome(), 'skills', 'srs-generator');
    const listed = await listBundleFiles(dir);
    assert.ok(listed.files.length > 30, `期望 > 30 个文件，实际 ${listed.files.length}`);
    assert.ok(listed.bytes > 500_000, `期望 > 500KB，实际 ${listed.bytes}`);
    assert.ok(listed.files.some((f) => f.rel.startsWith('references/')));
    assert.ok(listed.files.some((f) => f.rel.startsWith('tools/')));
    assert.equal(listed.truncated, false);
  });

  t('其它 Agent 技能库作为只读导入来源', async () => {
    const sources = importSources();
    for (const src of sources) {
      assert.equal(src.managed, false);
      assert.equal(src.importSource, true);
    }
    // 本机实测存在 ~/.trae-cn/skills
    if (await pathExists(path.join(process.env.USERPROFILE || '', '.trae-cn', 'skills'))) {
      assert.ok(sources.some((s) => s.sourceLabel === 'trae-cn'), '应识别出 trae-cn 技能库');
    }
  });
}
