/**
 * dsh-skill-manager —— 宿主半
 *
 * 职责（P0b）：
 *   1. 装配核心库（扫描 / 策略 / 版本 / 打包），把数据目录固定到 <DSH_HOME>/skill-manager；
 *   2. 在 Connection 鉴权栅栏内注册 `/api/skill-manager.*` 精确路由，供设置页读写；
 *   3. 注册覆盖 provider，实现不改源文件的"停用/启用/仅模型/仅用户"。
 *
 * 显式约束：
 *   - **零 dsh peerDependencies**：dsh-app-boot 会对每个 @deepseek-ai/dsh-* peer 做 semver 区间检查，
 *     这里的运行环境是 0.2.0-rc.2（prerelease），踩进去只会让插件被判定不兼容而整体不加载。
 *   - 只注入 'skills' 与 'connection' 两个服务；两个都是宿主必装服务。
 *   - 所有副作用都包在 try/catch 里并记日志：插件出错不能带崩宿主启动。
 */

import path from 'node:path';
import os from 'node:os';
import { createPolicyStore } from './core/policy.js';
import { createRevisionStore } from './core/revisions.js';
import { managedRoots } from './core/roots.js';
import { registerOverlay } from './host/overlay.js';
import { registerRoutes, ROUTES } from './routes.js';
import { exists, writeJsonAtomic } from './core/fsx.js';

export const name = 'dsh-skill-manager';
export const inject = ['skills', 'connection'];

export const PLUGIN_VERSION = '0.2.0';

function defaultHome() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function defaultDshHome() {
  return process.env.DSH_HOME || path.join(defaultHome(), '.dsh');
}

/**
 * 配置项（**故意不导出 Config**）：
 * 官方插件用 zod schema 导出 Config 做校验，而本插件的铁律是零依赖，
 * 因此配置以普通对象的默认值就地解析，宿主传什么就用什么（未传即用默认）。
 *   - dataDir          插件数据目录，默认 <DSH_HOME>/skill-manager
 *   - dshHome          覆盖 DSH_HOME（测试用）
 *   - customSkillDirs  额外扫描根（与官方 customSkillDirs 同义，仅影响本插件清单）
 *   - overlay          是否注册覆盖 provider（false = 只读模式，不改变任何技能可见性）
 *   - writeSnapshot    是否把扫描快照写到数据目录（默认关）
 */
const DEFAULT_CONFIG = Object.freeze({
  dataDir: undefined,
  dshHome: undefined,
  customSkillDirs: undefined,
  overlay: true,
  writeSnapshot: false,
});

export function apply(ctx, config = {}) {
  const options = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  const dataDir = path.resolve(options.dataDir ?? path.join(options.dshHome ?? defaultDshHome(), 'skill-manager'));
  const customSkillDirs = Array.isArray(options.customSkillDirs)
    ? options.customSkillDirs
    : (() => {
        const raw = process.env.DSH_CUSTOM_SKILL_DIRS;
        return raw ? raw.split(path.delimiter).filter(Boolean) : [];
      })();

  const policy = createPolicyStore({ dataDir });
  const store = createRevisionStore({ dataDir });
  const rootsOf = () => managedRoots({ cwd: process.cwd(), customSkillDirs });

  let overlay = null;
  if (options.overlay !== false) {
    try {
      overlay = registerOverlay(ctx, { policy, logger: ctx.logger ?? console });
    } catch (error) {
      ctx.logger?.error?.(`[skill-manager] 覆盖 provider 注册失败（"停用"将不生效）：${error?.stack ?? error}`);
    }
  }

  const routes = registerRoutes(ctx, {
    dataDir,
    policy,
    store,
    rootsOf,
    rootsFor: (cwd) => managedRoots({ cwd, customSkillDirs }),
    overlay,
    officialCatalog: async () => {
      try {
        return await ctx.skills.snapshot({ cwd: process.cwd() });
      } catch (error) {
        ctx.logger?.warn?.(`[skill-manager] 读取官方技能目录失败：${error?.message ?? error}`);
        return null;
      }
    },
    onPolicyChanged: ({ sourceKey, name, policy: policyId }) => {
      ctx.logger?.info?.(`[skill-manager] 策略更新 ${sourceKey}/${name} → ${policyId}（下一个模型步生效）`);
      overlay?.invalidate();
    },
    version: PLUGIN_VERSION,
  });

  // 只读自检：确认插件装配完成、路由可用、磁盘清单与官方目录都读得到。
  // 这里**真的调用处理器**（而不是只打印配置），因此能在宿主进程里验证接线。
  ctx.effect(() => {
    let disposed = false;
    (async () => {
      try {
        const state = await policy.raw();
        const overrides = Object.values(state.overrides ?? {}).reduce((n, byName) => n + Object.keys(byName).length, 0);
        ctx.logger?.info?.(
          `[skill-manager] 已装载 v${PLUGIN_VERSION}：${Object.keys(ROUTES).length} 条路由、` +
            `${overrides} 条策略覆盖、数据目录 ${dataDir}`,
        );

        const ping = await routes.handlers.ping(new Request('http://127.0.0.1/api/skill-manager.ping'));
        const pingBody = await ping.json();
        const list = await routes.handlers.list(new Request('http://127.0.0.1/api/skill-manager.list'));
        const listBody = await list.json();
        ctx.logger?.info?.(
          `[skill-manager] 自检：ping=${pingBody.ok ? 'ok' : 'fail'}、磁盘技能 ${listBody.skills.length} 个、` +
            `非法条目 ${listBody.invalid.length} 个、官方目录 ${
              listBody.official.available ? `${listBody.official.count} 个（差异 ${listBody.official.items.length} 处）` : '不可读'
            }、` +
            `覆盖生效 ${listBody.overlay.active.length} 条（全局注册=${listBody.overlay.global === true}）`,
        );
        const names = listBody.skills.filter((s) => s.policyId === 'disabled').map((s) => s.name);
        if (names.length) ctx.logger?.info?.(`[skill-manager] 当前被停用：${names.join(', ')}`);

        if (options.writeSnapshot) {
          const inv = await routes.handlers.scan();
          if (!disposed) await writeJsonAtomic(path.join(dataDir, 'last-scan.json'), inv);
        }
      } catch (error) {
        ctx.logger?.warn?.(`[skill-manager] 自检失败：${error?.message ?? error}`);
      }
    })();
    return () => {
      disposed = true;
      try {
        routes.dispose();
      } catch {
        /* 忽略 */
      }
      try {
        overlay?.dispose();
      } catch {
        /* 忽略 */
      }
    };
  }, 'skill-manager: startup self-check');
}

/** 供排障使用：确认数据目录是否已经建好 */
export async function installed({ dshHome = defaultDshHome() } = {}) {
  const dataDir = path.join(dshHome, 'skill-manager');
  return { dataDir, exists: await exists(dataDir) };
}
