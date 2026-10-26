/**
 * pack.js —— 技能包（zip）的导出与导入
 *
 * 这是本插件相对生态的**第二个差异化能力**：侦察 18 个同类插件后确认，
 * 「导出 zip」在生态里是**零实现**（所有 zip 支持都是单向导入），而且
 * **没有任何 zip 带 manifest.json** —— 因此导入器无法校验完整性、识别版本、做幂等升级。
 *
 * 包格式（本插件定义，格式版本 1）：
 *
 *   dsh-skill-package.json        ← 清单（唯一真源）
 *   <name>/SKILL.md
 *   <name>/references/...
 *   <name>/scripts/...
 *
 * 清单结构：
 *   {
 *     "format": "dsh-skill-package",
 *     "formatVersion": 1,
 *     "exportedAt": "2026-10-17T…Z",
 *     "generator": { "name": "dsh-skill-manager", "version": "0.2.0" },
 *     "skills": [{
 *       "name", "entryRoot", "sourceKey", "revisionId", "description", "whenToUse", "policyId",
 *       "totalBytes", "files": [{ "path", "bytes", "sha256" }]
 *     }]
 *   }
 *
 * entryRoot 是 zip 内的顶层目录：正常情况下等于技能名；同名多副本时追加来源后缀
 * （如 `dup--user-dsh`），否则两条 `dup/SKILL.md` 会被解压器静默覆盖、导出丢内容。
 *
 * 导入侧做三件生态里没人做的事：逐文件 sha256 校验、frontmatter 前置校验、
 * 「同卷暂存 + 原子 rename」写入（失败不留半截状态）。
 *
 * 兼容三种裸包（无清单，来自其它工具）：
 *   - 单个顶层目录 <name>/SKILL.md（含多个则各自成技能）
 *   - 根目录直接一个 SKILL.md
 *   - 平铺的 <name>.md（无资源文件）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createZip, readZip } from './zip.js';
import { safeRelPath, assertInside } from './paths.js';
import { buildManifest, sha256Hex } from './hash.js';
import { parseSkillDocument, createSkillDocument, isSkillName } from './frontmatter.js';
import { exists, writeFileAtomic, randomSuffix } from './fsx.js';

export const PACKAGE_MANIFEST = 'dsh-skill-package.json';
export const PACKAGE_FORMAT = 'dsh-skill-package';
export const PACKAGE_FORMAT_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

/** zip 内顶层目录只允许单段安全名（禁止 / \ : 与 .. 等歧义字符） */
const ENTRY_ROOT_RE = /^[A-Za-z0-9._-]+$/;

function sanitizeRootSuffix(value) {
  const raw = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw || 'copy';
}

/**
 * 给一批技能分配 zip 内的唯一顶层目录。
 *
 * 正常情况下顶层目录 = 技能名；但**同名多副本**（同一个技能存在于多个根，本插件
 * 会显式展示 shadowed）如果都用技能名做顶层目录，zip 里就会出现两条同名条目，
 * 第三方解压器（Windows 资源管理器 / bsdtar / Expand-Archive）会静默后者覆盖前者，
 * 造成导出丢内容。因此重名时追加来源后缀，并在清单里记录 entryRoot 供读回时定位。
 *
 * @param {Array<{name:string, sourceKey?:string}>} skills
 * @returns {string[]} 与 skills 等长的唯一顶层目录名
 */
export function assignEntryRoots(skills) {
  const used = new Set();
  const roots = [];
  for (const skill of skills) {
    const base = String(skill.name);
    if (!used.has(base)) {
      used.add(base);
      roots.push(base);
      continue;
    }
    const suffix = sanitizeRootSuffix(skill.sourceKey);
    let candidate = `${base}--${suffix}`;
    let i = 2;
    while (used.has(candidate)) {
      candidate = `${base}--${suffix}-${i}`;
      i += 1;
    }
    used.add(candidate);
    roots.push(candidate);
  }
  return roots;
}

