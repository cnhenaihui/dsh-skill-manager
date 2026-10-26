import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  parseSkillDocument,
  splitFrontmatter,
  scanTopLevelKeys,
  setTopLevelScalar,
  removeTopLevelKey,
  applyPolicyToSource,
  createSkillDocument,
  parseFrontmatterBoolean,
  isSkillName,
  policyIdOf,
} from '../lib/core/frontmatter.js';
import { dshHome } from './helpers.js';

const REAL = path.join(dshHome(), 'skills');

async function readReal(name) {
  return fs.readFile(path.join(REAL, name, 'SKILL.md'), 'utf8');
}

export default function register(t) {
  t('合法/非法技能名', async () => {
    assert.equal(isSkillName('srs-generator'), true);
    assert.equal(isSkillName('a'), true);
    assert.equal(isSkillName('grill-me'), true);
    assert.equal(isSkillName('SRS-Generator'), false);
    assert.equal(isSkillName('srs_generator'), false);
    assert.equal(isSkillName('-srs'), false);
    assert.equal(isSkillName('srs--generator'), false);
    assert.equal(isSkillName('srs.'), false);
    assert.equal(isSkillName(''), false);
  });

  t('布尔解析与官方一致（宽松枚举）', async () => {
    for (const v of ['true', 'yes', 'on', '1']) assert.equal(parseFrontmatterBoolean(v), true, v);
    for (const v of ['false', 'no', 'off', '0']) assert.equal(parseFrontmatterBoolean(v), false, v);
    assert.equal(parseFrontmatterBoolean('TRUE'), true);
    assert.equal(parseFrontmatterBoolean('Off'), false);
    assert.equal(parseFrontmatterBoolean(1, 'plain'), true);
    assert.equal(parseFrontmatterBoolean(0, 'plain'), false);
    assert.equal(parseFrontmatterBoolean('maybe').invalid, true);
    assert.equal(parseFrontmatterBoolean(null), undefined);
  });

  t('四档策略推断', async () => {
    assert.equal(policyIdOf({ modelInvocable: true, userInvocable: true }), 'enabled');
    assert.equal(policyIdOf({ modelInvocable: true, userInvocable: false }), 'modelOnly');
    assert.equal(policyIdOf({ modelInvocable: false, userInvocable: true }), 'userOnly');
    assert.equal(policyIdOf({ modelInvocable: false, userInvocable: false }), 'disabled');
  });

  t('缺 frontmatter / 未闭合 / 无键', async () => {
    assert.equal(parseSkillDocument('# 没有 frontmatter').code, 'missing-frontmatter');
    assert.equal(parseSkillDocument('---\nname: a\n').code, 'unterminated-frontmatter');
    assert.equal(parseSkillDocument('---\n---\n正文').code, 'invalid-frontmatter');
  });

  t('必填键与 camelCase 旧键的拒绝行为', async () => {
    assert.equal(parseSkillDocument('---\nname: demo\n---\n').code, 'missing-description');
    assert.equal(parseSkillDocument('---\ndescription: x\n---\n').code, 'missing-name');
    const bad = parseSkillDocument('---\nname: Demo\ndescription: x\n---\n');
    assert.equal(bad.code, 'invalid-name');
    const legacy = parseSkillDocument('---\nname: demo\ndescription: x\ndisableModelInvocation: true\n---\n');
    assert.equal(legacy.code, 'legacy-invocation-key');
    assert.equal(legacy.key, 'disableModelInvocation');
    const legacy2 = parseSkillDocument('---\nname: demo\ndescription: x\nuserInvocable: false\n---\n');
    assert.equal(legacy2.code, 'legacy-invocation-key');
    const badBool = parseSkillDocument('---\nname: demo\ndescription: x\nuser-invocable: maybe\n---\n');
    assert.equal(badBool.code, 'invalid-boolean');
  });

  t('调用策略默认值与 CRLF 兼容', async () => {
    const def = parseSkillDocument('---\r\nname: demo\r\ndescription: 演示\r\n---\r\n\r\n正文\r\n');
    assert.equal(def.ok, true);
    assert.deepEqual(def.skill.invocation, { modelInvocable: true, userInvocable: true });
    assert.equal(def.skill.content, '正文');
    const off = parseSkillDocument('---\nname: demo\ndescription: x\ndisable-model-invocation: yes\nuser-invocable: "off"\n---\n');
    assert.equal(off.ok, true);
    assert.deepEqual(off.skill.invocation, { modelInvocable: false, userInvocable: false });
    assert.equal(off.skill.policyId, 'disabled');
  });

  t('块标量折叠（> 与 |）', async () => {
    const folded = parseSkillDocument('---\nname: demo\ndescription: >\n  第一行\n  第二行\n\n  第三行\n---\n正文');
    assert.equal(folded.ok, true);
    assert.match(folded.skill.description, /第一行/);
    assert.match(folded.skill.description, /第三行/);
    const literal = parseSkillDocument('---\nname: demo\ndescription: |\n  甲\n  乙\n---\n');
    assert.equal(literal.ok, true);
    assert.equal(literal.skill.description, '甲\n乙\n');
  });

  t('引号标量', async () => {
    const dq = parseSkillDocument('---\nname: demo\ndescription: "含: 冒号 #井号"\n---\n');
    assert.equal(dq.ok, true);
    assert.equal(dq.skill.description, '含: 冒号 #井号');
    const sq = parseSkillDocument("---\nname: demo\ndescription: 'it''s ok'\n---\n");
    assert.equal(sq.ok, true);
    assert.equal(sq.skill.description, "it's ok");
  });

  t('未知键被保留且计入诊断', async () => {
    const doc = parseSkillDocument('---\nname: demo\ndescription: x\nagent_created: true\nlicense: MIT\n---\n');
    assert.equal(doc.ok, true);
    assert.deepEqual(doc.skill.extraKeys.sort(), ['agent_created', 'license']);
    assert.equal(doc.diagnostics.length, 2);
  });

  t('metadata 浅层解析（标量形式被忽略）', async () => {
    const withMeta = parseSkillDocument('---\nname: demo\ndescription: x\nmetadata:\n  author: 张三\n  version: 1.2.0\n---\n');
    assert.equal(withMeta.ok, true);
    assert.deepEqual(withMeta.skill.metadata, { author: '张三', version: '1.2.0' });
    const scalar = parseSkillDocument('---\nname: demo\ndescription: x\nmetadata: 不是对象\n---\n');
    assert.equal(scalar.ok, true);
    assert.equal(scalar.skill.metadata, undefined);
  });

  t('手术式编辑：替换/新增/删除，其余字节不变', async () => {
    const original = '---\n# 手写注释\nname: demo\ndescription: 原始\nagent_created: true\nlicense: MIT\n---\n\n正文\n';
    const changed = setTopLevelScalar(original, 'description', '改过的说明');
    assert.match(changed, /description: 改过的说明/);
    assert.match(changed, /# 手写注释/);
    assert.match(changed, /agent_created: true/);
    assert.match(changed, /license: MIT/);
    assert.match(changed, /\n正文\n$/);
    const added = setTopLevelScalar(original, 'user-invocable', 'false');
    assert.match(added, /user-invocable: false/);
    assert.equal(parseSkillDocument(added).skill.invocation.userInvocable, false);
    const removed = removeTopLevelKey(added, 'user-invocable');
    assert.equal(removed, original);
    const untouched = removeTopLevelKey(original, 'not-exist');
    assert.equal(untouched, original);
  });

  t('四档策略写回源文件后仍可被解析', async () => {
    let raw = '---\nname: demo\ndescription: 演示\n---\n\n正文\n';
    for (const policy of ['modelOnly', 'userOnly', 'disabled', 'enabled']) {
      raw = applyPolicyToSource(raw, policy);
      const parsed = parseSkillDocument(raw);
      assert.equal(parsed.ok, true, `${policy} 应可解析：${raw}`);
      assert.equal(parsed.skill.policyId, policy, policy);
      assert.match(raw, /正文/);
    }
    assert.equal(raw, '---\nname: demo\ndescription: 演示\n---\n\n正文\n');
  });

  t('脚手架生成 → 解析闭环（含需要引号的描述）', async () => {
    const raw = createSkillDocument({
      name: 'demo-skill',
      description: '含: 冒号、#井号 "引号" 与换行的描述',
      whenToUse: '当需要演示时',
      policyId: 'userOnly',
      body: '# Demo\n\n内容',
    });
    const parsed = parseSkillDocument(raw);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.skill.name, 'demo-skill');
    assert.equal(parsed.skill.description, '含: 冒号、#井号 "引号" 与换行的描述');
    assert.equal(parsed.skill.whenToUse, '当需要演示时');
    assert.equal(parsed.skill.policyId, 'userOnly');
    assert.equal(parsed.skill.content, '# Demo\n\n内容');
  });

  t('真实技能库：13 个技能全部可解析且名字合法', async () => {
    const entries = await fs.readdir(REAL, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    assert.ok(dirs.length >= 13, `期望至少 13 个技能目录，实际 ${dirs.length}`);
    for (const name of dirs) {
      const raw = await readReal(name);
      const parsed = parseSkillDocument(raw, { path: path.join(REAL, name, 'SKILL.md') });
      assert.equal(parsed.ok, true, `${name} 解析失败：${parsed.code} ${parsed.message}`);
      assert.equal(parsed.skill.name, name, `${name} 的 frontmatter name 与目录名不一致`);
      assert.ok(parsed.skill.description.length > 0);
      assert.ok(parsed.skill.content.length > 0, `${name} 正文为空`);
    }
  });

  t('真实技能库：已知特例（折叠描述 / 未知键 / 用户专用）', async () => {
    const hyper = parseSkillDocument(await readReal('hyperframes-cli'));
    assert.equal(hyper.ok, true);
    assert.ok(hyper.skill.description.length > 100, '折叠块描述应被完整读出');

    const baa = parseSkillDocument(await readReal('baa-generator'));
    assert.equal(baa.ok, true);
    assert.ok(baa.skill.extraKeys.includes('agent_created'), '应识别出未知键 agent_created');
    assert.ok(baa.skill.description.includes('业务架构分析报告'));

    const grillMe = parseSkillDocument(await readReal('grill-me'));
    assert.equal(grillMe.ok, true);
    assert.equal(grillMe.skill.invocation.modelInvocable, false);
    assert.equal(grillMe.skill.invocation.userInvocable, true);
    assert.equal(grillMe.skill.policyId, 'userOnly');
  });

  t('切分与顶层键扫描的偏移正确', async () => {
    const raw = '---\nname: demo\ndescription: x\n---\n正文';
    const split = splitFrontmatter(raw);
    assert.equal(split.ok, true);
    assert.equal(split.frontmatter.text, 'name: demo\ndescription: x\n');
    assert.equal(split.body.text, '正文');
    const keys = scanTopLevelKeys(split.frontmatter.text).map((k) => k.key);
    assert.deepEqual(keys, ['name', 'description']);
  });
}
