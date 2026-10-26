/**
 * test/helpers.js —— 测试公共工具
 * （单独成文件，避免测试用例 import run.js 时把测试台自身又跑一遍）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const TEMP_ROOT = path.join(os.tmpdir(), 'dsh-skill-manager-tests');

export async function makeTempDir(label) {
  const dir = path.join(TEMP_ROOT, `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanupTemp() {
  await fs.rm(TEMP_ROOT, { recursive: true, force: true });
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh');
}

export function userProfile() {
  return process.env.USERPROFILE || os.homedir();
}

export async function writeText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

export async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
