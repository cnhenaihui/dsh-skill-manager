/**
 * scan.js —— 技能清单扫描（只读）
 *
 * 官方 dsh-skill-filesystem 只发现两层形状：
 *   - 目录 bundle：<root>/<name>/SKILL.md
 *   - 平铺文件：  <root>/<name>.md
 * 刻意不支持嵌套 **\/SKILL.md。本模块照此扫描，用于管理界面的清单、文件树与体积统计；
 * 「官方到底认不认」的权威答案仍然取自 ctx.skills.snapshot()（见 host 半的 divergence 核对）。
 *
 * 扫描是只读的：本模块不写任何技能文件。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSkillDocument } from './frontmatter.js';

/** 参与"内容指纹"与展示时忽略的噪音（导出时同样忽略） */
export const DEFAULT_IGNORE = [
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.git',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.idea',
  '.vscode',
];

const MAX_FILES = 5000;
const MAX_DEPTH = 12;

export function shouldIgnore(relPath) {
  const parts = relPath.split(/[\\/]/);
  return parts.some((p) => DEFAULT_IGNORE.includes(p)) || parts.some((p) => p.endsWith('.tmp') || p.endsWith('.pyc'));
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

async function statSafe(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

/**
 * 递归列出 bundle 里的文件（相对路径用 / 分隔），忽略噪音文件。
 * @returns {Promise<{files:{rel:string,abs:string,size:number,mtimeMs:number}[], bytes:number, truncated:boolean}>}
 */
export async function listBundleFiles(dir, { root = dir, depth = 0, acc = [], state = { bytes: 0, truncated: false } } = {}) {
  if (depth > MAX_DEPTH || state.truncated) return { files: acc, bytes: state.bytes, truncated: state.truncated };
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { files: acc, bytes: state.bytes, truncated: state.truncated };
  }
  for (const entry of entries) {
    if (acc.length >= MAX_FILES) {
      state.truncated = true;
      break;
    }
    const abs = path.join(dir, entry.name);
    const rel = toPosix(path.relative(root, abs));
    if (entry.isDirectory()) {
      if (shouldIgnore(entry.name)) continue;
      await listBundleFiles(abs, { root, depth: depth + 1, acc, state });
      continue;
    }
    if (entry.isSymbolicLink()) {
      const st = await statSafe(abs);
      if (!st) continue;
      if (st.isDirectory()) {
        if (shouldIgnore(entry.name)) continue;
        await listBundleFiles(abs, { root, depth: depth + 1, acc, state });
        continue;
      }
      acc.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
      state.bytes += st.size;
      continue;
    }
    if (!entry.isFile()) continue;
    if (shouldIgnore(entry.name)) continue;
    const st = await statSafe(abs);
    if (!st) continue;
    acc.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
    state.bytes += st.size;
  }
  return { files: acc, bytes: state.bytes, truncated: state.truncated };
}

/**
 * 扫描单个根，返回候选条目（不做 frontmatter 校验）。
 * @returns {Promise<{entries:Array, warnings:string[]}>}
 */
export async function scanRoot(root) {
  const warnings = [];
  const entries = [];
  let dirents;
  try {
    dirents = await fs.readdir(root.dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { entries, warnings };
    warnings.push(`读取根目录失败 ${root.dir}: ${error?.message ?? error}`);
    return { entries, warnings };
  }
  for (const dirent of dirents) {
    if (root.skipSystem && dirent.name === '.system') continue;
    const abs = path.join(root.dir, dirent.name);
    const st = await statSafe(abs);
    if (!st) continue;
    if (st.isDirectory()) {
      const skillFile = path.join(abs, 'SKILL.md');
      const skillStat = await statSafe(skillFile);
      if (!skillStat || !skillStat.isFile()) continue;
      entries.push({
        kind: 'bundle',
        dirName: dirent.name,
        dir: abs,
        skillFile,
        mtimeMs: skillStat.mtimeMs,
      });
      continue;
    }
    if (st.isFile() && dirent.name.toLowerCase().endsWith('.md')) {
      entries.push({
        kind: 'flat',
        dirName: dirent.name.replace(/\.md$/i, ''),
        dir: root.dir,
        skillFile: abs,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  return { entries, warnings };
}

/**
 * 读一个候选条目的 frontmatter，并补全体积/文件树信息。
 */
export async function inspectEntry(entry, root) {
  let raw;
  try {
    raw = await fs.readFile(entry.skillFile, 'utf8');
  } catch (error) {
    return {
      ok: false,
      code: 'read-failed',
      message: `读取失败：${error?.message ?? error}`,
      entry,
      root,
    };
  }
  const parsed = parseSkillDocument(raw, { path: entry.skillFile });
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.code,
      key: parsed.key,
      message: parsed.message,
      entry,
      root,
      path: entry.skillFile,
    };
  }
  let bytes = 0;
  let fileCount = 0;
  let truncated = false;
  if (entry.kind === 'bundle') {
    const listed = await listBundleFiles(entry.dir);
    bytes = listed.bytes;
    fileCount = listed.files.length;
    truncated = listed.truncated;
  } else {
    const st = await statSafe(entry.skillFile);
    bytes = st?.size ?? 0;
    fileCount = 1;
  }
  return {
    ok: true,
    root,
    entry,
    fileCount,
    bytes,
    truncated,
    path: entry.skillFile,
    ...parsed.skill,
    diagnostics: parsed.diagnostics,
  };
}

/**
 * 全量清单：扫描所有可管理根，解析每个技能，并把"非法条目"单独列出来
 * （官方会静默丢弃它们，所以这份诊断本身就是价值）。
 *
 * @returns {Promise<{skills:Array, invalid:Array, warnings:string[], scannedAt:number}>}
 */
export async function inventory({ roots, onProgress } = {}) {
  const list = Array.isArray(roots) ? roots : [];
  const skills = [];
  const invalid = [];
  const warnings = [];
  for (const root of list) {
    const { entries, warnings: w } = await scanRoot(root);
    warnings.push(...w);
    for (const entry of entries) {
      if (typeof onProgress === 'function') onProgress(entry);
      const info = await inspectEntry(entry, root);
      if (info.ok) {
        skills.push({
          name: info.name,
          dirName: entry.dirName,
          sourceKey: root.key,
          sourceLabel: root.label,
          rank: root.rank,
          managed: root.managed !== false,
          importSource: root.importSource === true,
          kind: entry.kind,
          dir: entry.dir,
          path: entry.skillFile,
          bytes: info.bytes,
          fileCount: info.fileCount,
          truncated: info.truncated,
          mtimeMs: entry.mtimeMs,
          description: info.description,
          whenToUse: info.whenToUse,
          metadata: info.metadata,
          invocation: info.invocation,
          policyId: info.policyId,
          extraKeys: info.extraKeys,
          diagnostics: info.diagnostics,
        });
      } else {
        invalid.push({
          sourceKey: root.key,
          sourceLabel: root.label,
          dir: entry.dir,
          path: entry.skillFile,
          code: info.code,
          key: info.key,
          message: info.message,
        });
      }
    }
  }
  // 按 rank 升序（优先级高在前），再按名字排序
  skills.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return { skills, invalid, warnings, scannedAt: Date.now() };
}

/** 同名技能分组：用于展示"被高优先级技能遮蔽"的同名项 */
export function groupByName(skills) {
  const map = new Map();
  for (const skill of skills) {
    if (!map.has(skill.name)) map.set(skill.name, []);
    map.get(skill.name).push(skill);
  }
  for (const [, group] of map) {
    group.sort((a, b) => a.rank - b.rank);
    group.forEach((skill, i) => {
      skill.shadowed = i > 0;
      skill.shadowedBy = i > 0 ? group[0].path : undefined;
    });
  }
  return map;
}
