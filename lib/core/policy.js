/**
 * policy.js —— 四档调用策略的持久化与"停用/启用"
 *
 * 为什么要有"覆盖（overlay）"这一层：官方 dsh-skill-filesystem **没有任何按技能排除的配置**
 * （其 Config 只有 providerName、includeDefaultRoots、dshHome、agentsHome、customSkillDirs、
 *   watch 系列与 bundledSkillDir）。
 * 而注册表的裁决规则是「同层内 rank 小者胜 → provider 注册顺序 → 本地顺序」
 * （dsh-skill/lib/index.js:519-521），重名只看最终胜出者。
 *
 * 因此"停用"只有一条不动源文件的正路：**自己以更高的优先级复报同名技能，改写它的 invocation**。
 * 这正是生态里 @lolkda/dsh-skills-manager 的做法（rank 0 overlay provider），已确凿确认。
 * 它的实例还暴露了一个我们必须照抄的坑：agent preset 组合会再挂一次 dsh-skill-filesystem，
 * 而 preset 层比宿主全局层更近、直接胜出 —— 所以 overlay provider 必须**在每个 agent 作用域各注册一份**。
 *
 * 本模块只管"状态"；把它变成看不见的技能由 host 半的 overlay provider 完成。
 *
 * 语义：
 *   - 没有条目            → 跟随源文件 frontmatter（"跟随文件"）
 *   - policy: 'enabled'   → 显式启用（即使源文件写了 disable-model-invocation 也强制两路可用）
 *   - policy: 'modelOnly' → 仅模型可调用（user-invocable=false）
 *   - policy: 'userOnly'  → 仅用户可调用（disable-model-invocation=true）
 *   - policy: 'disabled'  → 两路都不可见（等价于彻底停用）
 */

import path from 'node:path';
import { exists, readJson, writeJsonAtomic } from './fsx.js';
import { POLICY, policyIdOf } from './frontmatter.js';

export const STATE_VERSION = 1;
export const POLICY_IDS = Object.freeze(['enabled', 'modelOnly', 'userOnly', 'disabled']);
export const FOLLOW_FILE = 'follow';

export function describePolicy(policyId) {
  switch (policyId) {
    case FOLLOW_FILE: return '跟随文件（由 SKILL.md 自己的 frontmatter 决定）';
    case 'enabled': return '启用（模型与用户都可用）';
    case 'modelOnly': return '仅模型可调用（不出现在 / 菜单）';
    case 'userOnly': return '仅用户可调用（模型目录里不可见，只能用 /name）';
    case 'disabled': return '停用（两路都不可见）';
    default: return `未知策略 ${policyId}`;
  }
}

export function emptyState() {
  return { version: STATE_VERSION, overrides: {}, importSources: {}, settings: {}, updatedAt: 0 };
}

