/**
 * frontmatter.js —— 零依赖的 SKILL.md frontmatter 解析与"手术式"编辑
 *
 * 为什么不用 YAML 库：插件走 junction 安装进 profile 的 node_modules，Node 默认按
 * realpath（工作区）解析模块，import 'js-yaml' 找不到。而写一份完整 YAML 解析器
 * 既没必要也不安全。
 *
 * 本模块的策略是「只做两件事」：
 *   1. 读取：行式、缩进感知地扫描顶层键，只解析出官方认可的 6 个键
 *      （name / description / whenToUse / disable-model-invocation / user-invocable / metadata）。
 *   2. 编辑：不做反序列化重写，而是对原文做**手术式替换**（替换/删除某个顶层键的整块），
 *      因此未知键（agent_created、license、allowed-tools…）、注释、缩进、引号风格、
 *      CRLF 全部原样保留 —— 这一点很重要：官方解析器会静默忽略未知键，但我们绝不能
 *      因为一次"启用/停用"就把用户手写的字段洗掉。
 *
 * 与官方 dsh-skill-filesystem 对齐的规则（见其 lib/index.js:664-705, 780-806, 841-883）：
 *   - 首行必须恰好是 `---`（允许 CRLF），闭合定界符必须独占一行。
 *   - `name` 必填，且必须匹配 kebab-case：/^[a-z0-9]+(?:-[a-z0-9]+)*$/
 *   - `description` 必填且非空。
 *   - 布尔键宽松解析：true/false、1/0（数字或字符串）、"true"/"yes"/"on"、
 *     "false"/"no"/"off"（大小写不敏感）。其它值 → 整个技能被丢弃。
 *   - 三个 camelCase 旧键（disableModelInvocation / modelInvocable / userInvocable）
 *     会被**显式拒绝**，同样导致整个技能被丢弃 —— 我们的编辑器必须挡住它们。
 *   - 调用语义：modelInvocable = (disable-model-invocation !== true)
 *               userInvocable  = (user-invocable !== false)
 */

/** 官方使用的技能名正则（dsh-skill/lib/index.js:17） */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 官方解析器实际读取的 6 个键 */
export const SUPPORTED_KEYS = Object.freeze([
  'name',
  'description',
  'whenToUse',
  'disable-model-invocation',
  'user-invocable',
  'metadata',
]);

/** 官方已废弃、且会让整个技能被丢弃的 camelCase 旧键 → 建议替代键 */
export const LEGACY_KEY_ALIASES = Object.freeze({
  disableModelInvocation: 'disable-model-invocation',
  modelInvocable: 'disable-model-invocation',
  userInvocable: 'user-invocable',
});

export const REQUIRED_KEYS = Object.freeze(['name', 'description']);

/** 四档策略 → 官方 invocation 两布尔 */
export const POLICY = Object.freeze({
  enabled: { modelInvocable: true, userInvocable: true },
  modelOnly: { modelInvocable: true, userInvocable: false },
  userOnly: { modelInvocable: false, userInvocable: true },
  disabled: { modelInvocable: false, userInvocable: false },
});

export function isSkillName(name) {
  return typeof name === 'string' && SKILL_NAME_RE.test(name);
}

/** invocation → 四档策略 id */
export function policyIdOf(invocation) {
  const model = invocation?.modelInvocable !== false;
  const user = invocation?.userInvocable !== false;
  if (model && user) return 'enabled';
  if (model && !user) return 'modelOnly';
  if (!model && user) return 'userOnly';
  return 'disabled';
}

/* ------------------------------------------------------------------ *
 * 1. 行索引与 frontmatter 切分
 * ------------------------------------------------------------------ */

/**
 * 把文本切成带绝对偏移的行。
 * 返回 [{ text, start, end, eol }]，end 指向行尾（不含换行符），eol 是换行符长度（0/1/2）。
 */
function indexLines(text) {
  const lines = [];
  let pos = 0;
  while (pos <= text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = text.length;
    let content = text.slice(pos, nl);
    let eol = 1;
    if (nl === text.length) eol = 0;
    if (content.endsWith('\r')) {
      content = content.slice(0, -1);
      eol += 1;
    }
    lines.push({ text: content, start: pos, end: pos + content.length, eol });
    if (nl === text.length) break;
    pos = nl + 1;
  }
  return lines;
}

/**
 * 切出 frontmatter 区域。
 * @returns {{ok:true, lines, frontmatter:{text,start,end}, body:{text,start,end}}}
 *        | {ok:false, code, message}
 */
