/**
 * fsx.js —— 少量文件系统小工具（原子写、容错读）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 临时文件 + rename 的原子写（同目录，保证同卷） */
export async function writeFileAtomic(target, data) {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, target);
}

export async function writeJsonAtomic(target, value) {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(p, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function readText(p, fallback = null) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return fallback;
  }
}

export function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}
