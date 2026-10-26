/**
 * paths.js —— 路径安全（导入 zip / 回滚落盘 / 状态键都要过这一关）
 *
 * 两件事：
 *   1. safeRelPath：校验一个"包内相对路径"是否可以安全地落到磁盘或用作对象键。
 *   2. assertInside：确保最终解析出来的绝对路径确实在允许的基目录之内。
 * 这是防御 zip-slip / 绝对路径 / 盘符 / `..` / Windows 保留名的统一入口。
 */

import path from 'node:path';

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * @param {string} rel 形如 `references/a.md`（/ 分隔）
 * @param {{allowNested?:boolean}} options
 * @returns {{ok:true, rel:string}} | {{ok:false, reason:string}}
 */
export function safeRelPath(rel, { allowNested = true } = {}) {
  if (typeof rel !== 'string' || rel === '') return { ok: false, reason: '路径为空' };
  if (rel.includes('\0')) return { ok: false, reason: '路径含 NUL 字节' };
  const normalized = rel.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return { ok: false, reason: '不允许绝对路径' };
  if (/^[A-Za-z]:/.test(normalized)) return { ok: false, reason: '不允许盘符路径' };
  if (normalized.startsWith('//')) return { ok: false, reason: '不允许 UNC 路径' };
  const parts = normalized.split('/').filter((p) => p !== '');
  if (parts.length === 0) return { ok: false, reason: '路径无效' };
  if (!allowNested && parts.length > 1) return { ok: false, reason: '只允许文件（不允许子目录）' };
  for (const part of parts) {
    if (part === '.' || part === '..') return { ok: false, reason: '路径含 . 或 .. 段' };
    if (/[<>:"|?*]/.test(part)) return { ok: false, reason: `路径段含非法字符：${part}` };
    if (/[. ]$/.test(part)) return { ok: false, reason: `路径段不能以点或空格结尾：${part}` };
    const base = part.includes('.') ? part.slice(0, part.indexOf('.')) : part;
    if (WINDOWS_RESERVED.has(base.toLowerCase())) return { ok: false, reason: `Windows 保留名：${part}` };
  }
  return { ok: true, rel: parts.join('/') };
}

/** 校验 target 解析后确实位于 base 之内（含 base 本身） */
export function assertInside(base, target) {
  const b = path.resolve(base);
  const t = path.resolve(target);
  const rel = path.relative(b, t);
  if (rel === '') return { ok: true };
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: `路径逃逸：${t} 不在 ${b} 之内` };
  }
  return { ok: true };
}

/** 把任意字符串压成安全的单层路径段（用于 sourceKey/name 做目录名） */
export function safeSegment(value, fallback = 'unknown') {
  const s = String(value ?? '')
    .replace(/[\\/:*?"<>|\0]/g, '_')
    .replace(/\.+$/, '')
    .trim();
  if (!s) return fallback;
  return s.slice(0, 120);
}
