/**
 * diff.js —— 零依赖的行级差异（LCS + 统一 diff 输出）
 *
 * 只服务于"看技能改了什么"，因此刻意保持简单：
 *   - 行数超过 maxLines 时不做逐行对齐，直接报告"整文件已变更"，避免 O(n*m) 爆内存；
 *   - 输出标准 unified diff 文本（---/+++/@@），便于前端直接渲染或复制。
 */

/** @returns {{ops:Array<{type:'eq'|'del'|'add', line:string}>, stats:{added:number, removed:number}}} */
export function diffLines(aText, bText) {
  const a = String(aText ?? '').split('\n');
  const b = String(bText ?? '').split('\n');
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS 长度，用一维数组滚动
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const idx = i * width + j;
      dp[idx] = a[i] === b[j] ? dp[(i + 1) * width + (j + 1)] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', line: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ type: 'del', line: a[i] });
      removed += 1;
      i += 1;
    } else {
      ops.push({ type: 'add', line: b[j] });
      added += 1;
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', line: a[i] });
    removed += 1;
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', line: b[j] });
    added += 1;
    j += 1;
  }
  return { ops, stats: { added, removed } };
}

/**
 * 生成 unified diff 文本。
 * @returns {{text:string, stats:{added:number,removed:number}, truncated:boolean}}
 */
export function unifiedDiff(aText, bText, { context = 3, labelA = 'a', labelB = 'b', maxLines = 2000 } = {}) {
  const aLines = String(aText ?? '').split('\n');
  const bLines = String(bText ?? '').split('\n');
  if (aLines.length > maxLines || bLines.length > maxLines) {
    return {
      text: `--- ${labelA}\n+++ ${labelB}\n@@ 文件过大（a=${aLines.length} 行, b=${bLines.length} 行），仅报告整体变更 @@\n`,
      stats: { added: bLines.length, removed: aLines.length },
      truncated: true,
    };
  }
  const { ops, stats } = diffLines(aText, bText);
  if (stats.added === 0 && stats.removed === 0) return { text: '', stats, truncated: false };

  // 找出所有变更位置，按 context 合并成 hunk
  const changedIdx = [];
  ops.forEach((op, idx) => {
    if (op.type !== 'eq') changedIdx.push(idx);
  });
  const hunks = [];
  let start = Math.max(0, changedIdx[0] - context);
  let end = Math.min(ops.length - 1, changedIdx[0] + context);
  for (let k = 1; k < changedIdx.length; k += 1) {
    const idx = changedIdx[k];
    if (idx - context <= end + 1) {
      end = Math.min(ops.length - 1, idx + context);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, idx - context);
      end = Math.min(ops.length - 1, idx + context);
    }
  }
  hunks.push([start, end]);

  let aLineNo = 1;
  let bLineNo = 1;
  const lineNos = ops.map((op) => {
    const rec = { aLine: op.type === 'add' ? null : aLineNo, bLine: op.type === 'del' ? null : bLineNo };
    if (op.type !== 'add') aLineNo += 1;
    if (op.type !== 'del') bLineNo += 1;
    return rec;
  });

  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  for (const [s, e] of hunks) {
    const slice = ops.slice(s, e + 1);
    const aStart = lineNos[s].aLine ?? lineNos[s].bLine ?? 1;
    const bStart = lineNos[s].bLine ?? lineNos[s].aLine ?? 1;
    const aCount = slice.filter((op) => op.type !== 'add').length;
    const bCount = slice.filter((op) => op.type !== 'del').length;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of slice) {
      out.push(`${op.type === 'eq' ? ' ' : op.type === 'del' ? '-' : '+'}${op.line}`);
    }
  }
  return { text: `${out.join('\n')}\n`, stats, truncated: false };
}