/**
 * 把「技能记录（含文件内容）」组装成带清单的 zip 包。
 *
 * 这是导出/合并导出的唯一出口：出口只有一处，才能保证
 * 「同名副本不冲突」「清单与 zip 条目一一对应」这两个不变量不被绕过。
 *
 * @param {{skills:Array<{name,sourceKey?,revisionId?,description?,whenToUse?,policyId?,totalBytes?,files:Array<{path,bytes,sha256,data}>}>, generator?, exportedAt?}} params
 * @returns {{buffer:Buffer, manifest:object, skills:Array}}
 */
export function buildPackage({
  skills,
  generator = { name: 'dsh-skill-manager', version: '0.2.0' },
  exportedAt = new Date(),
}) {
  const list = Array.isArray(skills) ? skills : [];
  const roots = assignEntryRoots(list);
  const entries = [];
  const seenEntryNames = new Set();
  const manifestSkills = [];
  const normalized = [];

  list.forEach((skill, index) => {
    // 技能名与顶层目录都要先过安全校验（createZip 只校验条目名本身）
    if (!isSkillName(skill.name)) throw new Error(`技能名不合法，拒绝导出：${JSON.stringify(skill.name)}`);
    const entryRoot = roots[index];
    if (!ENTRY_ROOT_RE.test(entryRoot) || entryRoot === '.' || entryRoot === '..') {
      throw new Error(`zip 顶层目录不合法，拒绝导出：${JSON.stringify(entryRoot)}`);
    }

    const files = [];
    const filesWithData = [];
    let totalBytes = 0;
    for (const file of skill.files ?? []) {
      const safe = safeRelPath(file.path);
      if (!safe.ok) continue;
      const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? '');
      const sha256 = file.sha256 ?? sha256Hex(data);
      const bytes = Number.isFinite(file.bytes) ? file.bytes : data.byteLength;
      const entryName = `${entryRoot}/${safe.rel}`;
      if (seenEntryNames.has(entryName)) {
        // 唯一顶层目录 + 唯一相对路径之后仍然重名，说明调用方给了重复文件，直接拒绝
        throw new Error(`导出条目重名，拒绝产出歧义包：${JSON.stringify(entryName)}`);
      }
      seenEntryNames.add(entryName);
      entries.push({ name: entryName, data });
      files.push({ path: safe.rel, bytes, sha256 });
      filesWithData.push({ path: safe.rel, bytes, sha256, data });
      totalBytes += bytes;
    }
    const sortByPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    files.sort(sortByPath);
    filesWithData.sort(sortByPath);

    manifestSkills.push({
      name: skill.name,
      entryRoot,
      sourceKey: skill.sourceKey ?? null,
      revisionId: skill.revisionId ?? null,
      description: skill.description ?? null,
      whenToUse: skill.whenToUse ?? null,
      policyId: skill.policyId ?? null,
      totalBytes: Number.isFinite(skill.totalBytes) ? skill.totalBytes : totalBytes,
      files,
    });
    normalized.push({
      ...skill,
      entryRoot,
      totalBytes: Number.isFinite(skill.totalBytes) ? skill.totalBytes : totalBytes,
      files: filesWithData,
    });
  });

  const pkgManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    exportedAt: exportedAt.toISOString(),
    generator,
    skills: manifestSkills,
  };
  entries.unshift({ name: PACKAGE_MANIFEST, data: `${JSON.stringify(pkgManifest, null, 2)}\n` });
  return { buffer: createZip(entries), manifest: pkgManifest, skills: normalized };
}

/**
 * 从磁盘上的技能目录打包。
 * @returns {Promise<{buffer:Buffer, manifest:object, skills:Array}>}
 */
