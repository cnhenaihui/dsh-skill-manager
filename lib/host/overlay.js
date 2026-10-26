/**
 * host/overlay.js —— 用"高优先级复报同名技能"实现停用/启用（不碰源文件）
 *
 * 原理（已核实的官方裁决规则，dsh-skill/lib/index.js:110-118, 519-521）：
 *   - 同名技能：**近层直接胜出**；同一层内 rank 小者胜；rank 相同看 provider 注册顺序。
 *   - 因此只要能以 rank 0 复报一个同名候选，就能替掉官方 filesystem 的候选（rank 100~600）。
 *   - 候选的 `provider` 必须等于本 provider 的 name，否则 validateCandidate 会抛错（:462）。
 *   - `get()` 返回的 definition 里必须回传**被改写的 invocation**，否则改写无效。
 *
 * 关键陷阱（来自生态里已实测可用的 @lolkda 实现）：agent preset 的组合会在更近的作用域里再挂一份
 * dsh-skill-filesystem，近层直接胜出。所以除了全局注册，还必须在**每个 agent 作用域各注册一份**，
 * 否则在某些会话里"停用"会失效。本模块两条都做，并且注册失败不连累宿主启动。
 *
 * 不改源文件意味着：停用信息不落在 SKILL.md 里，因此换机器/换工具看不到；
 * 这是与"改写 frontmatter 两键"路线的取舍交换——我们保住了源文件的字节，代价是策略随本机状态走。
 * （frontmatter 改写能力已在 core/frontmatter.js 里实现，作为"导出/固化到源文件"的可选动作保留。）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { POLICY, parseSkillDocument } from '../core/frontmatter.js';

export const OVERLAY_PROVIDER = 'skill-manager-overlay';

/** 覆盖候选的 rank：0 保证在任意层内都压过官方 filesystem（100~600） */
export const OVERLAY_RANK = 0;

/**
 * 构造覆盖 provider。它只复报"被显式改过策略"的技能，其余一律交给官方 provider，
 * 因此不存在重复发现或性能负担。
 */
export function createOverlayProvider({ policy, logger = console, name = OVERLAY_PROVIDER }) {
  const warnings = [];

  function warn(message) {
    warnings.push({ at: Date.now(), message });
    if (warnings.length > 50) warnings.shift();
    try {
      logger?.warn?.(`[skill-manager] ${message}`);
    } catch {
      /* 日志失败不影响发现 */
    }
  }

  async function resolveEntry(entry) {
    const target = entry.path ?? entry.dir;
    if (!target) {
      warn(`覆盖项 ${entry.sourceKey}/${entry.name} 没有记录源文件路径，已跳过`);
      return null;
    }
    let raw;
    try {
      raw = await fs.readFile(target, 'utf8');
    } catch {
      warn(`覆盖项 ${entry.sourceKey}/${entry.name} 的源文件已不存在（${target}），已跳过`);
      return null;
    }
    const parsed = parseSkillDocument(raw, { path: target });
    if (!parsed.ok) {
      warn(`覆盖项 ${entry.sourceKey}/${entry.name} 的 frontmatter 不合法（${parsed.code}），已跳过`);
      return null;
    }
    const directory = entry.dir ?? path.dirname(target);
    return {
      parsed,
      target,
      directory,
      invocation: POLICY[entry.policy] ?? POLICY.enabled,
      sourceKey: entry.sourceKey,
      policyId: entry.policy,
    };
  }

  return {
    name,
    /** 探测：当前有多少条覆盖正在生效（供调试路由） */
    async inspect() {
      const entries = (await policy.overrides()).filter((e) => e.policy !== 'follow');
      const active = [];
      for (const entry of entries) {
        // eslint-disable-next-line no-await-in-loop
        const resolved = await resolveEntry(entry);
        active.push({
          sourceKey: entry.sourceKey,
          name: entry.name,
          policy: entry.policy,
          target: entry.path ?? entry.dir ?? null,
          ok: resolved !== null,
        });
      }
      return { active, warnings: warnings.slice() };
    },
    async list() {
      const entries = (await policy.overrides()).filter((e) => e.policy !== 'follow');
      const candidates = [];
      for (const entry of entries) {
        // eslint-disable-next-line no-await-in-loop
        const resolved = await resolveEntry(entry);
        if (!resolved) continue;
        const { parsed, target, directory, invocation } = resolved;
        candidates.push({
          name: parsed.skill.name,
          description: parsed.skill.description,
          ...(parsed.skill.whenToUse !== undefined ? { whenToUse: parsed.skill.whenToUse } : {}),
          invocation: { ...invocation },
          provider: name,
          source: entry.sourceKey,
          rank: OVERLAY_RANK,
          locator: { path: target, directory },
          resourceBase: { kind: 'directory', path: directory },
          path: target,
          ...(parsed.skill.metadata !== undefined ? { metadata: parsed.skill.metadata } : {}),
        });
      }
      return candidates;
    },
    async get(candidate) {
      const target = candidate?.locator?.path;
      if (typeof target !== 'string') return undefined;
      let raw;
      try {
        raw = await fs.readFile(target, 'utf8');
      } catch {
        return undefined;
      }
      const parsed = parseSkillDocument(raw, { path: target });
      if (!parsed.ok) return undefined;
      return {
        name: parsed.skill.name,
        description: parsed.skill.description,
        ...(parsed.skill.whenToUse !== undefined ? { whenToUse: parsed.skill.whenToUse } : {}),
        // 必须回传候选上被改写的策略，否则停用/启用不会生效
        invocation: { ...candidate.invocation },
        source: candidate.source,
        provider: name,
        resourceBase: candidate.resourceBase,
        path: target,
        ...(parsed.skill.metadata !== undefined ? { metadata: parsed.skill.metadata } : {}),
        content: parsed.skill.content,
      };
    },
  };
}

