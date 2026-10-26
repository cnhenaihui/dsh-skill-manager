/**
 * hash.js —— 内容指纹
 *
 * 版本跟踪的身份约定（与生态里 dsh-skills-anywhere 的 bundle manifest 同构，
 * 便于将来互通）：
 *
 *   manifest = {
 *     schema: 'dsh-skill-bundle-1',
 *     sha256: <digest>,            // 对规范 JSON 再取一次 sha256
 *     totalBytes: <number>,
 *     files: [{ path, bytes, sha256 }]   // 按 path 升序，path 用 / 分隔、相对 bundle 根
 *   }
 *
 * digest 只由「排序后的文件清单」决定，因此：
 *   - 改一个字节 → 新 digest（触发新修订）
 *   - 只改文件 mtime → digest 不变
 *   - 挪动目录位置 → digest 不变
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { listBundleFiles } from './scan.js';

export const BUNDLE_SCHEMA = 'dsh-skill-bundle-1';

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export async function hashFile(abs) {
  const buf = await fs.readFile(abs);
  return { sha256: sha256Hex(buf), bytes: buf.byteLength };
}

/** 对规范 JSON（固定键序、无空白）取 digest */
export function digestOf(manifest) {
  return sha256Hex(JSON.stringify(manifest));
}

/**
 * 为一个技能目录（或单个 .md 文件）构建 manifest。
 * @returns {Promise<{schema, sha256, totalBytes, files}>}
 */
export async function buildManifest(target) {
  const st = await fs.stat(target);
  const files = [];
  if (st.isDirectory()) {
    const listed = await listBundleFiles(target);
    for (const file of listed.files) {
      const { sha256, bytes } = await hashFile(file.abs);
      files.push({ path: file.rel, bytes, sha256 });
    }
  } else {
    const { sha256, bytes } = await hashFile(target);
    files.push({ path: target.split(/[\\/]/).pop(), bytes, sha256 });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  const body = { schema: BUNDLE_SCHEMA, totalBytes, files };
  return { ...body, sha256: digestOf(body) };
}

/** 比较两份 manifest，得出逐文件差异 */
export function compareManifests(a, b) {
  const mapA = new Map((a?.files ?? []).map((f) => [f.path, f]));
  const mapB = new Map((b?.files ?? []).map((f) => [f.path, f]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [p, fb] of mapB) {
    const fa = mapA.get(p);
    if (!fa) added.push({ path: p, bytes: fb.bytes });
    else if (fa.sha256 !== fb.sha256) changed.push({ path: p, bytesBefore: fa.bytes, bytesAfter: fb.bytes });
  }
  for (const [p, fa] of mapA) {
    if (!mapB.has(p)) removed.push({ path: p, bytes: fa.bytes });
  }
  return { added, removed, changed, identical: added.length + removed.length + changed.length === 0 };
}