export async function exportFromDisk({
  skills,
  generator = { name: 'dsh-skill-manager', version: '0.2.0' },
  exportedAt = new Date(),
}) {
  const records = [];
  for (const skill of skills) {
    if (!isSkillName(skill.name)) throw new Error(`技能名不合法，拒绝导出：${JSON.stringify(skill.name)}`);
    const target = skill.kind === 'flat' ? (skill.path ?? skill.target ?? skill.dir) : (skill.target ?? skill.dir);
    const targetStat = await fs.stat(target);
    const manifest = await buildManifest(target);
    const fileEntries = [];
    for (const file of manifest.files) {
      const safe = safeRelPath(file.path);
      if (!safe.ok) continue;
      const abs = targetStat.isDirectory() ? path.join(target, ...safe.rel.split('/')) : target;
      // eslint-disable-next-line no-await-in-loop
      const data = await fs.readFile(abs);
      fileEntries.push({ path: safe.rel, bytes: file.bytes, sha256: file.sha256, data });
    }
    records.push({
      name: skill.name,
      sourceKey: skill.sourceKey ?? null,
      revisionId: skill.revisionId ?? manifest.sha256,
      description: skill.description ?? null,
      whenToUse: skill.whenToUse ?? null,
      policyId: skill.policyId ?? null,
      totalBytes: manifest.totalBytes,
      files: fileEntries,
    });
  }
  return buildPackage({ skills: records, generator, exportedAt });
}

/**
 * 从版本对象库打包某个历史修订（不改动磁盘上的当前版本）。
 * @param {{ store, sourceKey, name, revisionId, meta }} params
 */
export async function exportFromRevision({
  store,
  sourceKey,
  name,
  revisionId,
  meta = {},
  generator = { name: 'dsh-skill-manager', version: '0.2.0' },
  exportedAt = new Date(),
}) {
  const manifest = await store.readManifest(sourceKey, name, revisionId);
  if (!manifest) throw new Error(`修订不存在：${revisionId}`);
  const fileEntries = [];
  for (const file of manifest.files) {
    const safe = safeRelPath(file.path);
    if (!safe.ok) continue;
    // eslint-disable-next-line no-await-in-loop
    const data = await store.readObject(file.sha256);
    fileEntries.push({ path: safe.rel, bytes: file.bytes, sha256: file.sha256, data });
  }
  return buildPackage({
    skills: [
      {
        name,
        sourceKey,
        revisionId,
        description: meta.description ?? null,
        whenToUse: meta.whenToUse ?? null,
        policyId: meta.policyId ?? null,
        totalBytes: manifest.totalBytes,
        files: fileEntries,
      },
    ],
    generator,
    exportedAt,
  });
}

/**
 * 合并多个已导出的包（磁盘现状 + 历史修订混排）为一个包。
 * 复用 buildPackage，因此同样具备「同名副本自动消歧」的能力。
 * @param {Array<{skills:Array}>} packages exportFromDisk / exportFromRevision 的返回值
 */
export function mergePackages(packages, { generator = { name: 'dsh-skill-manager', version: '0.2.0' }, exportedAt = new Date() } = {}) {
  const skills = [];
  for (const pkg of packages ?? []) {
    for (const record of pkg?.skills ?? []) {
      if (!Array.isArray(record.files) || record.files.length === 0) continue;
      skills.push(record);
    }
  }
  if (skills.length === 0) throw new Error('合并导出失败：没有任何可导出的技能');
  return buildPackage({ skills, generator, exportedAt });
}

/* ------------------------------------------------------------------ *
 * 读取与校验
 * ------------------------------------------------------------------ */

/**
 * 读取一个技能包（Buffer 或路径）。
 * @returns {Promise<{ok:boolean, manifest:object|null, skills:Array, problems:Array, raw:object}>}
 */