export function splitFrontmatter(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'not-text', message: '技能文件内容不是文本' };
  }
  const text = raw.replace(/^\uFEFF/, '');
  const lines = indexLines(text);
  if (lines.length === 0 || lines[0].text !== '---') {
    return { ok: false, code: 'missing-frontmatter', message: '首行不是 "---"，缺少 YAML frontmatter' };
  }
  let closing = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].text === '---') {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    return { ok: false, code: 'unterminated-frontmatter', message: 'frontmatter 没有闭合的 "---" 行' };
  }
  const fmStart = lines[0].end + lines[0].eol;
  const fmEnd = lines[closing].start;
  const bodyStart = lines[closing].end + lines[closing].eol;
  return {
    ok: true,
    text,
    lines,
    frontmatter: {
      text: text.slice(fmStart, fmEnd),
      start: fmStart,
      end: fmEnd,
      eol: lines[0].eol === 0 ? 1 : lines[0].eol,
    },
    body: { text: text.slice(bodyStart), start: bodyStart },
  };
}

/* ------------------------------------------------------------------ *
 * 2. 顶层键扫描（缩进感知，保留原始文本）
 * ------------------------------------------------------------------ */

const KEY_LINE_RE = /^([A-Za-z0-9_.-]+)\s*:(?:\s*(.*))?$/;

/**
 * 扫描 frontmatter 的顶层键。
 * 返回 [{ key, valueText, raw, start, end }]，偏移相对 frontmatter 文本。
 * 缩进行属于上一个键的"块"（块标量正文、嵌套 map/list、多行流式值）。
 */
