/**
 * layout.js —— 分组与自定义排序的纯逻辑（无 IO，可在 Node 里直接单测）
 *
 * 三个能力：
 *   1. 自定义分组：技能 → 分组的归属（assignments）
 *   2. 技能自定义排序：一条完整有序的 key 列表（order）
 *   3. 分组自定义排序：groups 数组自身的顺序
 *
 * 为什么 order 存「完整有序 key 数组」而不是每个技能一个整数：
 *   - 前端拖动一次就有完整顺序，直接提交整条列表，**不需要前后端各算一遍**
 *     "取相邻两项的中间值"，也就没有浮点精度耗尽、没有并发写时的中间值冲突；
 *   - 读取时 rank = index，天然去重、天然紧凑，不需要 compact 步骤；
 *   - 技能总数是几十到几百量级，整列表传输的开销可以忽略。
 *
 * 未出现在 order 里的技能（新增的技能）排在末尾，并保持扫描给出的原始顺序 ——
 * 这样"我排过序"之后新装的技能不会插进中间，而是稳定地落在最后。
 */

/** 虚拟组的 id：真实分组 id 一律以 `g_` 开头，不会撞上。 */
export const UNGROUPED = '__ungrouped';

export const LAYOUT_VERSION = 1;

/** 分组 id 只需要在单个 state.json 内唯一，且要能安全放进 URL/JSON。 */
export function newGroupId(existing = []) {
  const taken = new Set(existing);
  for (let i = 0; i < 1000; i += 1) {
    const id = `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!taken.has(id)) return id;
  }
  // 理论上到不了这里；真到了也只是 id 长一点，不是错误。
  return `g_${Math.random().toString(36).slice(2, 12)}`;
}

export function emptyLayout() {
  return { version: LAYOUT_VERSION, groups: [], assignments: {}, order: [] };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanName(value, fallback = '') {
  // 分组名只做"去空白 + 限长"，不做字符集限制：中文、emoji、标点都可以。
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text.length > 60 ? text.slice(0, 60) : text || fallback;
}

/**
 * 容错归一：任何字段坏了都退化成"没有这个功能"，**绝不让一组排序数据把策略一起丢掉**。
 * `knownKeys` 可选：给出时会把已不存在的技能从 assignments/order 里清掉。
 */
export function normalizeLayout(raw, { knownKeys = null } = {}) {
  const out = emptyLayout();
  if (!isPlainObject(raw)) return out;

  const seen = new Set();
  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  for (const entry of groups) {
    if (!isPlainObject(entry)) continue;
    const id = String(entry.id ?? '').trim();
    // 只接受本模块生成的 id 形态，避免脏数据里出现 `__ungrouped` 之类的保留值。
    if (!id.startsWith('g_') || seen.has(id)) continue;
    seen.add(id);
    out.groups.push({ id, name: cleanName(entry.name, '未命名分组') });
  }

  const known = knownKeys ? new Set(knownKeys) : null;
  if (isPlainObject(raw.assignments)) {
    for (const [key, gid] of Object.entries(raw.assignments)) {
      if (typeof gid !== 'string' || !seen.has(gid)) continue;
      if (known && !known.has(key)) continue;
      out.assignments[key] = gid;
    }
  }

  const order = Array.isArray(raw.order) ? raw.order : [];
  const ordered = new Set();
  for (const key of order) {
    if (typeof key !== 'string' || !key || ordered.has(key)) continue;
    if (known && !known.has(key)) continue;
    ordered.add(key);
    out.order.push(key);
  }
  return out;
}

/** 该 key 属于哪个分组（未分组返回 UNGROUPED）。悬空引用也算未分组。 */
export function groupOf(layout, key) {
  const gid = layout?.assignments?.[key];
  if (!gid) return UNGROUPED;
  return (layout.groups ?? []).some((g) => g.id === gid) ? gid : UNGROUPED;
}

const UNRANKED = Number.MAX_SAFE_INTEGER;

/**
 * 按 layout.order 排序；未排名的保持原始顺序并落在最后。
 * 排序键用「rank, 原索引」双键，因此结果是确定的、可重复的。
 */
export function sortSkills(skills, layout, keyOf) {
  const rank = new Map();
  (layout?.order ?? []).forEach((key, index) => {
    if (!rank.has(key)) rank.set(key, index);
  });
  return skills
    .map((skill, index) => {
      const key = keyOf(skill);
      return { skill, index, rank: rank.has(key) ? rank.get(key) : UNRANKED };
    })
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map((entry) => entry.skill);
}

/**
 * 切成「有序分组 + 组内有序技能」。
 * 空分组也返回（用户在界面上刚建好、还没放技能），否则建完就消失会让人以为没生效。
 * 未分组永远是最后一组，且只在真有技能时才出现。
 */
export function groupSkills(skills, layout, keyOf) {
  const sorted = sortSkills(skills, layout, keyOf);
  const buckets = new Map();
  for (const skill of sorted) {
    const gid = groupOf(layout, keyOf(skill));
    if (!buckets.has(gid)) buckets.set(gid, []);
    buckets.get(gid).push(skill);
  }

  const out = [];
  for (const group of layout?.groups ?? []) {
    out.push({ id: group.id, name: group.name, skills: buckets.get(group.id) ?? [] });
  }
  if (buckets.has(UNGROUPED)) {
    out.push({ id: UNGROUPED, name: '未分组', skills: buckets.get(UNGROUPED) });
  }
  return out;
}

/**
 * 把一次「完整顺序提交」变成可存的 order 数组。
 * `keys` 是前端当前看到的全部 key（按用户排好的顺序），多余/重复的会被丢掉，
 * 因此即使前端状态脏了，存下来的也一定是一条干净的全序。
 */
export function orderFromKeys(keys) {
  const out = [];
  const seen = new Set();
  for (const key of Array.isArray(keys) ? keys : []) {
    if (typeof key !== 'string' || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * 把技能 `key` 移到 `targetKey` 之前（`after=true` 则移到之后），返回新的完整 key 列表。
 * 拖动交互在前端只需要算出"目标位置"，把计算集中在这里就能离线测试。
 */
export function moveKey(keys, key, targetKey, { after = false } = {}) {
  const list = orderFromKeys(keys);
  const from = list.indexOf(key);
  if (from < 0 || key === targetKey) return list;
  const rest = list.filter((k) => k !== key);
  const at = rest.indexOf(targetKey);
  if (at < 0) {
    // 目标不在列表里（例如把技能拖到空分组）：落到末尾。
    return [...rest, key];
  }
  rest.splice(after ? at + 1 : at, 0, key);
  return rest;
}

/**
 * 校验并归一一次写入请求。三个字段都可选，只改传了的那个。
 * @returns {{ok:true, patch:object} | {ok:false, message:string}}
 */
export function parseLayoutPatch(body, { knownKeys = null } = {}) {
  if (!isPlainObject(body)) return { ok: false, message: '请求体必须是 JSON 对象' };
  const patch = {};

  if (body.groups !== undefined) {
    if (!Array.isArray(body.groups)) return { ok: false, message: 'groups 必须是数组' };
    const seen = new Set();
    const groups = [];
    for (const entry of body.groups) {
      if (!isPlainObject(entry)) return { ok: false, message: 'groups 的每一项必须是对象' };
      const name = cleanName(entry.name);
      if (!name) return { ok: false, message: '分组名不能为空' };
      let id = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (id && !id.startsWith('g_')) return { ok: false, message: `非法分组 id：${id}` };
      if (id && seen.has(id)) return { ok: false, message: `分组 id 重复：${id}` };
      if (!id) id = newGroupId([...seen]);
      seen.add(id);
      groups.push({ id, name });
    }
    patch.groups = groups;
  }

  if (body.assignments !== undefined) {
    if (!isPlainObject(body.assignments)) return { ok: false, message: 'assignments 必须是对象' };
    const groups = patch.groups ?? null;
    const assignments = {};
    for (const [key, gid] of Object.entries(body.assignments)) {
      if (!key) return { ok: false, message: 'assignments 的键不能为空' };
      if (knownKeys && !knownKeys.has(key)) continue;
      if (gid === null || gid === UNGROUPED || gid === '') continue;
      if (typeof gid !== 'string' || !gid.startsWith('g_')) {
        return { ok: false, message: `assignments 的值必须是分组 id 或 null（收到 ${JSON.stringify(gid)}）` };
      }
      if (groups && !groups.some((g) => g.id === gid)) {
        return { ok: false, message: `assignments 引用了本次提交里不存在的分组 ${gid}` };
      }
      assignments[key] = gid;
    }
    patch.assignments = assignments;
  }

  if (body.order !== undefined) {
    if (!Array.isArray(body.order)) return { ok: false, message: 'order 必须是数组' };
    const order = orderFromKeys(body.order);
    patch.order = knownKeys ? order.filter((key) => knownKeys.has(key)) : order;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, message: '需要 groups / assignments / order 至少一项' };
  }
  return { ok: true, patch };
}
