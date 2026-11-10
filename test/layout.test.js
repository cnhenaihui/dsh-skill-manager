/**
 * layout.test.js —— 分组与自定义排序的纯逻辑 + 状态存储往返
 */
import { createPolicyStore } from '../lib/core/policy.js';
import {
  UNGROUPED,
  emptyLayout,
  groupOf,
  groupSkills,
  moveKey,
  newGroupId,
  normalizeLayout,
  orderFromKeys,
  parseLayoutPatch,
  sortSkills,
} from '../lib/core/layout.js';
import { makeTempDir } from './helpers.js';

const keyOf = (s) => `${s.sourceKey}::${s.name}`;
const skill = (name, sourceKey = 'user-dsh') => ({ sourceKey, name });

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  期望 ${b}\n  实际 ${a}`);
}

export default function register(t) {
  /* ---------------- 归一 ---------------- */

  t('layout :: 空输入得到空布局', () => {
    eq(normalizeLayout(null), emptyLayout(), 'null');
    eq(normalizeLayout(undefined), emptyLayout(), 'undefined');
    eq(normalizeLayout('坏数据'), emptyLayout(), '字符串');
    eq(normalizeLayout({ groups: 'x', assignments: [], order: {} }), emptyLayout(), '类型全错');
  });

  t('layout :: 非法分组 id 与重复 id 被丢弃', () => {
    const out = normalizeLayout({
      groups: [
        { id: 'g_a', name: '工具' },
        { id: 'g_a', name: '重复' },
        { id: 'bad', name: '前缀不对' },
        { id: UNGROUPED, name: '假装是未分组' },
        { id: 'g_b', name: '  ' },
      ],
    });
    eq(out.groups, [{ id: 'g_a', name: '工具' }, { id: 'g_b', name: '未命名分组' }], '只剩两个合法分组');
  });

  t('layout :: 指向不存在分组的归属被丢弃', () => {
    const out = normalizeLayout({
      groups: [{ id: 'g_a', name: 'A' }],
      assignments: { 'user-dsh::x': 'g_a', 'user-dsh::y': 'g_gone', 'user-dsh::z': 'bad' },
    });
    eq(out.assignments, { 'user-dsh::x': 'g_a' }, '悬空引用被清掉');
  });

  t('layout :: order 去重且保持首次出现位置', () => {
    const out = normalizeLayout({ order: ['a', 'b', 'a', '', 42, 'c', 'b'] });
    eq(out.order, ['a', 'b', 'c'], '只留字符串且去重');
  });

  t('layout :: knownKeys 会过滤已消失的技能', () => {
    const out = normalizeLayout(
      {
        groups: [{ id: 'g_a', name: 'A' }],
        assignments: { 'k::live': 'g_a', 'k::dead': 'g_a' },
        order: ['k::dead', 'k::live'],
      },
      { knownKeys: new Set(['k::live']) },
    );
    eq(out.assignments, { 'k::live': 'g_a' }, '归属');
    eq(out.order, ['k::live'], '顺序');
  });

  /* ---------------- 归属 ---------------- */

  t('layout :: groupOf 悬空引用退回未分组', () => {
    const layout = { groups: [{ id: 'g_a', name: 'A' }], assignments: { 'k::1': 'g_a', 'k::2': 'g_gone' }, order: [] };
    eq(groupOf(layout, 'k::1'), 'g_a', '有归属');
    eq(groupOf(layout, 'k::2'), UNGROUPED, '悬空');
    eq(groupOf(layout, 'k::3'), UNGROUPED, '没记录');
    eq(groupOf(emptyLayout(), 'k::1'), UNGROUPED, '空布局');
  });

  /* ---------------- 排序 ---------------- */

  t('layout :: 按 order 排序，未排名的稳定落在最后', () => {
    const skills = [skill('a'), skill('b'), skill('c'), skill('d')];
    const layout = { groups: [], assignments: {}, order: ['user-dsh::c', 'user-dsh::a'] };
    eq(sortSkills(skills, layout, keyOf).map((s) => s.name), ['c', 'a', 'b', 'd'], '排过序的在前');
  });

  t('layout :: 没有 order 时保持原始顺序', () => {
    const skills = [skill('a'), skill('b')];
    eq(sortSkills(skills, emptyLayout(), keyOf).map((s) => s.name), ['a', 'b'], '不变');
    eq(sortSkills(skills, null, keyOf).map((s) => s.name), ['a', 'b'], 'null 布局也不炸');
  });

  /* ---------------- 分组 ---------------- */

  t('layout :: 空分组也保留，未分组永远在最后', () => {
    const skills = [skill('x'), skill('y')];
    const layout = {
      groups: [{ id: 'g_a', name: 'A' }, { id: 'g_empty', name: '空组' }],
      assignments: { 'user-dsh::y': 'g_a' },
      order: ['user-dsh::x', 'user-dsh::y'],
    };
    const groups = groupSkills(skills, layout, keyOf);
    eq(groups.map((g) => g.id), ['g_a', 'g_empty', UNGROUPED], '组顺序');
    eq(groups[0].skills.map((s) => s.name), ['y'], 'A 组内容');
    eq(groups[1].skills, [], '空组存在');
    eq(groups[2].skills.map((s) => s.name), ['x'], '未分组');
  });

  t('layout :: 没有未分组技能时不显示未分组组', () => {
    const skills = [skill('x')];
    const layout = { groups: [{ id: 'g_a', name: 'A' }], assignments: { 'user-dsh::x': 'g_a' }, order: [] };
    eq(groupSkills(skills, layout, keyOf).map((g) => g.id), ['g_a'], '不含未分组');
  });

  t('layout :: 分组顺序由 groups 数组决定，与技能顺序无关', () => {
    const skills = [skill('x'), skill('y')];
    const layout = {
      groups: [{ id: 'g_b', name: 'B' }, { id: 'g_a', name: 'A' }],
      assignments: { 'user-dsh::x': 'g_a', 'user-dsh::y': 'g_b' },
      order: ['user-dsh::x', 'user-dsh::y'],
    };
    eq(groupSkills(skills, layout, keyOf).map((g) => g.id), ['g_b', 'g_a'], 'B 在前');
  });

  /* ---------------- 移动 ---------------- */

  t('layout :: moveKey 移到目标之前', () => {
    eq(moveKey(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b'], '把 c 提到最前');
  });

  t('layout :: moveKey 移到目标之后', () => {
    eq(moveKey(['a', 'b', 'c'], 'a', 'c', { after: true }), ['b', 'c', 'a'], '把 a 放到最后');
  });

  t('layout :: moveKey 目标不存在时落到末尾', () => {
    eq(moveKey(['a', 'b'], 'a', '不存在'), ['b', 'a'], '末尾');
  });

  t('layout :: moveKey 自己移到自己不变', () => {
    eq(moveKey(['a', 'b', 'c'], 'b', 'b'), ['a', 'b', 'c'], '不变');
  });

  t('layout :: moveKey 原数组不被修改', () => {
    const input = ['a', 'b', 'c'];
    moveKey(input, 'c', 'a');
    eq(input, ['a', 'b', 'c'], '入参只读');
  });

  /* ---------------- 跨组 + 分组重建（拖放最容易错的组合） ---------------- */

  /**
   * 复刻界面在「跨组拖放」时的两段式计算：
   *   1) 按新的归属重建全局 order；
   *   2) 再按目标位置插入一次。
   * 第 2 步是必须的，否则技能会落到目标组的末尾而不是用户放下它的位置。
   */
  const rebuildAndInsert = (skills, groups, assignments, source, target, after) => {
    const keys = skills.map(keyOf);
    const inGroup = new Set();
    const listing = [];
    for (const group of groups) {
      for (const key of keys) {
        if (assignments[key] === group.id) {
          listing.push(key);
          inGroup.add(key);
        }
      }
    }
    for (const key of keys) if (!inGroup.has(key)) listing.push(key);
    return moveKey(listing, source, target, { after });
  };

  t('layout :: 跨组拖到目标之前 —— 落在目标前，不是组末尾', () => {
    const skills = [skill('a'), skill('b'), skill('c'), skill('d')];
    const groups = [{ id: 'g_1', name: 'A组' }, { id: 'g_2', name: 'B组' }];
    // b、c 在 A 组；a、d 未分组
    const assignments = { 'user-dsh::b': 'g_1', 'user-dsh::c': 'g_1' };
    // 把未分组的 d 拖到 B 组内的 c 之前
    const moved = { ...assignments, 'user-dsh::d': 'g_2' };
    const out = rebuildAndInsert(skills, groups, moved, 'user-dsh::d', 'user-dsh::c', false);
    eq(out, ['user-dsh::b', 'user-dsh::d', 'user-dsh::c', 'user-dsh::a'], 'd 落在 c 之前');
  });

  t('layout :: 跨组拖到目标之后 —— 落在目标后', () => {
    const skills = [skill('a'), skill('b'), skill('c')];
    const groups = [{ id: 'g_1', name: 'A组' }];
    const moved = { 'user-dsh::a': 'g_1', 'user-dsh::b': 'g_1' };
    const out = rebuildAndInsert(skills, groups, moved, 'user-dsh::c', 'user-dsh::b', true);
    eq(out, ['user-dsh::a', 'user-dsh::b', 'user-dsh::c'], 'c 落在 b 之后');
  });

  t('layout :: 只有重建没有插入时，技能会掉到组末尾（回归用例）', () => {
    const skills = [skill('a'), skill('b'), skill('c'), skill('d')];
    const groups = [{ id: 'g_1', name: 'A组' }];
    const moved = { 'user-dsh::d': 'g_1' };
    // 只重建、不做第 2 步插入：d 进入 A 组后会排在组内末尾（c 之后）
    const rebuilt = rebuildAndInsert(skills, groups, moved, 'user-dsh::d', 'user-dsh::d', false);
    eq(rebuilt, ['user-dsh::d', 'user-dsh::a', 'user-dsh::b', 'user-dsh::c'], '这是"只重建"的结果');
    // 补上第 2 步插入后，d 才落在用户放下的位置（b 之前）
    const inserted = rebuildAndInsert(skills, groups, moved, 'user-dsh::d', 'user-dsh::b', false);
    eq(inserted, ['user-dsh::a', 'user-dsh::d', 'user-dsh::b', 'user-dsh::c'], '插入后才落在目标位置');
  });

  t('layout :: 拖到自己身上不产生新顺序', () => {
    const keys = ['a', 'b'];
    eq(moveKey(keys, 'a', 'a'), ['a', 'b'], '不变');
    eq(moveKey(keys, 'a', 'a', { after: true }), ['a', 'b'], 'after 也不变');
  });

  t('layout :: 空列表与单元素列表不炸', () => {
    eq(moveKey([], 'a', 'b'), [], '空');
    eq(moveKey(['a'], 'a', 'b'), ['a'], '单元素，目标不存在');
  });

  /* ---------------- 提交校验 ---------------- */

  t('layout :: parseLayoutPatch 拒绝非法输入', () => {
    eq(parseLayoutPatch(null).ok, false, 'null');
    eq(parseLayoutPatch({}).ok, false, '空对象');
    eq(parseLayoutPatch({ groups: 'x' }).ok, false, 'groups 非数组');
    eq(parseLayoutPatch({ groups: [{ name: '' }] }).ok, false, '空名');
    eq(parseLayoutPatch({ groups: [{ id: 'bad', name: 'x' }] }).ok, false, 'id 前缀');
    eq(parseLayoutPatch({ groups: [{ id: 'g_a', name: 'x' }, { id: 'g_a', name: 'y' }] }).ok, false, 'id 重复');
    // 只在**同时**提交 groups 时才能校验引用：单独提交 assignments 时分组在磁盘上，
    // 提前拒绝会让"只改归属"这条最常用的路径失效。落盘清理负责兜底（见下一个用例）。
    eq(
      parseLayoutPatch({ groups: [{ id: 'g_a', name: 'x' }], assignments: { k: 'g_missing' } }).ok,
      false,
      '同批提交时可校验',
    );
    eq(parseLayoutPatch({ assignments: { k: 42 } }).ok, false, '值类型');
    eq(parseLayoutPatch({ order: 'x' }).ok, false, 'order 非数组');
  });

  t('layout :: 只提交 assignments 时，指向不存在分组的值落盘后被清掉', async () => {
    const store = createPolicyStore({ dataDir: await makeTempDir('layout-dangling') });
    await store.setLayout({ groups: [{ id: 'g_keep', name: '真组' }] });
    const saved = await store.setLayout({ assignments: { 'k::1': 'g_keep', 'k::2': 'g_missing' } });
    eq(saved.assignments, { 'k::1': 'g_keep' }, '悬空引用没落盘');
    eq((await store.layout()).assignments, { 'k::1': 'g_keep' }, '读回来也干净');
  });

  t('layout :: parseLayoutPatch 接受合法输入并补 id', () => {
    const result = parseLayoutPatch({
      groups: [{ name: '新组' }, { id: 'g_keep', name: '旧组' }],
      assignments: { 'k::1': null, 'k::2': 'g_keep' },
      order: ['k::2', 'k::1'],
    });
    if (!result.ok) throw new Error(`应通过：${result.message}`);
    eq(result.patch.groups.length, 2, '两组');
    if (!result.patch.groups[0].id.startsWith('g_')) throw new Error('缺省 id 应自动生成');
    eq(result.patch.groups[1].id, 'g_keep', '已有 id 保留');
    eq(result.patch.assignments, { 'k::2': 'g_keep' }, 'null 表示移出分组');
    eq(result.patch.order, ['k::2', 'k::1'], '顺序');
  });

  t('layout :: parseLayoutPatch 只传一个字段也可通过', () => {
    const onlyOrder = parseLayoutPatch({ order: ['a'] });
    eq(onlyOrder.ok, true, '只有 order');
    eq(Object.keys(onlyOrder.patch), ['order'], '不含其它字段');
    const onlyAssign = parseLayoutPatch({ assignments: {} });
    eq(onlyAssign.ok, true, '只有 assignments（清空）');
  });

  t('layout :: newGroupId 不重复', () => {
    const a = newGroupId();
    const b = newGroupId([a]);
    if (a === b) throw new Error('两次生成相同 id');
    if (!a.startsWith('g_')) throw new Error('前缀不对');
  });

  t('layout :: orderFromKeys 过滤非字符串', () => {
    eq(orderFromKeys(['a', null, 'b', 3, '', 'a']), ['a', 'b'], '只剩合法');
    eq(orderFromKeys('not-an-array'), [], '入参不是数组');
  });

  /* ---------------- 状态存储往返 ---------------- */

  t('layout :: 存储往返 —— 分组/排序都能读回', async () => {
    const store = createPolicyStore({ dataDir: await makeTempDir('layout') });
    await store.setLayout({
      groups: [{ name: '工具' }, { name: '流程' }],
      assignments: { 'user-dsh::a': null },
      order: ['user-dsh::a'],
    });
    const layout1 = await store.layout();
    const toolId = layout1.groups[0].id;
    await store.setLayout({ assignments: { 'user-dsh::a': toolId } });
    const back = await store.layout();
    eq(back.groups.map((g) => g.name), ['工具', '流程'], '分组顺序保留');
    eq(back.assignments, { 'user-dsh::a': toolId }, '归属保留');
    eq(back.order, ['user-dsh::a'], '顺序保留');
  });

  t('layout :: 删除分组会连带清掉归属', async () => {
    const store = createPolicyStore({ dataDir: await makeTempDir('layout-del') });
    await store.setLayout({ groups: [{ name: 'A' }], assignments: { 'k::1': null } });
    const created = await store.layout();
    const gid = created.groups[0].id;
    await store.setLayout({ assignments: { 'k::1': gid } });
    await store.setLayout({ groups: [] });
    const after = await store.layout();
    eq(after.groups, [], '分组已删');
    eq(after.assignments, {}, '归属已清');
  });

  t('layout :: 写布局不会碰策略覆盖', async () => {
    const store = createPolicyStore({ dataDir: await makeTempDir('layout-iso') });
    await store.setPolicy('user-dsh', '重要技能', 'disabled', { path: 'C:/x/SKILL.md' });
    await store.setLayout({ groups: [{ name: 'A' }], order: ['user-dsh::重要技能'] });
    const { policy: policyId } = await store.get('user-dsh', '重要技能');
    eq(policyId, 'disabled', '策略仍在');
  });

  t('layout :: 老版本 state.json（无 layout 字段）读进来仍是空布局', async () => {
    const { writeJsonAtomic } = await import('../lib/core/fsx.js');
    const path = await import('node:path');
    const dir = await makeTempDir('layout-legacy');
    await writeJsonAtomic(path.join(dir, 'state.json'), {
      version: 1,
      overrides: { 'user-dsh': { 旧技能: { policy: 'disabled', updatedAt: 1 } } },
      importSources: {},
      settings: {},
      updatedAt: 1,
    });
    const store = createPolicyStore({ dataDir: dir });
    eq(await store.layout(), emptyLayout(), '空布局');
    const { policy: policyId } = await store.get('user-dsh', '旧技能');
    eq(policyId, 'disabled', '老策略没丢');
  });

  t('layout :: pruneLayout 清掉消失技能的排序与归属', async () => {
    const store = createPolicyStore({ dataDir: await makeTempDir('layout-prune') });
    await store.setLayout({
      groups: [{ name: 'A' }],
      assignments: { 'k::dead': null },
      order: ['k::dead', 'k::live'],
    });
    const layout = await store.layout();
    const gid = layout.groups[0].id;
    await store.setLayout({ assignments: { 'k::dead': gid } });

    const changed = await store.pruneLayout(new Set(['k::live']));
    eq(changed, true, '确实改了');
    const after = await store.layout();
    eq(after.order, ['k::live'], '顺序清掉死键');
    eq(after.assignments, {}, '归属清掉死键');
    eq(after.groups.length, 1, '分组本身不动');

    const again = await store.pruneLayout(new Set(['k::live']));
    eq(again, false, '再跑一次无变化');
  });
}