export async function readPackage(input) {
  const raw = readZip(input);
  const problems = [...(raw.problems ?? [])];
  const byRoot = new Map();
  let manifestRaw = null;

  for (const entry of raw.entries) {
    if (entry.isDirectory) continue;
    const safe = safeRelPath(entry.name);
    if (!safe.ok) {
      problems.push({ code: 'unsafe-path', name: entry.name, message: safe.reason });
      continue;
    }
    if (safe.rel === PACKAGE_MANIFEST) {
      try {
        manifestRaw = JSON.parse(entry.data.toString('utf8'));
      } catch (error) {
        problems.push({ code: 'manifest-parse', name: entry.name, message: `清单不是合法 JSON：${error?.message ?? error}` });
      }
      continue;
    }
    const slash = safe.rel.indexOf('/');
    let rootKey;
    let rel;
    if (slash === -1) {
      // 根目录裸文件：<name>.md 或 SKILL.md
      const base = safe.rel.replace(/\.md$/i, '');
      rootKey = base.toLowerCase() === 'skill' ? '__root__' : base;
      rel = safe.rel;
    } else {
      rootKey = safe.rel.slice(0, slash);
      rel = safe.rel.slice(slash + 1);
    }
    if (!byRoot.has(rootKey)) byRoot.set(rootKey, { name: rootKey === '__root__' ? null : rootKey, files: [] });
    byRoot.get(rootKey).files.push({ path: rel, data: entry.data, bytes: entry.data.byteLength, sha256: sha256Hex(entry.data) });
  }

  let manifest = null;
  if (manifestRaw) {
    if (manifestRaw.format !== PACKAGE_FORMAT) {
      problems.push({ code: 'manifest-format', message: `未知包格式 "${manifestRaw.format}"` });
    } else if (manifestRaw.formatVersion > PACKAGE_FORMAT_VERSION) {
      problems.push({
        code: 'manifest-version',
        message: `包格式版本 ${manifestRaw.formatVersion} 高于本插件支持的 ${PACKAGE_FORMAT_VERSION}`,
      });
    } else {
      manifest = manifestRaw;
    }
  }

  // 组装技能：优先用清单里的身份，其次从 SKILL.md frontmatter 推断
  const skills = [];
  const consumed = new Set();
  for (const entry of manifest?.skills ?? []) {
    // 新版包用 entryRoot 记录 zip 顶层目录（同名副本时与技能名不同）；
    // 旧版包没有该字段，退化为「顶层目录 = 技能名」。
    const entryRoot = typeof entry.entryRoot === 'string' && entry.entryRoot.length > 0 ? entry.entryRoot : entry.name;
    if (!ENTRY_ROOT_RE.test(entryRoot) || entryRoot === '.' || entryRoot === '..') {
      problems.push({ code: 'invalid-entry-root', name: entry.name, message: `清单里的 entryRoot 不合法：${JSON.stringify(entryRoot)}` });
      continue;
    }
    if (consumed.has(entryRoot)) {
      // 该顶层目录已经被前一条技能认领：报问题并跳过，避免同一份文件被算成两个技能
      problems.push({ code: 'duplicate-entry-root', name: entry.name, message: `清单里多个技能使用了同一个 entryRoot：${entryRoot}` });
      continue;
    }
    consumed.add(entryRoot);
    const bucket = byRoot.get(entryRoot) ?? null;
    const skill = { name: entry.name, entryRoot, sourceKey: entry.sourceKey ?? null, files: bucket?.files ?? [], manifest: entry, problems: [] };
    if (!bucket) {
      skill.problems.push({ code: 'missing-files', message: '清单里列了该技能，但包里没有对应文件' });
    } else {
      // 逐文件校验清单里的 sha256（生态里没有任何 zip 做过这件事）
      const fileMap = new Map(bucket.files.map((f) => [f.path, f]));
      for (const declared of entry.files ?? []) {
        const actual = fileMap.get(declared.path);
        if (!actual) {
          skill.problems.push({ code: 'missing-file', message: `清单声明的文件缺失：${declared.path}` });
        } else if (declared.sha256 && actual.sha256 !== declared.sha256) {
          skill.problems.push({
            code: 'hash-mismatch',
            message: `文件校验失败：${declared.path}（期望 ${declared.sha256.slice(0, 12)}…，实际 ${actual.sha256.slice(0, 12)}…）`,
          });
        }
      }
      const declaredPaths = new Set((entry.files ?? []).map((f) => f.path));
      for (const actual of bucket.files) {
        if (!declaredPaths.has(actual.path)) skill.problems.push({ code: 'extra-file', message: `清单未声明的文件：${actual.path}` });
      }
    }
    skills.push(skill);
  }
  for (const [key, bucket] of byRoot) {
    if (consumed.has(key)) continue;
    const skillMd = bucket.files.find((f) => f.path === 'SKILL.md' || f.path.toLowerCase() === 'skill.md');
    let name = bucket.name;
    if (!name && skillMd) {
      const parsed = parseSkillDocument(skillMd.data.toString('utf8'));
      name = parsed.ok ? parsed.skill.name : null;
    }
    if (!name) {
      problems.push({ code: 'unnamed-skill', message: `无法确定为技能目录的条目：${key}` });
      continue;
    }
    skills.push({ name, entryRoot: key, sourceKey: null, files: bucket.files, manifest: null, problems: [{ code: 'no-manifest', message: '包内没有清单，身份与完整性未经验证' }] });
  }

  return { ok: skills.length > 0, manifest, skills, problems, raw };
}

