/**
 * 生成"很多技能"的验证页：20 个技能 + 3 个分组，用于检查拖拽投放栏。
 * 用数组拼接而非模板字符串嵌套，避免反斜杠转义互相污染。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'harness.html'), 'utf8');

// 1) 在假数据定义之后插入扩容逻辑（沿用已有字段形状，不手写完整对象）
const expand = [
  '  // ---- 扩充到 20 个技能（复用已有形状，只改名与时间） ----',
  '  const baseCount = skills.length;',
  '  for (let i = 0; i < 16; i += 1) {',
  '    const origin = skills[i % baseCount];',
  '    skills.push(Object.assign({}, origin, {',
  '      name: origin.name + "-" + i,',
  '      dirName: origin.dirName + "-" + i,',
  '      dir: origin.dir + "-" + i,',
  '      path: origin.path + "-" + i,',
  '      description: origin.description + "（副本 " + i + "，用于检验长列表下的拖拽）",',
  '      revisionCount: i % 4,',
  '      lastRevisionAt: origin.lastRevisionAt ? origin.lastRevisionAt - i * 3600000 : null,',
  '    }));',
  '  }',
  '',
  '  const listPayload = {',
].join('\n');

let out = src.replace('  const listPayload = {', expand);

// 2) listPayload 里带上三组布局
const layoutBlock = [
  '    skills,',
  '    layout: {',
  '      version: 1,',
  '      groups: [',
  "        { id: 'g_tool', name: '工具类' },",
  "        { id: 'g_flow', name: '流程类' },",
  "        { id: 'g_doc', name: '文档与规格' },",
  '      ],',
  "      assignments: { 'user-dsh::code-review': 'g_tool' },",
  '      order: [],',
  '    },',
].join('\n');
out = out.replace('    skills,\n', `${layoutBlock}\n`);

// 3) layout 路由的假实现
const layoutRoute = [
  "if (target.includes('.layout')) {",
  '      const body = options && options.body ? JSON.parse(options.body) : {};',
  '      const base = listPayload.layout;',
  '      return json({ ok: true, layout: {',
  '        version: 1,',
  '        groups: body.groups || base.groups,',
  '        assignments: body.assignments || base.assignments,',
  '        order: body.order || base.order,',
  '      } });',
  '    }',
  "    if (target.includes('.status'))",
].join('\n');
out = out.replace("if (target.includes('.status'))", layoutRoute);

// 4) 驱动：进整理模式 -> 对第 4 行触发 dragstart，让投放栏出现
const noAuto = out.replace(/\/\* 首屏数据到达后自动展开第一行[\s\S]*?\}, 250\);\n/, '');
const drive = [
  '<script>',
  '(async () => {',
  '  const wait = (ms) => new Promise((r) => setTimeout(r, ms));',
  '  await wait(600);',
  "  const org = [...document.querySelectorAll('.skm-selbar button')].find((b) => b.textContent.trim() === '整理');",
  '  if (org) org.dispatchEvent(new MouseEvent("click", { bubbles: true }));',
  '  await wait(400);',
  "  const rows = document.querySelectorAll('.skm-row');",
  '  if (rows.length < 5) return;',
  '  const dt = { effectAllowed: "", dropEffect: "", setData() {}, getData: () => "" };',
  '  const ev = new MouseEvent("dragstart", { bubbles: true, cancelable: true, clientY: 10 });',
  '  Object.defineProperty(ev, "dataTransfer", { value: dt });',
  '  rows[4].dispatchEvent(ev);',
  '})();',
  '</script>',
].join('\n');

fs.writeFileSync(path.join(here, 'harness-many.html'), noAuto.replace('</body>', `${drive}\n</body>`), 'utf8');

// 语法自检每个内联脚本
const blocks = [...noAuto.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let bad = 0;
for (const [i, code] of blocks.entries()) {
  try {
    new Function(code);
  } catch (error) {
    bad += 1;
    console.log(`block ${i} 语法错误: ${error.message}`);
  }
}
console.log(`blocks=${blocks.length} bad=${bad} layout=${out.includes('g_doc')} count=${out.includes('baseCount')}`);