export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== STATE_VERSION) return emptyState();
  return {
    version: STATE_VERSION,
    overrides: raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {},
    importSources: raw.importSources && typeof raw.importSources === 'object' ? raw.importSources : {},
    settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

export function createPolicyStore({ dataDir }) {
  const statePath = path.join(dataDir, 'state.json');
  let cache = null;

  async function load({ force = false } = {}) {
    if (cache && !force) return cache;
    cache = normalizeState(await readJson(statePath, null));
    return cache;
  }

  async function save() {
    if (!cache) return;
    cache.updatedAt = Date.now();
    await writeJsonAtomic(statePath, cache);
  }

  /** @returns {{policy:string, entry:object|null}} */
  async function get(sourceKey, name) {
    const state = await load();
    const entry = state.overrides?.[sourceKey]?.[name] ?? null;
    return { policy: entry?.policy ?? FOLLOW_FILE, entry };
  }

  async function setPolicy(sourceKey, name, policyId, meta = {}) {
    if (policyId !== FOLLOW_FILE && !POLICY_IDS.includes(policyId)) {
      throw new Error(`未知策略 "${policyId}"`);
    }
    const state = await load();
    state.overrides[sourceKey] = state.overrides[sourceKey] ?? {};
    if (policyId === FOLLOW_FILE) {
      delete state.overrides[sourceKey][name];
      if (Object.keys(state.overrides[sourceKey]).length === 0) delete state.overrides[sourceKey];
    } else {
      state.overrides[sourceKey][name] = {
        policy: policyId,
        updatedAt: Date.now(),
        ...(meta.path ? { path: meta.path } : {}),
        ...(meta.dir ? { dir: meta.dir } : {}),
        ...(Number.isFinite(meta.officialRank) ? { officialRank: meta.officialRank } : {}),
      };
    }
    await save();
    return { sourceKey, name, policy: policyId };
  }

  /** 兼容旧签名：setPolicy(sourceKey,name,{policy,...}) */
  async function set(sourceKey, name, value, meta = {}) {
    if (typeof value === 'string') return setPolicy(sourceKey, name, value, meta);
    return setPolicy(sourceKey, name, value?.policy ?? FOLLOW_FILE, { ...value, ...meta });
  }

  /** 所有覆盖项（overlay provider 的唯一输入） */
  async function overrides() {
    const state = await load();
    const out = [];
    for (const [sourceKey, byName] of Object.entries(state.overrides)) {
      for (const [name, entry] of Object.entries(byName)) {
        out.push({ sourceKey, name, ...entry });
      }
    }
    return out;
  }

  /** 自愈：清掉源文件已经不存在的覆盖项（避免名字被永久锁死） */
  async function prune(knownKeys) {
    const state = await load();
    const removed = [];
    for (const [sourceKey, byName] of Object.entries({ ...state.overrides })) {
      for (const [name, entry] of Object.entries({ ...byName })) {
        const key = `${sourceKey}::${name}`;
        if (!knownKeys.has(key) && !entry.path) {
          delete byName[name];
          removed.push({ sourceKey, name, reason: '源文件不存在且无记录路径' });
        }
      }
      if (Object.keys(byName).length === 0) delete state.overrides[sourceKey];
    }
    if (removed.length) await save();
    return removed;
  }

  async function setImportSource(label, enabled) {
    const state = await load();
    state.importSources[label] = enabled !== false;
    await save();
    return state.importSources;
  }

  async function importSources() {
    return (await load()).importSources;
  }

  async function settings() {
    return (await load()).settings;
  }

  async function setSetting(key, value) {
    const state = await load();
    state.settings[key] = value;
    await save();
    return state.settings;
  }

  async function raw() {
    return structuredClone(await load());
  }

  async function existsStateFile() {
    return exists(statePath);
  }

  return {
    statePath,
    load,
    save,
    get,
    set,
    setPolicy,
    overrides,
    prune,
    setImportSource,
    importSources,
    settings,
    setSetting,
    raw,
    existsStateFile,
  };
}

/* ------------------------------------------------------------------ *
 * 旧插件状态迁移（只做"规划"，绝不自动应用）
 * ------------------------------------------------------------------ */

export const LEGACY_DEFAULT_PATH = (dshHome) => path.join(dshHome, 'skills-manager', 'state.json');

/**
 * 解析旧 dsh-skills-manager 的 state.json。
 * 本机实测格式：{ version:1, sources:{label:bool}, disabledSkills:{label:[names]}, enabledSkills:{label:[names]} }
 */
export function parseLegacyState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const disabled = raw.disabledSkills;
  const enabled = raw.enabledSkills;
  if (!disabled && !enabled) return null;
  return {
    sources: raw.sources ?? {},
    disabledSkills: disabled ?? {},
    enabledSkills: enabled ?? {},
  };
}

/** 旧插件里的来源标签 → 本插件的 sourceKey */
export function legacySourceKey(label) {
  return label === 'dsh' ? 'user-dsh' : `import:${label}`;
}

/**
 * 生成迁移预览。**注意**：本机旧状态里 7 个 dsh 技能全部是 disabled —— 直接应用会让用户的
 * 技能集体消失，所以这里只输出"将被停用/启用的清单"，由用户在界面上逐条确认。
 */
export function planLegacyMigration(legacy, { knownSkills = [] } = {}) {
  const known = new Set(knownSkills.map((s) => `${s.sourceKey}::${s.name}`));
  const actions = [];
  for (const [label, names] of Object.entries(legacy.disabledSkills)) {
    for (const name of names) {
      const sourceKey = legacySourceKey(label);
      actions.push({
        sourceKey,
        name,
        policy: 'disabled',
        known: known.has(`${sourceKey}::${name}`),
        from: `旧插件 disabledSkills.${label}`,
      });
    }
  }
  for (const [label, names] of Object.entries(legacy.enabledSkills)) {
    for (const name of names) {
      const sourceKey = legacySourceKey(label);
      const key = `${sourceKey}::${name}`;
      if (actions.some((a) => `${a.sourceKey}::${a.name}` === key)) continue;
      actions.push({ sourceKey, name, policy: 'enabled', known: known.has(key), from: `旧插件 enabledSkills.${label}` });
    }
  }
  const summary = {
    total: actions.length,
    willDisable: actions.filter((a) => a.policy === 'disabled').length,
    willEnable: actions.filter((a) => a.policy === 'enabled').length,
    unknown: actions.filter((a) => !a.known).length,
    warning:
      actions.filter((a) => a.policy === 'disabled').length > 0
        ? '旧状态里有技能被标记为停用；直接应用会让这些技能从模型目录与 / 菜单里消失。请逐条确认。'
        : null,
  };
  return { actions, summary };
}

/** 把迁移预览转成 policyStore 可执行的操作（仍需调用方显式执行） */
export async function applyLegacyMigration(store, plan, { onlyKnown = true } = {}) {
  const applied = [];
  for (const action of plan.actions) {
    if (onlyKnown && !action.known) continue;
    // eslint-disable-next-line no-await-in-loop
    await store.setPolicy(action.sourceKey, action.name, action.policy, {});
    applied.push(action);
  }
  return applied;
}

export { POLICY, policyIdOf };