/* ------------------------------------------------------------------ *
 * 导入前校验与落盘
 * ------------------------------------------------------------------ */

/**
 * 校验一个包内技能：必须有 SKILL.md 且 frontmatter 合法（官方会静默丢弃非法项，
 * 所以我们必须在写入前拦下来）。
 */
export function validatePackedSkill(skill) {
  const problems = [];
  const skillMd = skill.files.find((f) => f.path === 'SKILL.md' || f.path.toLowerCase() === 'skill.md');
  if (!skillMd) {
    problems.push({ code: 'no-skill-md', message: '缺少 SKILL.md' });
    return { ok: false, problems, name: skill.name, parsed: null };
  }
  const parsed = parseSkillDocument(skillMd.data.toString('utf8'), { path: `zip://${skill.name}/SKILL.md` });
  if (!parsed.ok) {
    problems.push({ code: parsed.code, message: parsed.message });
    return { ok: false, problems, name: skill.name, parsed: null };
  }
  if (parsed.skill.name !== skill.name) {
    problems.push({
      code: 'name-mismatch',
      message: `目录名/清单名 "${skill.name}" 与 frontmatter 的 name "${parsed.skill.name}" 不一致；官方以 frontmatter 为准`,
    });
  }
  for (const file of skill.files) {
    const safe = safeRelPath(file.path);
    if (!safe.ok) problems.push({ code: 'unsafe-path', message: `${file.path}：${safe.reason}` });
  }
  return { ok: problems.every((p) => p.code === 'name-mismatch'), problems, name: parsed.skill.name, parsed: parsed.skill };
}

/**
 * 规划导入：与目标根里的现有技能比对，决定 create / overwrite / rename / skip。
 * @param {object} params
 * @param {Array} params.skills 来自 readPackage
 * @param {Array} params.existing 现有技能 [{name, dir}]（通常取自 inventory）
 * @param {string} params.strategy 'overwrite' | 'keep-both' | 'skip'
 */
export function planImport({ skills, existing = [], strategy = 'keep-both' }) {
  const existingNames = new Set(existing.map((s) => s.name));
  const actions = [];
  const planned = new Set();
  skills.forEach((skill, sourceIndex) => {
    const validation = validatePackedSkill(skill);
    if (!validation.ok) {
      actions.push({ kind: 'invalid', name: skill.name, sourceIndex, problems: validation.problems });
      return;
    }
    const finalName = validation.name;
    const clash = existingNames.has(finalName) || planned.has(finalName);
    if (!clash) {
      actions.push({ kind: 'create', name: finalName, sourceIndex, problems: validation.problems });
      planned.add(finalName);
      return;
    }
    if (strategy === 'overwrite') {
      actions.push({ kind: 'overwrite', name: finalName, sourceIndex, problems: validation.problems });
      planned.add(finalName);
    } else if (strategy === 'skip') {
      actions.push({ kind: 'skip', name: finalName, sourceIndex, problems: validation.problems });
    } else {
      let candidate = finalName;
      let i = 2;
      while (existingNames.has(candidate) || planned.has(candidate)) {
        candidate = `${finalName}-${i}`;
        i += 1;
      }
      actions.push({ kind: 'rename', name: finalName, to: candidate, sourceIndex, problems: validation.problems });
      planned.add(candidate);
    }
  });
  return {
    strategy,
    actions,
    summary: {
      create: actions.filter((a) => a.kind === 'create').length,
      overwrite: actions.filter((a) => a.kind === 'overwrite').length,
      rename: actions.filter((a) => a.kind === 'rename').length,
      skip: actions.filter((a) => a.kind === 'skip').length,
      invalid: actions.filter((a) => a.kind === 'invalid').length,
    },
  };
}

