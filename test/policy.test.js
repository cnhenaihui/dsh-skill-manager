import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createPolicyStore,
  planLegacyMigration,
  parseLegacyState,
  applyLegacyMigration,
  legacySourceKey,
  emptyState,
  normalizeState,
  FOLLOW_FILE,
  LEGACY_DEFAULT_PATH,
} from '../lib/core/policy.js';
import { makeTempDir, dshHome, writeText, pathExists } from './helpers.js';

export default function register(t) {
  t('默认跟随文件；设置后进入覆盖表', async () => {
    const base = await makeTempDir('policy-basic');
    const store = createPolicyStore({ dataDir: base });
    assert.equal((await store.get('user-dsh', 'demo')).policy, FOLLOW_FILE);

    await store.setPolicy('user-dsh', 'demo', 'disabled', { path: 'C:/x/demo/SKILL.md', officialRank: 400 });
    const got = await store.get('user-dsh', 'demo');
    assert.equal(got.policy, 'disabled');
    assert.equal(got.entry.officialRank, 400);

    const all = await store.overrides();
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'demo');

    await store.setPolicy('user-dsh', 'demo', FOLLOW_FILE);
    assert.equal((await store.get('user-dsh', 'demo')).policy, FOLLOW_FILE);
    assert.equal((await store.overrides()).length, 0);
  });

  t('未知策略被拒绝，状态文件可持久化重读', async () => {
    const base = await makeTempDir('policy-persist');
    const store = createPolicyStore({ dataDir: base });
    await assert.rejects(() => store.setPolicy('user-dsh', 'demo', 'bogus'), /未知策略/);
    await store.setPolicy('user-dsh', 'demo', 'modelOnly');
    assert.equal(await pathExists(store.statePath), true);

    const reopened = createPolicyStore({ dataDir: base });
    assert.equal((await reopened.get('user-dsh', 'demo')).policy, 'modelOnly');

    // 版本不匹配 → 退空状态（不抛错）
    await writeText(store.statePath, JSON.stringify({ version: 99, overrides: { x: { y: { policy: 'disabled' } } } }));
    const gated = createPolicyStore({ dataDir: base });
    assert.deepEqual(await gated.overrides(), []);
  });

  t('prune 清理失效记录（避免名字被永久锁死）', async () => {
    const base = await makeTempDir('policy-prune');
    const store = createPolicyStore({ dataDir: base });
    await store.setPolicy('user-dsh', 'gone', 'disabled');
    await store.setPolicy('user-dsh', 'kept', 'disabled');
    await store.setPolicy('user-dsh', 'withpath', 'disabled', { path: 'C:/somewhere/SKILL.md' });
    const removed = await store.prune(new Set(['user-dsh::kept']));
    assert.deepEqual(removed.map((r) => r.name), ['gone']);
    const left = (await store.overrides()).map((o) => o.name).sort();
    assert.deepEqual(left, ['kept', 'withpath']);
  });

  t('导入来源开关', async () => {
    const base = await makeTempDir('policy-sources');
    const store = createPolicyStore({ dataDir: base });
    await store.setImportSource('trae-cn', false);
    await store.setImportSource('claude', true);
    assert.deepEqual(await store.importSources(), { 'trae-cn': false, claude: true });
  });

  t('旧插件状态：解析与迁移预览（只规划不自动应用）', async () => {
    const legacyRaw = {
      version: 1,
      sources: { dsh: true, 'trae-cn': false },
      disabledSkills: { dsh: ['baa-generator', 'srs-generator'], claude: ['x'] },
      enabledSkills: { dsh: [], claude: [] },
    };
    const legacy = parseLegacyState(legacyRaw);
    assert.ok(legacy);
    assert.equal(legacySourceKey('dsh'), 'user-dsh');
    assert.equal(legacySourceKey('claude'), 'import:claude');

    const plan = planLegacyMigration(legacy, {
      knownSkills: [{ sourceKey: 'user-dsh', name: 'baa-generator' }],
    });
    assert.equal(plan.summary.total, 3);
    assert.equal(plan.summary.willDisable, 3);
    assert.equal(plan.summary.unknown, 2);
    assert.ok(plan.summary.warning, '应提示"直接应用会让技能消失"');

    // onlyKnown：只应用确实存在的技能
    const base = await makeTempDir('policy-legacy');
    const store = createPolicyStore({ dataDir: base });
    const applied = await applyLegacyMigration(store, plan, { onlyKnown: true });
    assert.equal(applied.length, 1);
    assert.equal((await store.get('user-dsh', 'baa-generator')).policy, 'disabled');
    assert.equal((await store.get('user-dsh', 'srs-generator')).policy, FOLLOW_FILE);
  });

  t('本机真实旧状态可解析（若存在）且包含风险提示', async () => {
    const legacyPath = LEGACY_DEFAULT_PATH(dshHome());
    if (!(await pathExists(legacyPath))) return; // 没有旧状态就跳过
    const raw = JSON.parse(await fs.readFile(legacyPath, 'utf8'));
    const legacy = parseLegacyState(raw);
    if (!legacy) return;
    const plan = planLegacyMigration(legacy, { knownSkills: [] });
    assert.ok(plan.summary.total >= 0);
    if (plan.summary.willDisable > 0) {
      assert.ok(plan.summary.warning);
    }
  });

  t('state 规范化：坏数据退空状态', async () => {
    assert.deepEqual(normalizeState(null), emptyState());
    assert.deepEqual(normalizeState({ version: 1, overrides: 'oops' }).overrides, {});
  });
}
