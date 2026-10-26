/**
 * roots.js —— 技能根表、优先级（rank）与"可管理根 / 导入来源"的区分
 *
 * 对齐官方 dsh-skill-filesystem 的根表（其 lib/index.js:21-25, 152-184）：
 *
 *   rank 100  project-dsh    <projectRoot>/.dsh/skills
 *   rank 200  project-agents <projectRoot>/.agents/skills
 *   rank 300  custom         Config.customSkillDirs
 *   rank 400  user-dsh       <dshHome>/skills            （跳过 .system 子目录）
 *   rank 500  user-agents    <agentsHome>/skills
 *   rank 600  bundled        $DSH_BUNDLED_SKILL_DIR
 *   内存注册的 runtime skill 固定 rank 250（dsh-skill/lib/index.js:21）
 *
 * 两个重要区分：
 *   1. **可管理根（managed）**：官方 provider 会扫描并发现的根。只有落在这些根里、
 *      且真的被官方发现（能进 ctx.skills.snapshot()）的技能，才谈得上"停用/启用"。
 *   2. **导入来源（importSources）**：其它 Agent 技能库（Trae、Claude、Codex…）。
 *      官方**不扫描**它们，因此它们不是"停用"的对象，而是"导入/对比/迁移"的对象。
 *      本机实际存在：~/.trae-cn/skills（9 项）、~/.workbuddy/skills（空）。
 *
 * 本模块刻意不复制官方发现逻辑用于"权威视图"，只用于：
 *   - 管理界面里的来源标签与优先级展示；
 *   - 把某个技能的绝对路径映射回它的 rank（覆盖提供方需要 rank-1 …… 实际用 0）；
 *   - 导入来源枚举。
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const RANK = Object.freeze({
  OVERLAY: 0,
  PROJECT_DSH: 100,
  PROJECT_AGENTS: 200,
  RUNTIME: 250,
  CUSTOM: 300,
  USER_DSH: 400,
  USER_AGENTS: 500,
  BUNDLED: 600,
  IMPORT: 900,
});

/** 其它 Agent 的技能库（只读导入来源）。label → 相对 home 的路径 */
export const FOREIGN_LIBRARIES = Object.freeze({
  agents: '.agents/skills',
  claude: '.claude/skills',
  codex: '.codex/skills',
  cursor: '.cursor/skills',
  gemini: '.gemini/skills',
  opencode: '.opencode/skills',
  copilot: '.copilot/skills',
  windsurf: '.windsurf/skills',
  'windsurf-user': '.codeium/windsurf/skills',
  trae: '.trae/skills',
  'trae-cn': '.trae-cn/skills',
  openclaw: '.openclaw/skills',
  clawdbot: '.clawdbot/skills',
  roo: '.roo/skills',
  codebuddy: '.codebuddy/skills',
  workbuddy: '.workbuddy/skills',
  qoder: '.qoder/skills',
  'qoder-cn': '.qoder-cn/skills',
  lingma: '.lingma/skills',
  ccswitch: '.ccswitch/skills',
});

export function defaultHome() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

export function defaultDshHome() {
  return process.env.DSH_HOME || path.join(defaultHome(), '.dsh');
}

export function defaultAgentsHome() {
  return process.env.DSH_AGENTS_HOME || path.join(defaultHome(), '.agents');
}

/** 项目根：最近的含 .git 的祖先目录；找不到就用 cwd（官方同款语义） */
export function resolveProjectRoot(cwd, { maxDepth = 24 } = {}) {
  let dir = path.resolve(cwd || process.cwd());
  for (let i = 0; i <= maxDepth; i += 1) {
    if (existsSyncSafe(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(cwd || process.cwd());
}

function existsSyncSafe(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 取技能的绝对路径所属的根（用于 rank/来源标签） */
export function identifyRoot(target, roots) {
  const abs = path.resolve(target);
  let best = null;
  for (const root of roots) {
    const rel = path.relative(root.dir, abs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      if (!best || root.dir.length > best.dir.length) best = root;
    }
  }
  return best;
}

/**
 * 可管理根列表（官方 provider 会发现的那些）。
 * @returns [{ key, rank, dir, label, skipSystem, managed:true }]
 */
export function managedRoots({
  cwd = process.cwd(),
  dshHome = defaultDshHome(),
  agentsHome = defaultAgentsHome(),
  customDirs = [],
  bundledDir = process.env.DSH_BUNDLED_SKILL_DIR,
  projectRoot,
} = {}) {
  const proj = projectRoot ?? resolveProjectRoot(cwd);
  const roots = [
    {
      key: 'project-dsh',
      rank: RANK.PROJECT_DSH,
      dir: path.join(proj, '.dsh', 'skills'),
      label: '项目级 .dsh/skills',
      skipSystem: false,
      managed: true,
    },
    {
      key: 'project-agents',
      rank: RANK.PROJECT_AGENTS,
      dir: path.join(proj, '.agents', 'skills'),
      label: '项目级 .agents/skills',
      skipSystem: false,
      managed: true,
    },
  ];
  customDirs.forEach((dir, i) => {
    roots.push({
      key: `custom:${i}`,
      rank: RANK.CUSTOM + i,
      dir: path.resolve(dir),
      label: `自定义目录 ${dir}`,
      skipSystem: false,
      managed: true,
    });
  });
  roots.push({
    key: 'user-dsh',
    rank: RANK.USER_DSH,
    dir: path.join(dshHome, 'skills'),
    label: '用户级 ~/.dsh/skills',
    skipSystem: true,
    managed: true,
  });
  roots.push({
    key: 'user-agents',
    rank: RANK.USER_AGENTS,
    dir: path.join(agentsHome, 'skills'),
    label: '用户级 ~/.agents/skills',
    skipSystem: false,
    managed: true,
  });
  if (bundledDir) {
    roots.push({
      key: 'bundled',
      rank: RANK.BUNDLED,
      dir: path.resolve(bundledDir),
      label: '随包技能',
      skipSystem: false,
      managed: true,
    });
  }
  return roots;
}

/**
 * 其它 Agent 技能库（只读导入来源）。只返回本机真实存在的。
 * @returns [{ key, rank, dir, label, managed:false, importSource:true }]
 */
export function importSources({ home = defaultHome(), exists = existsSyncSafe } = {}) {
  const out = [];
  for (const [label, rel] of Object.entries(FOREIGN_LIBRARIES)) {
    const dir = path.join(home, rel);
    if (!exists(dir)) continue;
    out.push({
      key: `import:${label}`,
      rank: RANK.IMPORT,
      dir,
      label: `${label} 技能库`,
      skipSystem: false,
      managed: false,
      importSource: true,
      sourceLabel: label,
    });
  }
  return out;
}

/** 覆盖提供方用的 rank：官方 rank 一律压到 0，确保在任何层内都赢得同名裁决 */
export function overlayRankFor(_officialRank) {
  return RANK.OVERLAY;
}