/**
 * 在全局层 + 每个 agent 作用域注册覆盖 provider。
 * @returns {{control:object|null, provider:object, state:object, dispose:Function}}
 */
export function registerOverlay(ctx, { policy, logger = console } = {}) {
  const provider = createOverlayProvider({ policy, logger });
  const state = {
    global: false,
    scopes: 0,
    scopeErrors: [],
    lastError: null,
  };
  let control = null;
  const disposers = [];

  // 1) 全局层
  try {
    disposers.push(
      ctx.skills.registerProvider((c) => {
        control = c;
        return provider;
      }),
    );
    state.global = true;
  } catch (error) {
    state.lastError = `全局注册覆盖 provider 失败：${error?.message ?? error}`;
    try {
      logger?.error?.(`[skill-manager] ${state.lastError}`);
    } catch {
      /* 忽略 */
    }
  }

  // 2) 每个 agent 作用域各注册一份（agent preset 的近层会盖住全局层）
  const attach = (agent) => {
    let scopedSkills = null;
    try {
      scopedSkills = agent?.ctx?.get?.('skills') ?? null;
    } catch {
      scopedSkills = null;
    }
    if (!scopedSkills) return () => {};
    try {
      const dispose = agent.ctx.effect(() => scopedSkills.registerProvider(() => createOverlayProvider({ policy, logger })));
      state.scopes += 1;
      return dispose;
    } catch (error) {
      const message = error?.message ?? String(error);
      // 同一层重复注册同名 provider 属于预期情况（作用域解析到已注册的层）
      if (state.scopeErrors.length < 10) state.scopeErrors.push(message);
      return () => {};
    }
  };

  const onCreated = ({ agent }) => {
    try {
      const dispose = attach(agent);
      disposers.push(dispose);
    } catch (error) {
      state.lastError = `agent 作用域注册失败：${error?.message ?? error}`;
    }
  };
  ctx.on('agent/created', onCreated);

  return {
    provider,
    get control() {
      return control;
    },
    state,
    /** 策略变化后立即让官方注册表重算目录 */
    invalidate() {
      try {
        control?.invalidate?.();
      } catch (error) {
        state.lastError = `invalidate 失败：${error?.message ?? error}`;
      }
    },
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* 忽略 */
        }
      }
    },
  };
}
