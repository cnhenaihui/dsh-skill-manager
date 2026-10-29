/**
 * routes.js —— 宿主 HTTP 路由（客户端设置页的唯一数据通道）
 *
 * 为什么走 `ctx.connection.fetch.register` 而不是自己开 webServer 路由：
 *   1. 该注册表在 Connection 的**鉴权栅栏之内**（受信 Host/Origin + 浏览器 cookie），
 *      自己挂 webServer 是无鉴权裸路由；
 *   2. 路由键是**精确 pathname**（`/api/xxx` 全路径），不会与 dsh-client-connection 拥有的
 *      `/api` 前缀 RPC 通道冲突（往 `/api` 挂前缀路由会恒定 401，这是生态里的真实事故）。
 *
 * 处理器全部是 `(request) => Promise<Response>`，且由 createHandlers 独立构造，
 * 因此可以在 Node 里用假 Request 直接单测，不需要跑起宿主（见 test/host.test.js）。
 */

import fs from 'node:fs/promises';
import { managedRoots } from './core/roots.js';
import { inventory, groupByName } from './core/scan.js';
import {
  exportFromDisk,
  exportFromRevision,
  mergePackages,
  readPackage,
  planImport,
  applyImport,
} from './core/pack.js';
import { buildManifest } from './core/hash.js';
import { POLICY_IDS, FOLLOW_FILE, describePolicy } from './core/policy.js';
import { parseSkillDocument } from './core/frontmatter.js';
import { exists } from './core/fsx.js';

export const ROUTE_PREFIX = '/api/skill-manager.';

export const ROUTES = Object.freeze({
  ping: `${ROUTE_PREFIX}ping`,
  list: `${ROUTE_PREFIX}list`,
  detail: `${ROUTE_PREFIX}detail`,
  policy: `${ROUTE_PREFIX}policy`,
  revisions: `${ROUTE_PREFIX}revisions`,
  capture: `${ROUTE_PREFIX}capture`,
  annotate: `${ROUTE_PREFIX}annotate`,
  restore: `${ROUTE_PREFIX}restore`,
  compare: `${ROUTE_PREFIX}compare`,
  export: `${ROUTE_PREFIX}export`,
  import: `${ROUTE_PREFIX}import`,
  baseline: `${ROUTE_PREFIX}baseline`,
  status: `${ROUTE_PREFIX}status`,
});

const json = (value, init = {}) => Response.json(value, { headers: { 'cache-control': 'no-store' }, ...init });
const badRequest = (message, extra = {}) => json({ error: 'bad-request', message, ...extra }, { status: 400 });
const notFound = (message) => json({ error: 'not-found', message }, { status: 404 });
const serverError = (error) => json({ error: 'server-error', message: error?.message ?? String(error) }, { status: 500 });

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * @param {object} deps
 * @param {string} deps.dataDir
 * @param {object} deps.policy   createPolicyStore 的返回值
 * @param {object} deps.store    createRevisionStore 的返回值
 * @param {Function} deps.rootsOf () => 可管理根列表
 * @param {object} [deps.overlay] registerOverlay 的返回值（用于展示覆盖生效情况）
 * @param {Function} [deps.officialCatalog] async () => ctx.skills.snapshot()
 * @param {Function} [deps.onPolicyChanged]
 */
