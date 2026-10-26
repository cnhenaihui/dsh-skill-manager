/**
 * scripts/acceptance-p0a.mjs —— P0a 端到端验收
 *
 * 做四件事（全部真实执行，不使用 mock）：
 *   1. 扫描本机真实技能根，打印清单（含 rank / 体积 / 文件数）；
 *   2. 把选中的真实技能导出成带清单的 zip（写到 %TEMP%，绝不碰真实技能目录）；
 *   3. 用本插件自己的 readZip 读回并校验逐文件 sha256；
 *   4. 输出 expected.json（zip 内每个文件的 sha256），供 Windows 侧
 *      `Expand-Archive` + `Get-FileHash` 做第三方交叉验证。
 *
 * 用法：
 *   node scripts/acceptance-p0a.mjs [技能名...]
 * 默认导出：srs-generator（多文件 + 中文文件名）、grilling（单文件）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { managedRoots } from '../lib/core/roots.js';
import { inventory } from '../lib/core/scan.js';
import { exportFromDisk, readPackage, PACKAGE_MANIFEST } from '../lib/core/pack.js';
import { dshHome } from '../test/helpers.js';

const OUT_DIR = path.join(os.tmpdir(), 'p0a-acceptance');
const wanted = process.argv.slice(2);
const targets = wanted.length ? wanted : ['srs-generator', 'grilling'];

function line(label, value) {
  console.log(`${label.padEnd(14)} ${value}`);
}

async function main() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const roots = managedRoots({ cwd: process.cwd(), dshHome: dshHome() });
  console.log('== 1. 扫描真实技能根 ==');
  for (const root of roots) line('根', `rank=${String(root.rank).padStart(3)} ${root.key.padEnd(15)} ${root.dir}`);

  const inv = await inventory({ roots });
  line('有效技能', inv.skills.length);
  line('非法条目', inv.invalid.length);
  for (const skill of inv.skills) {
    line('技能', `${skill.name.padEnd(36)} ${String(skill.bytes).padStart(9)}B ${String(skill.fileCount).padStart(3)}文件 rank=${skill.rank} policy=${skill.policyId}`);
  }
  for (const bad of inv.invalid) line('非法', `${bad.code} ${bad.path} ${bad.message}`);

  console.log('\n== 2. 导出选中技能 ==');
  const selected = targets.map((name) => {
    const skill = inv.skills.find((s) => s.name === name);
    if (!skill) throw new Error(`清单里没有技能：${name}`);
    return skill;
  });
  const { buffer, manifest } = await exportFromDisk({ skills: selected });
  const zipPath = path.join(OUT_DIR, 'skills.zip');
  await fs.writeFile(zipPath, buffer);
  line('zip', zipPath);
  line('zip 大小', `${buffer.length}B`);
  for (const s of manifest.skills) {
    line('打包技能', `${s.name.padEnd(20)} ${String(s.files.length).padStart(3)} 文件 ${String(s.totalBytes).padStart(9)}B revision=${s.revisionId.slice(0, 12)}…`);
  }

  console.log('\n== 3. 读回并自校验 ==');
  const pkg = await readPackage(buffer);
  line('包问题', pkg.problems.length);
  line('技能数', pkg.skills.length);
  let bad = 0;
  for (const skill of pkg.skills) {
    if (skill.problems.length) {
      bad += skill.problems.length;
      for (const p of skill.problems) line('  问题', `${skill.name}: ${p.code} ${p.message}`);
    }
  }
  line('文件问题', bad);
  if (pkg.problems.length || bad) throw new Error('读回校验失败');

  console.log('\n== 4. 输出第三方交叉验证清单 ==');
  const expected = {};
  for (const skill of pkg.skills) {
    const entry = pkg.manifest.skills.find((s) => s.name === skill.name);
    for (const file of entry.files) {
      expected[`${skill.name}/${file.path}`] = { sha256: file.sha256, bytes: file.bytes };
    }
  }
  const expectedPath = path.join(OUT_DIR, 'expected.json');
  await fs.writeFile(expectedPath, JSON.stringify(expected, null, 2));
  line('expected.json', expectedPath);
  line('条目数', Object.keys(expected).length);
  line('含清单文件', pkg.raw.entries.some((e) => e.name === PACKAGE_MANIFEST));
  console.log('\nOK');
}

await main();
