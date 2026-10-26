/**
 * revisions.js —— 技能版本跟踪（内容寻址快照 + 修订时间线 + diff + 回滚）
 *
 * 这是本插件相对生态的**第一个差异化能力**：现有插件里只有
 *   - @yanglaofish 的 `.skm-backups/<名>-<时间戳>` 备份目录（无索引、无历史列表、无 diff、无回滚）
 *   - dsh-skills-anywhere 的 sha256 manifest（只在内存/工具边界用，不落盘成历史）
 * 两块互不相连。本模块把两者拼起来，并补上历史索引、逐文件差异、行级 diff 与一键回滚。
 *
 * 磁盘布局（dataDir 默认 <DSH_HOME>/skill-manager）：
 *   objects/<ab>/<sha256>                        文件内容，全局去重（内容寻址）
 *   revisions/<sourceKey>/<name>/index.json      修订时间线（事件序列，最新在前）
 *   revisions/<sourceKey>/<name>/<contentHash>.json  整包 manifest（含逐文件 sha256/bytes）
 *   tmp/                                          临时落盘（回滚暂存优先放目标同卷）
 *
 * 关键设计：
 *   - 修订 id = 整包 manifest 的 contentHash。内容相同 → 不产生新修订（幂等）。
 *   - 索引里存的是"捕获事件"，同一 contentHash 可以在时间线里出现多次
 *     （例如改坏 → 回滚 → 又改回去），此时时间线仍然完整可读。
 *   - capture 只读入尚不存在于对象库的文件，因此第二次以后捕获几乎零 I/O。
 *   - restore 先把当前状态再捕获一次（可逆），再用"同卷暂存 + 原子 rename"替换目录，
 *     失败会回滚，绝不出现半截状态。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildManifest, compareManifests, sha256Hex } from './hash.js';
import { unifiedDiff } from './diff.js';
import { safeRelPath, assertInside, safeSegment } from './paths.js';

export const INDEX_VERSION = 1;

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomic(target, data) {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, target);
}

async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function createRevisionStore({ dataDir }) {
  const objectsDir = path.join(dataDir, 'objects');
  const revisionsDir = path.join(dataDir, 'revisions');
  const tmpDir = path.join(dataDir, 'tmp');

  const objectPath = (sha) => path.join(objectsDir, sha.slice(0, 2), sha);
  const skillDir = (sourceKey, name) => path.join(revisionsDir, safeSegment(sourceKey), safeSegment(name));
  const indexPath = (sourceKey, name) => path.join(skillDir(sourceKey, name), 'index.json');
  const manifestPath = (sourceKey, name, id) => path.join(skillDir(sourceKey, name), `${safeSegment(id)}.json`);

  /** 内容入对象库（幂等、去重）。返回 sha256 */
  async function putObject(buf) {
    const sha = sha256Hex(buf);
    const target = objectPath(sha);
    if (await exists(target)) return sha;
    await writeFileAtomic(target, buf);
    return sha;
  }

  async function readObject(sha) {
    return fs.readFile(objectPath(sha));
  }

  async function readIndex(sourceKey, name) {
    const raw = await readJson(indexPath(sourceKey, name), null);
    if (!raw || raw.version !== INDEX_VERSION) {
      // 未知/损坏版本 → 退空状态（生态里 dsh-skill-hub 同款策略）
      return { version: INDEX_VERSION, name, sourceKey, entries: [] };
    }
    if (!Array.isArray(raw.entries)) return { version: INDEX_VERSION, name, sourceKey, entries: [] };
    return raw;
  }

  /**
   * 捕获一次修订。
   * @returns {Promise<{created:boolean, entry:object, contentHash:string, manifest:object}>}
   */
  async function capture({ sourceKey, name, target, note = null, tag = null, force = false }) {
    const targetStat = await fs.stat(target);
    const manifest = await buildManifest(target);
    const index = await readIndex(sourceKey, name);
    const head = index.entries[0];
    if (head && head.contentHash === manifest.sha256 && !force) {
      return { created: false, entry: head, contentHash: manifest.sha256, manifest };
    }
    // 落 manifest 与（缺失的）对象
    await writeFileAtomic(manifestPath(sourceKey, name, manifest.sha256), JSON.stringify(manifest));
    for (const file of manifest.files) {
      if (await exists(objectPath(file.sha256))) continue;
      // 目录 bundle 用 rel 定位；平铺 .md 的 target 本身就是文件
      const abs = targetStat.isDirectory() ? path.join(target, ...file.path.split('/')) : target;
      try {
        // eslint-disable-next-line no-await-in-loop
        const buf = await fs.readFile(abs);
        // eslint-disable-next-line no-await-in-loop
        await putObject(buf);
      } catch (error) {
        // 文件在扫描后被删/改：整次捕获作废，避免存下不自洽的快照
        const err = new Error(`捕获修订失败：${file.path} 读取不到（${error?.message ?? error}）`);
        err.code = 'capture-inconsistent';
        throw err;
      }
    }
    const entry = {
      contentHash: manifest.sha256,
      at: Date.now(),
      note: note ?? null,
      tag: tag ?? null,
      fileCount: manifest.files.length,
      bytes: manifest.totalBytes,
      target,
    };
    index.entries.unshift(entry);
    index.updatedAt = Date.now();
    await writeFileAtomic(indexPath(sourceKey, name), JSON.stringify(index, null, 2));
    return { created: true, entry, contentHash: manifest.sha256, manifest };
  }

  async function list(sourceKey, name) {
    const index = await readIndex(sourceKey, name);
    return index.entries;
  }

  async function readManifest(sourceKey, name, id) {
    return readJson(manifestPath(sourceKey, name, id), null);
  }

  async function head(sourceKey, name) {
    const entries = await list(sourceKey, name);
    return entries[0] ?? null;
  }

  /** 给某个修订打标签/补备注（时间线里原地更新，不新增修订） */
  async function annotate(sourceKey, name, id, { note, tag } = {}) {
    const index = await readIndex(sourceKey, name);
    let hit = null;
    for (const entry of index.entries) {
      if (entry.contentHash === id) {
        if (note !== undefined) entry.note = note;
        if (tag !== undefined) entry.tag = tag;
        hit = entry;
      }
    }
    if (!hit) return null;
    await writeFileAtomic(indexPath(sourceKey, name), JSON.stringify(index, null, 2));
    return hit;
  }

  /** 逐文件差异（不含行级内容） */
  async function compare(sourceKey, name, idA, idB) {
    const a = await readManifest(sourceKey, name, idA);
    const b = await readManifest(sourceKey, name, idB);
    if (!a || !b) return null;
    return compareManifests(a, b);
  }

  /** 单个文件的行级 diff */
  async function fileDiff(sourceKey, name, idA, idB, relPath) {
    const a = await readManifest(sourceKey, name, idA);
    const b = await readManifest(sourceKey, name, idB);
    if (!a || !b) return null;
    const fa = a.files.find((f) => f.path === relPath);
    const fb = b.files.find((f) => f.path === relPath);
    const textA = fa ? (await readObject(fa.sha256)).toString('utf8') : '';
    const textB = fb ? (await readObject(fb.sha256)).toString('utf8') : '';
    return {
      path: relPath,
      status: !fa ? 'added' : !fb ? 'removed' : 'changed',
      diff: unifiedDiff(textA, textB, { labelA: `a/${relPath}`, labelB: `b/${relPath}` }),
    };
  }

  /**
   * 回滚到某个修订。
   * 先把当前状态捕获为新修订（保证回滚本身可逆），再落盘。
   */
  async function restore({ sourceKey, name, id, target }) {
    const manifest = await readManifest(sourceKey, name, id);
    if (!manifest) {
      const err = new Error(`修订不存在：${id}`);
      err.code = 'revision-not-found';
      throw err;
    }
    const stat = await fs.stat(target);
    let backupEntry = null;
    if (stat.isDirectory()) {
      backupEntry = (await capture({ sourceKey, name, target, note: `回滚到 ${id.slice(0, 12)} 前的自动备份` })).entry;
      // 同卷暂存：放在目标父目录里，保证 rename 原子
      const stageDir = path.join(path.dirname(target), `.dsh-skill-stage-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      await fs.mkdir(stageDir, { recursive: true });
      try {
        for (const file of manifest.files) {
          const safe = safeRelPath(file.path);
          if (!safe.ok) throw new Error(`修订里的路径不安全：${file.path}（${safe.reason}）`);
          const abs = path.join(stageDir, ...safe.rel.split('/'));
          if (!assertInside(stageDir, abs).ok) throw new Error(`修订里的路径逃逸：${file.path}`);
          // eslint-disable-next-line no-await-in-loop
          const buf = await readObject(file.sha256);
          // eslint-disable-next-line no-await-in-loop
          await fs.mkdir(path.dirname(abs), { recursive: true });
          // eslint-disable-next-line no-await-in-loop
          await fs.writeFile(abs, buf);
        }
        const backupDir = `${target}.dsh-backup-${Date.now()}`;
        await fs.rename(target, backupDir);
        try {
          await fs.rename(stageDir, target);
        } catch (error) {
          await fs.rename(backupDir, target).catch(() => {});
          throw error;
        }
        await fs.rm(backupDir, { recursive: true, force: true });
      } catch (error) {
        await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return { restored: true, revision: id, backupRevision: backupEntry?.contentHash ?? null };
    }
    // 平铺 .md：直接覆盖（仍先存对象）
    const single = manifest.files[0];
    if (!single) throw new Error('该修订没有任何文件');
    backupEntry = (await capture({ sourceKey, name, target, note: '回滚前自动备份' })).entry;
    await fs.writeFile(target, await readObject(single.sha256));
    return { restored: true, revision: id, backupRevision: backupEntry?.contentHash ?? null };
  }

  /** 清理没有任何修订引用的对象 */
  async function prune({ dryRun = true } = {}) {
    const referenced = new Set();
    let revisionFiles = [];
    try {
      revisionFiles = await fs.readdir(revisionsDir, { recursive: true, withFileTypes: true });
    } catch {
      revisionFiles = [];
    }
    for (const dirent of revisionFiles) {
      if (!dirent.isFile() || !dirent.name.endsWith('.json') || dirent.name === 'index.json') continue;
      const full = path.join(dirent.parentPath ?? dirent.path, dirent.name);
      const manifest = await readJson(full, null);
      for (const file of manifest?.files ?? []) referenced.add(file.sha256);
    }
    const unreferenced = [];
    let fanouts = [];
    try {
      fanouts = await fs.readdir(objectsDir, { withFileTypes: true });
    } catch {
      fanouts = [];
    }
    for (const dirent of fanouts) {
      if (!dirent.isDirectory()) continue;
      const dir = path.join(objectsDir, dirent.name);
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (!referenced.has(f)) unreferenced.push(path.join(dir, f));
      }
    }
    let removed = 0;
    if (!dryRun) {
      for (const p of unreferenced) {
        if (!assertInside(objectsDir, p).ok) continue;
        // eslint-disable-next-line no-await-in-loop
        await fs.rm(p, { force: true });
        removed += 1;
      }
    }
    return { referenced: referenced.size, unreferenced: unreferenced.length, removed, paths: dryRun ? unreferenced : [] };
  }

  async function stats() {
    let objectCount = 0;
    let objectBytes = 0;
    try {
      const fanouts = await fs.readdir(objectsDir, { withFileTypes: true });
      for (const dirent of fanouts) {
        if (!dirent.isDirectory()) continue;
        const files = await fs.readdir(path.join(objectsDir, dirent.name), { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile()) continue;
          objectCount += 1;
          const st = await fs.stat(path.join(objectsDir, dirent.name, f.name)).catch(() => null);
          objectBytes += st?.size ?? 0;
        }
      }
    } catch {
      /* 空对象库 */
    }
    return { objectCount, objectBytes, objectsDir, revisionsDir, tmpDir };
  }

  return {
    objectsDir,
    revisionsDir,
    tmpDir,
    objectPath,
    putObject,
    readObject,
    capture,
    list,
    head,
    readManifest,
    annotate,
    compare,
    fileDiff,
    restore,
    prune,
    stats,
  };
}