export function createHandlers(deps) {
  const {
    dataDir,
    policy,
    store,
    rootsOf,
    rootsFor = () => rootsOf(),
    overlay = null,
    officialCatalog = async () => null,
    onPolicyChanged = () => {},
    version = '0.3.0',
  } = deps;

  /** 全量扫描 + 贴上插件侧策略/版本统计 */
  async function scan() {
    const roots = rootsOf();
    const inv = await inventory({ roots });
    const grouped = groupByName(inv.skills);
    const skills = [];
    for (const skill of inv.skills) {
      // eslint-disable-next-line no-await-in-loop
      const { policy: policyId } = await policy.get(skill.sourceKey, skill.name);
      // eslint-disable-next-line no-await-in-loop
      const revisions = await store.list(skill.sourceKey, skill.name);
      const group = grouped.get(skill.name) ?? [];
      const index = group.findIndex((s) => s.path === skill.path);
      skills.push({
        ...skill,
        policyId,
        policyLabel: describePolicy(policyId),
        followFile: policyId === FOLLOW_FILE,
        filePolicyId: skill.policyId,
        revisionCount: revisions.length,
        lastRevisionAt: revisions[0]?.at ?? null,
        lastRevisionTag: revisions[0]?.tag ?? null,
        shadowed: index > 0,
        shadowedBy: index > 0 ? group[0]?.path ?? null : null,
      });
    }
    const rootInfo = [];
    for (const root of roots) {
      // eslint-disable-next-line no-await-in-loop
      rootInfo.push({
        key: root.key,
        label: root.label,
        rank: root.rank,
        dir: root.dir,
        managed: root.managed !== false,
        exists: await exists(root.dir),
      });
    }
    return { scannedAt: inv.scannedAt, roots: rootInfo, skills, invalid: inv.invalid, warnings: inv.warnings };
  }

  async function targetOf(sourceKey, name) {
    const entry = (await policy.overrides()).find((e) => e.sourceKey === sourceKey && e.name === name);
    if (entry?.path) return entry.path;
    if (entry?.dir) return entry.dir;
    const inv = await scan();
    const skill = inv.skills.find((s) => s.sourceKey === sourceKey && s.name === name);
    if (!skill) return null;
    return skill.kind === 'flat' ? skill.path : skill.dir;
  }

  /** 当前磁盘内容 vs 最后一次修订 */
  async function currentManifest(sourceKey, name) {
    const target = await targetOf(sourceKey, name);
    if (!target) return null;
    const manifest = await buildManifest(target);
    const head = await store.head(sourceKey, name);
    return {
      sha256: manifest.sha256,
      totalBytes: manifest.totalBytes,
      fileCount: manifest.files.length,
      headRevision: head?.contentHash ?? null,
      matchesHead: head ? head.contentHash === manifest.sha256 : null,
      dirty: head ? head.contentHash !== manifest.sha256 : null,
    };
  }

  /** 技能的修订目标：bundle 用目录，平铺用 .md 文件 */
  function targetOfSkill(skill) {
    return skill.kind === 'flat' ? skill.path : skill.dir;
  }

  /** 单个技能的「磁盘现状 vs 最后一次修订」快照（status / baseline 共用） */
  async function snapshotSkill(skill) {
    const manifest = await buildManifest(targetOfSkill(skill));
    const head = await store.head(skill.sourceKey, skill.name);
    return {
      sourceKey: skill.sourceKey,
      name: skill.name,
      currentHash: manifest.sha256,
      totalBytes: manifest.totalBytes,
      fileCount: manifest.files.length,
      headRevision: head?.contentHash ?? null,
      hasRevision: Boolean(head),
      dirty: head ? head.contentHash !== manifest.sha256 : null,
      lastRevisionAt: head?.at ?? null,
    };
  }

  /** 小并发池：status 需要为每个技能算 manifest，串行在技能多时会明显变慢 */
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(limit, items.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        // eslint-disable-next-line no-await-in-loop
        results[index] = await fn(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /** 磁盘扫到的 vs 官方真正认到的（生态里没人做的对照） */
  async function divergence(skills) {
    let official = null;
    try {
      official = await officialCatalog();
    } catch (error) {
      return { available: false, error: error?.message ?? String(error), items: [] };
    }
    if (!official || !Array.isArray(official.skills)) return { available: false, error: null, items: [] };
    const officialNames = new Set(official.skills.map((s) => s.name));
    const diskNames = new Set(skills.map((s) => s.name));
    const items = [];
    for (const skill of skills) {
      if (!officialNames.has(skill.name)) {
        items.push({ name: skill.name, kind: 'disk-only', detail: '磁盘上存在，但官方目录里没有（被同名高优先级技能遮蔽，或 frontmatter 不合法）' });
      }
    }
    for (const name of officialNames) {
      if (!diskNames.has(name)) items.push({ name, kind: 'official-only', detail: '官方目录里有，但磁盘扫描没找到（来自 bundled/runtime 或其它 provider）' });
    }
    return { available: true, complete: official.complete !== false, count: official.skills.length, items };
  }

  const handlers = {
    /** 存活探测：确认插件已装载、路由已挂 */
    async ping() {
      return json({
        ok: true,
        plugin: '@local/dsh-skill-manager',
        version,
        dataDir,
        policies: [...POLICY_IDS, FOLLOW_FILE],
        routes: Object.values(ROUTES),
        overlay: overlay?.state ?? null,
      });
    },

    /** 技能清单（磁盘真源）+ 来源/优先级/策略/版本数 + 与官方目录的对照 */
    async list(request) {
      const cwd = new URL(request.url).searchParams.get('cwd') ?? process.cwd();
      const roots = rootsFor(cwd);
      const inv = await inventory({ roots });
      const grouped = groupByName(inv.skills);
      const skills = [];
      for (const skill of inv.skills) {
        // eslint-disable-next-line no-await-in-loop
        const { policy: policyId } = await policy.get(skill.sourceKey, skill.name);
        // eslint-disable-next-line no-await-in-loop
        const revisions = await store.list(skill.sourceKey, skill.name);
        const group = grouped.get(skill.name) ?? [];
        const index = group.findIndex((s) => s.path === skill.path);
        skills.push({
          ...skill,
          policyId,
          policyLabel: describePolicy(policyId),
          followFile: policyId === FOLLOW_FILE,
          filePolicyId: skill.policyId,
          revisionCount: revisions.length,
          lastRevisionAt: revisions[0]?.at ?? null,
          lastRevisionTag: revisions[0]?.tag ?? null,
          shadowed: index > 0,
          shadowedBy: index > 0 ? group[0]?.path ?? null : null,
        });
      }
      const rootInfo = [];
      for (const root of roots) {
        // eslint-disable-next-line no-await-in-loop
        rootInfo.push({ key: root.key, label: root.label, rank: root.rank, dir: root.dir, managed: root.managed !== false, exists: await exists(root.dir) });
      }
      const overlayInfo = overlay ? await overlay.provider.inspect() : { active: [], warnings: [] };
      return json({
        scannedAt: inv.scannedAt,
        roots: rootInfo,
        skills,
        invalid: inv.invalid,
        warnings: inv.warnings,
        official: await divergence(skills),
        overlay: { ...(overlay?.state ?? {}), active: overlayInfo.active, warnings: overlayInfo.warnings },
      });
    },

    /** 单个技能详情：正文、frontmatter 解析结果、文件清单、版本时间线 */
    async detail(request) {
      const url = new URL(request.url);
      const name = url.searchParams.get('name');
      const sourceKey = url.searchParams.get('sourceKey');
      const revisionId = url.searchParams.get('revisionId') ?? undefined;
      if (!name || !sourceKey) return badRequest('需要 name 与 sourceKey');
      const inv = await scan();
      const skill = inv.skills.find((s) => s.sourceKey === sourceKey && s.name === name) ?? null;
      const revisions = await store.list(sourceKey, name);
      const head = revisionId ?? revisions[0]?.contentHash ?? null;
      let files = [];
      let totalBytes = 0;
      if (head) {
        const manifest = await store.readManifest(sourceKey, name, head);
        if (manifest) {
          files = manifest.files;
          totalBytes = manifest.totalBytes;
        }
      }
      let content = null;
      if (skill) {
        try {
          content = await fs.readFile(skill.path, 'utf8');
        } catch {
          content = null;
        }
      }
      const parsed = content !== null ? parseSkillDocument(content, { path: skill?.path }) : null;
      return json({
        skill,
        parsed: parsed?.ok ? parsed.skill : null,
        parseError: parsed && !parsed.ok ? { code: parsed.code, message: parsed.message } : null,
        content,
        revisions,
        files: { revisionId: head, files, totalBytes },
        current: await currentManifest(sourceKey, name),
      });
    },

    /** 设置策略（四档 + 跟随文件）；改变下一个模型步生效 */
    async policy(request) {
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object') return badRequest('请求体必须是 JSON');
      const { sourceKey, name, policy: policyId } = body;
      if (typeof sourceKey !== 'string' || typeof name !== 'string') return badRequest('需要 sourceKey 与 name');
      if (policyId !== FOLLOW_FILE && !POLICY_IDS.includes(policyId)) return badRequest(`未知策略 ${JSON.stringify(policyId)}`);
      // 覆盖 provider 必须能定位源文件，因此调用方不传路径时由扫描结果补齐
      const meta = typeof body.meta === 'object' && body.meta !== null ? { ...body.meta } : {};
      if (policyId !== FOLLOW_FILE && !meta.path) {
        const inv = await scan();
        const skill = inv.skills.find((s) => s.sourceKey === sourceKey && s.name === name);
        if (!skill) return notFound(`找不到技能 ${sourceKey}/${name}（无法记录源文件路径）`);
        meta.path = skill.path;
        meta.dir = skill.dir;
        meta.officialRank = skill.rank;
      }
      await policy.setPolicy(sourceKey, name, policyId, meta);
      onPolicyChanged({ sourceKey, name, policy: policyId });
      const overlayInfo = overlay ? await overlay.provider.inspect() : { active: [] };
      return json({
        ok: true,
        sourceKey,
        name,
        policy: policyId,
        policyLabel: describePolicy(policyId),
        overlayActive: overlayInfo.active,
        note: '策略变化在**下一个模型步**生效（目录按需重建，当前回合不变），这是官方行为。',
      });
    },

    /** 版本时间线 + 当前磁盘状态 */
    async revisions(request) {
      const url = new URL(request.url);
      const name = url.searchParams.get('name');
      const sourceKey = url.searchParams.get('sourceKey');
      if (!name || !sourceKey) return badRequest('需要 name 与 sourceKey');
      const entries = await store.list(sourceKey, name);
      return json({
        sourceKey,
        name,
        entries,
        head: entries[0]?.contentHash ?? null,
        current: await currentManifest(sourceKey, name),
      });
    },

    /** 立即捕获一次修订（手动打标签/备注） */
    async capture(request) {
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object') return badRequest('请求体必须是 JSON');
      const { sourceKey, name, note = null, tag = null, force = false } = body;
      if (typeof sourceKey !== 'string' || typeof name !== 'string') return badRequest('需要 sourceKey 与 name');
      const target = await targetOf(sourceKey, name);
      if (!target) return notFound(`找不到技能 ${sourceKey}/${name}`);
      const result = await store.capture({ sourceKey, name, target, note, tag, force });
      return json({ ok: true, created: result.created, contentHash: result.contentHash, entry: result.entry });
    },

    /** 给已有修订打标签/补备注 */
    async annotate(request) {
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object') return badRequest('请求体必须是 JSON');
      const { sourceKey, name, revisionId, note, tag } = body;
      if (typeof sourceKey !== 'string' || typeof name !== 'string' || typeof revisionId !== 'string') {
        return badRequest('需要 sourceKey、name 与 revisionId');
      }
      const entry = await store.annotate(sourceKey, name, revisionId, { note, tag });
      if (!entry) return notFound('修订不存在');
      return json({ ok: true, entry });
    },

    /** 回滚到某个修订（先自动备份当前状态，可逆） */
    async restore(request) {
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object') return badRequest('请求体必须是 JSON');
      const { sourceKey, name, revisionId } = body;
      if (typeof sourceKey !== 'string' || typeof name !== 'string' || typeof revisionId !== 'string') {
        return badRequest('需要 sourceKey、name 与 revisionId');
      }
      const target = await targetOf(sourceKey, name);
      if (!target) return notFound(`找不到技能 ${sourceKey}/${name}`);
      const result = await store.restore({ sourceKey, name, id: revisionId, target });
      return json({ ok: true, ...result });
    },

    /** 文件级差异 / 单文件行级 diff */
    async compare(request) {
      const url = new URL(request.url);
      const name = url.searchParams.get('name');
      const sourceKey = url.searchParams.get('sourceKey');
      const a = url.searchParams.get('a');
      const b = url.searchParams.get('b');
      const relPath = url.searchParams.get('path');
      if (!name || !sourceKey || !a || !b) return badRequest('需要 name、sourceKey、a、b');
      if (relPath) {
        const fileDiff = await store.fileDiff(sourceKey, name, a, b, relPath);
        if (!fileDiff) return notFound('修订不存在');
        return json(fileDiff);
      }
      const cmp = await store.compare(sourceKey, name, a, b);
      if (!cmp) return notFound('修订不存在');
      return json(cmp);
    },

    /** 导出 zip：磁盘现状或指定历史修订（自带清单 + 逐文件 sha256） */
    async export(request) {
      const body = (await readJsonBody(request)) ?? {};
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) return badRequest('需要 items:[{sourceKey,name,revisionId?}]');
      const inv = await scan();
      const parts = [];
      const live = items.filter((i) => !i.revisionId);
      if (live.length) {
        const skills = [];
        for (const item of live) {
          const skill = inv.skills.find((s) => s.sourceKey === item.sourceKey && s.name === item.name);
          if (!skill) return notFound(`找不到技能 ${item.sourceKey}/${item.name}`);
          skills.push(skill);
        }
        // eslint-disable-next-line no-await-in-loop
        parts.push(await exportFromDisk({ skills }));
      }
      for (const item of items.filter((i) => i.revisionId)) {
        // eslint-disable-next-line no-await-in-loop
        parts.push(
          await exportFromRevision({ store, sourceKey: item.sourceKey, name: item.name, revisionId: item.revisionId }),
        );
      }
      // 多段合并也走 buildPackage：同名副本（不同来源）会自动分配唯一顶层目录，
      // 避免 zip 里出现重名条目被解压器静默覆盖（见 core/pack.js assignEntryRoots）。
      const buffer =
        parts.length === 1
          ? parts[0].buffer
          : mergePackages(parts, { generator: { name: '@local/dsh-skill-manager', version } }).buffer;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      return new Response(buffer, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="skills-${stamp}.zip"`,
          'cache-control': 'no-store',
        },
      });
    },

    /**
     * 版本状态巡检：逐技能算当前磁盘指纹，和最后一次修订比较。
     * 单独成路由（而不是塞进 list）是为了让清单接口保持轻量：
     * 只有一位用户点开页面时才做这次全量哈希。
     */
    async status() {
      const inv = await scan();
      const items = await mapLimit(inv.skills, 4, async (skill) => {
        try {
          return await snapshotSkill(skill);
        } catch (error) {
          return {
            sourceKey: skill.sourceKey,
            name: skill.name,
            hasRevision: null,
            dirty: null,
            error: error?.message ?? String(error),
          };
        }
      });
      const counts = {
        total: items.length,
        missingBaseline: items.filter((i) => i.hasRevision === false).length,
        dirty: items.filter((i) => i.dirty === true).length,
        errored: items.filter((i) => i.error).length,
      };
      return json({ ok: true, scannedAt: Date.now(), counts, items });
    },

    /**
     * 一键建立版本基线 / 捕获未记录改动（首开体验的关键：让核心能力默认就发生）。
     * mode: 'missing' 只为没有修订的技能建基线；'dirty' 捕获所有有改动的技能；
     *       'all' 全量 capture（内容未变的不会新增修订）。
     */
    async baseline(request) {
      const body = (await readJsonBody(request)) ?? {};
      const mode = ['missing', 'dirty', 'all'].includes(body.mode) ? body.mode : 'missing';
      const inv = await scan();
      const items = [];
      for (const skill of inv.skills) {
        // eslint-disable-next-line no-await-in-loop
        const head = await store.head(skill.sourceKey, skill.name);
        if (mode === 'missing' && head) {
          items.push({ sourceKey: skill.sourceKey, name: skill.name, skipped: 'has-revision' });
          continue;
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await store.capture({
            sourceKey: skill.sourceKey,
            name: skill.name,
            target: targetOfSkill(skill),
          });
          items.push({
            sourceKey: skill.sourceKey,
            name: skill.name,
            created: result.created,
            contentHash: result.contentHash,
          });
        } catch (error) {
          items.push({ sourceKey: skill.sourceKey, name: skill.name, error: error?.message ?? String(error) });
        }
      }
      const created = items.filter((i) => i.created === true).length;
      const unchanged = items.filter((i) => i.created === false).length;
      const failed = items.filter((i) => i.error);
      return json({
        ok: failed.length === 0,
        mode,
        total: inv.skills.length,
        created,
        unchanged,
        skipped: items.filter((i) => i.skipped).length,
        failed,
        items,
        note:
          mode === 'missing'
            ? '已为没有版本记录的技能建立基线；之后任何一次改坏都能一键回滚。'
            : '已捕获有改动的技能；内容未变的技能不会产生新修订。',
      });
    },

    /** 导入：默认只返回计划（dry-run），?apply=1 才落盘 */
    async import(request) {
      const url = new URL(request.url);
      const apply = url.searchParams.get('apply') === '1';
      const strategy = url.searchParams.get('strategy') ?? 'keep-both';
      const targetDirParam = url.searchParams.get('targetDir');
      let buffer;
      try {
        buffer = Buffer.from(await request.arrayBuffer());
      } catch (error) {
        return badRequest(`读取上传内容失败：${error?.message ?? error}`);
      }
      if (buffer.length === 0) return badRequest('上传内容为空');
      const pkg = await readPackage(buffer);
      const roots = rootsFor(process.cwd());
      const targetDir = targetDirParam ?? roots.find((r) => r.key === 'user-dsh')?.dir;
      if (!targetDir) return badRequest('无法确定导入目标目录');
      const inv = await inventory({ roots: [{ key: 'target', rank: 0, dir: targetDir, label: '导入目标', managed: true }] });
      const plan = planImport({ skills: pkg.skills, existing: inv.skills, strategy });
      if (!apply) return json({ ok: true, applied: false, targetDir, manifest: pkg.manifest, problems: pkg.problems, plan });
      const result = await applyImport({ pkg, plan, targetDir });
      return json({ ok: true, applied: true, targetDir, manifest: pkg.manifest, problems: pkg.problems, plan, written: result.written });
    },
  };

  return Object.assign(handlers, { scan, targetOf, currentManifest });
}

/** 把处理器挂进 Connection 的鉴权栅栏（精确路由，自动随插件卸载） */
export function registerRoutes(ctx, deps) {
  const handlers = createHandlers(deps);
  const table = [
    [ROUTES.ping, ['GET'], handlers.ping],
    [ROUTES.list, ['GET'], handlers.list],
    [ROUTES.detail, ['GET'], handlers.detail],
    [ROUTES.policy, ['POST'], handlers.policy],
    [ROUTES.revisions, ['GET'], handlers.revisions],
    [ROUTES.capture, ['POST'], handlers.capture],
    [ROUTES.annotate, ['POST'], handlers.annotate],
    [ROUTES.restore, ['POST'], handlers.restore],
    [ROUTES.compare, ['GET'], handlers.compare],
    [ROUTES.export, ['POST'], handlers.export],
    [ROUTES.import, ['POST'], handlers.import],
    [ROUTES.baseline, ['POST'], handlers.baseline],
    [ROUTES.status, ['GET'], handlers.status],
  ];
  const disposers = [];
  for (const [routePath, methods, fetch] of table) {
    disposers.push(
      ctx.connection.fetch.register({
        path: routePath,
        methods,
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return await fetch(request);
          } catch (error) {
            try {
              ctx.logger?.error?.(`[skill-manager] ${routePath} 处理失败：${error?.stack ?? error}`);
            } catch {
              /* 忽略 */
            }
            return serverError(error);
          }
        },
      }),
    );
  }
  return { handlers, routes: Object.values(ROUTES), dispose: () => disposers.forEach((d) => d?.()) };
}
