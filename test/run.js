/**
 * test/run.js —— 极简测试台（零依赖）
 *
 * 用法：
 *   node test/run.js                 跑全部
 *   node test/run.js zip revisions   只跑名字里含这些关键字的用例
 *
 * 约定：test/*.test.js 默认导出一个 `register(t)`；`t(name, fn)` 注册用例。
 * 用例只允许写临时目录（os.tmpdir()），对真实技能库一律只读。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanupTemp } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2);

async function main() {
  const files = (await fs.readdir(here)).filter((f) => f.endsWith('.test.js')).sort();
  const results = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(here, file)).href);
    const register = mod.default;
    if (typeof register !== 'function') continue;
    const cases = [];
    register((name, fn) => cases.push({ name, fn }));
    for (const c of cases) {
      const label = `${file.replace(/\.test\.js$/, '')} :: ${c.name}`;
      if (filters.length && !filters.some((f) => label.toLowerCase().includes(f.toLowerCase()))) continue;
      const started = Date.now();
      try {
        await c.fn();
        results.push({ label, ok: true, ms: Date.now() - started });
        console.log(`  \u2713 ${label} (${Date.now() - started}ms)`);
      } catch (error) {
        results.push({ label, ok: false, ms: Date.now() - started, error });
        console.log(`  \u2717 ${label} (${Date.now() - started}ms)`);
        console.log(`      ${error?.stack ?? error}`);
      }
    }
  }
  await cleanupTemp();
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) process.exitCode = 1;
}

await main();