/**
 * 落盘导入：同卷暂存目录 + 原子 rename。
 * @param {{ pkg, plan, targetDir, dryRun?:boolean }} params
 */
export async function applyImport({ pkg, plan, targetDir, dryRun = false }) {
  const byName = new Map(pkg.skills.map((s) => [s.name, s]));
  const written = [];
  await fs.mkdir(targetDir, { recursive: true });
  for (const action of plan.actions) {
    if (action.kind === 'skip' || action.kind === 'invalid') continue;
    // 同一包里可以有两个同名技能（不同来源），因此优先按 sourceIndex 定位；
    // 没有该字段的旧计划退回按名字查找。
    const skill = Number.isInteger(action.sourceIndex) ? pkg.skills[action.sourceIndex] : byName.get(action.name);
    if (!skill) continue;
    const finalName = action.to ?? action.name;
    const dest = path.join(targetDir, finalName);
    if (!assertInside(targetDir, dest).ok) throw new Error(`目标路径逃逸：${dest}`);
    if (dryRun) {
      written.push({ name: finalName, dest, dryRun: true });
      continue;
    }
    const stage = path.join(targetDir, `.dsh-import-stage-${process.pid}-${randomSuffix()}`);
    await fs.mkdir(stage, { recursive: true });
    try {
      for (const file of skill.files) {
        const safe = safeRelPath(file.path);
        if (!safe.ok) continue;
        const abs = path.join(stage, ...safe.rel.split('/'));
        if (!assertInside(stage, abs).ok) throw new Error(`包内路径逃逸：${file.path}`);
        // eslint-disable-next-line no-await-in-loop
        await fs.mkdir(path.dirname(abs), { recursive: true });
        // eslint-disable-next-line no-await-in-loop
        await fs.writeFile(abs, file.data);
      }
      // 名称以 frontmatter 为准时，把目录名同步过去（写之前重命名暂存目录无意义，这里直接校验）
      if (await exists(dest)) {
        const backup = `${dest}.dsh-bak-${Date.now()}`;
        await fs.rename(dest, backup);
        try {
          await fs.rename(stage, dest);
        } catch (error) {
          await fs.rename(backup, dest).catch(() => {});
          throw error;
        }
        await fs.rm(backup, { recursive: true, force: true });
      } else {
        await fs.rename(stage, dest);
      }
      written.push({ name: finalName, dest });
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  return { written, targetDir };
}

/** 便捷入口：把一段文本写成新技能（注册/脚手架） */
export async function scaffoldSkill(targetDir, { name, description, whenToUse, policyId = 'enabled', body }) {
  const dest = path.join(targetDir, name);
  if (!assertInside(targetDir, dest).ok) throw new Error(`目标路径逃逸：${dest}`);
  if (await exists(dest)) throw new Error(`技能已存在：${name}`);
  await fs.mkdir(dest, { recursive: true });
  const content = createSkillDocument({ name, description, whenToUse, policyId, body });
  await writeFileAtomic(path.join(dest, 'SKILL.md'), content);
  return { name, dest, path: path.join(dest, 'SKILL.md') };
}