export function scanTopLevelKeys(frontmatterText) {
  const lines = indexLines(frontmatterText);
  const entries = [];
  let current = null;
  for (const line of lines) {
    const isIndented = /^[ \t]/.test(line.text);
    const isBlank = line.text.trim() === '';
    const isComment = !isIndented && line.text.trimStart().startsWith('#');
    const m = isIndented ? null : KEY_LINE_RE.exec(line.text);
    if (m) {
      if (current) entries.push(current);
      current = {
        key: m[1],
        valueText: (m[2] ?? '').trim(),
        raw: line.text,
        start: line.start,
        end: line.end + line.eol,
        blockLines: [],
      };
      continue;
    }
    if (current) {
      if (isIndented || isBlank) {
        current.blockLines.push(line);
        current.end = line.end + line.eol;
        continue;
      }
      // 顶层注释或无法识别的顶层行：结束当前块
      if (isComment) {
        entries.push(current);
        current = null;
        continue;
      }
      entries.push(current);
      current = null;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/* ------------------------------------------------------------------ *
 * 3. 标量/块标量的值解析（够用即可，不做完整 YAML）
 * ------------------------------------------------------------------ */

function stripCommonIndent(lines) {
  const indents = lines
    .filter((l) => l.trim() !== '')
    .map((l) => (l.match(/^[ \t]*/) ?? [''])[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

/** 解析块标量（>, >-, >+, |, |-, |+） */
function readBlockScalar(header, blockLines) {
  const style = header[0];
  const chomp = header.slice(1);
  let lines = stripCommonIndent(blockLines.map((l) => l.text));
  // 去掉首尾空行；`+` 保留尾随换行、`-` 去掉、默认 clip 补一个
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  let out;
  if (style === '|') {
    out = lines.join('\n');
  } else {
    // 折叠：普通换行变空格，空行变单个换行
    const parts = [];
    for (const l of lines) {
      if (l.trim() === '') parts.push('\n');
      else parts.push(l);
    }
    out = parts
      .join(' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n(?!\n)/g, ' ')
      .trim();
  }
  if (chomp !== '-') out += '\n';
  if (chomp === '-') out = out.replace(/\n+$/, '');
  return out;
}

/** 解析一个顶层键的值；返回 { value, kind } */
export function parseScalar(entry) {
  const raw = entry.valueText;
  if (raw === '' && entry.blockLines.length > 0) {
    // 形如 `metadata:` 后跟缩进块
    return { value: undefined, kind: 'block' };
  }
  if (/^[>|][+-]?$/.test(raw)) {
    return { value: readBlockScalar(raw, entry.blockLines), kind: raw[0] === '|' ? 'literal' : 'folded' };
  }
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    const inner = raw.slice(1, -1).replace(/\\(["\\/nrt])/g, (_, c) => {
      switch (c) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        default: return c;
      }
    });
    return { value: inner, kind: 'double-quoted' };
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return { value: raw.slice(1, -1).replace(/''/g, "'"), kind: 'single-quoted' };
  }
  if (raw === '~' || raw === 'null') return { value: null, kind: 'null' };
  return { value: raw, kind: 'plain' };
}

/** 官方的宽松布尔解析（dsh-skill-filesystem/lib/index.js:863-878） */
export function parseFrontmatterBoolean(rawValue, _kind = 'plain') {
  if (rawValue === undefined || rawValue === null) return undefined;
  if (typeof rawValue === 'boolean') return rawValue;
  if (rawValue === 1 || rawValue === '1') return true;
  if (rawValue === 0 || rawValue === '0') return false;
  if (typeof rawValue === 'string') {
    // 官方对字符串一律 toLowerCase 后比对（YAML 里 TRUE/Yes/OFF 都解析成字符串）
    switch (rawValue.toLowerCase()) {
      case 'true': case 'yes': case 'on': return true;
      case 'false': case 'no': case 'off': return false;
      default: return { invalid: true };
    }
  }
  return { invalid: true };
}

/* ------------------------------------------------------------------ *
 * 4. 文档级解析（供扫描/展示使用）
 * ------------------------------------------------------------------ */

/**
 * 解析一份 SKILL.md。
 * @returns {{ok:true, skill, diagnostics:string[]}} | {{ok:false, code, message, key?}}
 */
export function parseSkillDocument(raw, { path } = {}) {
  const split = splitFrontmatter(raw);
  if (!split.ok) return { ok: false, code: split.code, message: split.message };

  const entries = scanTopLevelKeys(split.frontmatter.text);
  if (entries.length === 0) {
    return { ok: false, code: 'invalid-frontmatter', message: 'frontmatter 里没有任何顶层键' };
  }
  const byKey = new Map();
  const diagnostics = [];
  for (const entry of entries) {
    if (LEGACY_KEY_ALIASES[entry.key]) {
      return {
        ok: false,
        code: 'legacy-invocation-key',
        key: entry.key,
        message: `frontmatter 使用了已废弃的 camelCase 键 "${entry.key}"，官方会因此丢弃整个技能；请改用 "${LEGACY_KEY_ALIASES[entry.key]}"`,
      };
    }
    if (!SUPPORTED_KEYS.includes(entry.key)) {
      diagnostics.push(`未知键 "${entry.key}"（官方解析器会静默忽略；本插件编辑时原样保留）`);
    }
    byKey.set(entry.key, entry);
  }

  const nameEntry = byKey.get('name');
  const name = nameEntry ? parseScalar(nameEntry).value : undefined;
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, code: 'missing-name', message: 'frontmatter 缺少必填键 name' };
  }
  if (!isSkillName(name)) {
    return {
      ok: false,
      code: 'invalid-name',
      key: 'name',
      message: `技能名 "${name}" 不是合法 kebab-case（只允许小写字母、数字与单个连字符）`,
    };
  }

  const descriptionEntry = byKey.get('description');
  const description = descriptionEntry ? parseScalar(descriptionEntry).value : undefined;
  if (typeof description !== 'string' || description.trim() === '') {
    return { ok: false, code: 'missing-description', message: 'frontmatter 缺少必填键 description（或为空）' };
  }

  const whenToUseEntry = byKey.get('whenToUse');
  const whenToUse = whenToUseEntry ? parseScalar(whenToUseEntry).value : undefined;

  const dmEntry = byKey.get('disable-model-invocation');
  const uiEntry = byKey.get('user-invocable');
  let disableModelInvocation;
  if (dmEntry) {
    const parsed = parseScalar(dmEntry);
    const v = parseFrontmatterBoolean(parsed.value, parsed.kind);
    if (v && v.invalid) {
      return { ok: false, code: 'invalid-boolean', key: 'disable-model-invocation', message: 'disable-model-invocation 不是合法布尔值' };
    }
    disableModelInvocation = v;
  }
  let userInvocable;
  if (uiEntry) {
    const parsed = parseScalar(uiEntry);
    const v = parseFrontmatterBoolean(parsed.value, parsed.kind);
    if (v && v.invalid) {
      return { ok: false, code: 'invalid-boolean', key: 'user-invocable', message: 'user-invocable 不是合法布尔值' };
    }
    userInvocable = v;
  }

  const metadataEntry = byKey.get('metadata');
  let metadata;
  if (metadataEntry) {
    // 只做浅层 k: v 提取；官方要求 metadata 是 object，标量会被静默丢弃
    const block = metadataEntry.valueText === '' ? metadataEntry.blockLines : [];
    if (block.length > 0) {
      const obj = {};
      for (const line of block) {
        const m = /^\s+([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line.text);
        if (m) obj[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
      if (Object.keys(obj).length > 0) metadata = obj;
    }
  }

  const content = split.body.text.trim();

  return {
    ok: true,
    diagnostics,
    skill: {
      name,
      description,
      whenToUse: typeof whenToUse === 'string' && whenToUse !== '' ? whenToUse : undefined,
      metadata,
      invocation: {
        modelInvocable: disableModelInvocation !== true,
        userInvocable: userInvocable !== false,
      },
      policyId: policyIdOf({
        modelInvocable: disableModelInvocation !== true,
        userInvocable: userInvocable !== false,
      }),
      content,
      path,
      frontmatter: split.frontmatter.text,
      extraKeys: entries.map((e) => e.key).filter((k) => !SUPPORTED_KEYS.includes(k)),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 5. 手术式编辑（保留原文一切其它内容）
 * ------------------------------------------------------------------ */

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** 给值加引号：只在必要时（含 YAML 特殊开头/结尾字符、含 ": "、含 #）。 */
export function quoteYamlScalar(value) {
  if (typeof value !== 'string') return String(value);
  const needsQuote =
    value === '' ||
    /^[\s]|[\s]$/.test(value) ||
    /^[![\]{}>|&*?%@`"'#,:-]/.test(value) ||
    value.includes(': ') ||
    value.includes(' #') ||
    /[\n\r\t]/.test(value);
  if (!needsQuote) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/**
 * 替换或新增一个顶层标量键（保持其余字节不变）。
 * @returns {string} 新的文件全文
 */
export function setTopLevelScalar(raw, key, value) {
  const split = splitFrontmatter(raw);
  if (!split.ok) throw new Error(`无法编辑：${split.message}`);
  const eol = detectEol(split.text);
  const rendered = `${key}: ${quoteYamlScalar(value)}${eol}`;
  const entries = scanTopLevelKeys(split.frontmatter.text);
  const hit = entries.find((e) => e.key === key);
  const fmStart = split.frontmatter.start;
  const fmEnd = split.frontmatter.end;
  if (hit) {
    const from = fmStart + hit.start;
    const to = fmStart + hit.end;
    return split.text.slice(0, from) + rendered + split.text.slice(to);
  }
  // 追加到 frontmatter 末尾（fmEnd 是闭合行 "---" 的起点）
  const insertAt = fmEnd;
  const prefix = insertAt > fmStart && split.text[insertAt - 1] === '\n' ? '' : eol;
  return split.text.slice(0, insertAt) + prefix + rendered + split.text.slice(insertAt);
}

/** 删除一个顶层键（连同它的整块与行尾换行）。不存在则原样返回。 */
export function removeTopLevelKey(raw, key) {
  const split = splitFrontmatter(raw);
  if (!split.ok) throw new Error(`无法编辑：${split.message}`);
  const entries = scanTopLevelKeys(split.frontmatter.text);
  const hit = entries.find((e) => e.key === key);
  if (!hit) return split.text;
  const fmStart = split.frontmatter.start;
  const from = fmStart + hit.start;
  const to = fmStart + hit.end;
  return split.text.slice(0, from) + split.text.slice(to);
}

/**
 * 把四档策略写进 frontmatter（官方语义）：
 *   enabled    → 删除两个键
 *   modelOnly  → 删除 disable-model-invocation，写 user-invocable: false
 *   userOnly   → 写 disable-model-invocation: true，删除 user-invocable
 *   disabled   → 两个键都写
 * 这是「改源文件」路线的实现；默认路线（策略覆盖）不调用它。
 */
export function applyPolicyToSource(raw, policyId) {
  const target = POLICY[policyId];
  if (!target) throw new Error(`未知策略 "${policyId}"`);
  let next = raw;
  if (target.modelInvocable) next = removeTopLevelKey(next, 'disable-model-invocation');
  else next = setTopLevelScalar(next, 'disable-model-invocation', 'true');
  if (target.userInvocable) next = removeTopLevelKey(next, 'user-invocable');
  else next = setTopLevelScalar(next, 'user-invocable', 'false');
  return next;
}

/* ------------------------------------------------------------------ *
 * 6. 新建技能文档（脚手架）
 * ------------------------------------------------------------------ */

/**
 * 生成一份全新的 SKILL.md（只写官方支持的键，按固定顺序）。
 */
export function createSkillDocument({ name, description, whenToUse, policyId = 'enabled', body } = {}) {
  if (!isSkillName(name)) throw new Error(`技能名 "${name}" 不是合法 kebab-case`);
  if (typeof description !== 'string' || description.trim() === '') throw new Error('description 不能为空');
  const lines = ['---', `name: ${quoteYamlScalar(name)}`, `description: ${quoteYamlScalar(description)}`];
  if (typeof whenToUse === 'string' && whenToUse.trim() !== '') {
    lines.push(`whenToUse: ${quoteYamlScalar(whenToUse)}`);
  }
  const target = POLICY[policyId];
  if (!target) throw new Error(`未知策略 "${policyId}"`);
  if (!target.modelInvocable) lines.push('disable-model-invocation: true');
  if (!target.userInvocable) lines.push('user-invocable: false');
  lines.push('---', '', typeof body === 'string' && body !== '' ? body.trim() : `# ${name}`, '');
  return lines.join('\n');
}
