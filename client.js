/**
 * dsh-skill-manager —— 浏览器半（设置页 · 技能管理）
 *
 * 设计原则（v0.3）：**默认只给一屏能看完的东西**。
 *   1. 一屏一览：每行 = 技能名 + 一行描述 + 来源/版本/时间。原来 10 列的表格收进这一行。
 *   2. 按需展开：点一行展开版本历史、差异、SKILL.md 原文；同一时刻只展开一个。
 *   3. 低频入口收纳：导入进对话框；诊断（被官方丢弃的条目 / 目录差异 / 覆盖层状态）折叠到底部。
 *   4. 只常驻有意义的操作：主按钮「导入」「导出全部」，其余操作出现在其上下文里。
 *   5. 零运行时依赖：图标是内联 SVG，样式全部用宿主语义令牌（--dsw-*）并带兜底值，
 *      不 require 任何官方包，不改变 README §5.5 的装载约束。
 *
 * 数据全部来自宿主 `/api/skill-manager.*` 精确路由（Connection 的 cookie 鉴权栅栏内）。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-skill-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    const R = {
      ping: '/api/skill-manager.ping',
      list: '/api/skill-manager.list',
      detail: '/api/skill-manager.detail',
      policy: '/api/skill-manager.policy',
      capture: '/api/skill-manager.capture',
      annotate: '/api/skill-manager.annotate',
      restore: '/api/skill-manager.restore',
      compare: '/api/skill-manager.compare',
      export: '/api/skill-manager.export',
      import: '/api/skill-manager.import',
      baseline: '/api/skill-manager.baseline',
      status: '/api/skill-manager.status',
    };

    const POLICIES = [
      { id: 'follow', label: '跟随文件', short: '跟随文件', hint: '由 SKILL.md 的 frontmatter 决定', tone: 'soft' },
      { id: 'enabled', label: '启用', short: '启用', hint: '模型与用户都可用', tone: 'ok' },
      { id: 'userOnly', label: '仅用户可调用', short: '仅用户', hint: '不出现在模型技能目录，仍可用 /名字 调用', tone: 'soft' },
      { id: 'modelOnly', label: '仅模型可调用', short: '仅模型', hint: '不出现在 / 菜单', tone: 'soft' },
      { id: 'disabled', label: '停用', short: '已停用', hint: '两路都不可见', tone: 'off' },
    ];
    const POLICY_MAP = Object.fromEntries(POLICIES.map((p) => [p.id, p]));

    const FILTERS = [
      { id: 'all', label: '全部' },
      { id: 'disabled', label: '已停用' },
      { id: 'dirty', label: '有未捕获改动' },
      { id: 'missing', label: '未建基线' },
      { id: 'issue', label: '有提示' },
    ];

    /* ---------------- 图标（内联 SVG，零依赖，线性 1.1px 与宿主体例一致） ---------------- */

    function svg(paths, size) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, paths.map((d, i) => h('path', { key: i, d })));
    }
    const IconChevron = (p) => svg(['M6 4l4 4-4 4'], (p && p.size) || 11);
    const IconRefresh = (p) => svg(['M13 8a5 5 0 1 1-1.47-3.54', 'M13.2 2.9v2.5h-2.5'], (p && p.size) || 14);
    const IconImport = (p) => svg(['M8 11V2.8', 'M5 5.8 8 2.8l3 3', 'M2.8 10.5v1.8c0 .8.6 1.4 1.4 1.4h7.6c.8 0 1.4-.6 1.4-1.4v-1.8'], (p && p.size) || 14);
    const IconExport = (p) => svg(['M8 2.8V11', 'M5 8l3 3 3-3', 'M2.8 10.5v1.8c0 .8.6 1.4 1.4 1.4h7.6c.8 0 1.4-.6 1.4-1.4v-1.8'], (p && p.size) || 14);
    const IconSearch = (p) => svg(['M7.2 2.8a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8Z', 'M10.4 10.4 13.4 13.4'], (p && p.size) || 13);
    const IconWarning = (p) => svg(['M8 2.8 13.8 12.8H2.2L8 2.8Z', 'M8 6.6v2.5', 'M8 11.1v.2'], (p && p.size) || 14);
    const IconClose = (p) => svg(['M4 4l8 8', 'M12 4l-8 8'], (p && p.size) || 12);

    /* ---------------- 小工具 ---------------- */

    function fmtBytes(n) {
      if (typeof n !== 'number') return '-';
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / 1024 / 1024).toFixed(2)} MB`;
    }

    function fmtTime(ms) {
      if (!ms) return '-';
      const d = new Date(ms);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /** 相对时间：列表里「2 小时前」比完整时间戳更好扫读 */
    function relTime(ms) {
      if (!ms) return '';
      const diff = Date.now() - ms;
      if (diff < 0) return fmtTime(ms);
      if (diff < 60e3) return '刚刚';
      if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
      if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
      if (diff < 172800e3) return '昨天';
      if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`;
      const d = new Date(ms);
      return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
    }

    async function api(path, options) {
      const response = await fetch(path, { credentials: 'same-origin', ...(options ?? {}) });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const body = await response.json();
          if (body && body.message) message = body.message;
        } catch {
          /* 非 JSON 错误体 */
        }
        throw new Error(message);
      }
      return response.json();
    }

    async function postJson(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    async function downloadZip(items, filename) {
      const response = await fetch(R.export, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const body = await response.json();
          if (body && body.message) message = body.message;
        } catch {
          /* 忽略 */
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename ?? 'skills.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    const rowKey = (skill) => `${skill.sourceKey}::${skill.name}`;

    /* ---------------- 样式（注入一次，全部挂在 .skm- 命名空间下） ---------------- */

    function installStyle() {
      if (typeof document === 'undefined') return () => {};
      // 每次装载都换一份新样式：热重载/重挂载时不会残留旧规则，也不会互删对方的 style 标签
      document.querySelectorAll('style[data-plugin="dsh-skill-manager"]').forEach((node) => node.remove());
      const style = document.createElement('style');
      style.dataset.plugin = 'dsh-skill-manager';
      style.textContent = `
.skm-root {
  --skm-label: var(--dsw-alias-label-primary, #1f2329);
  --skm-label-2: var(--dsw-alias-label-secondary, #5c6370);
  --skm-label-3: var(--dsw-alias-label-tertiary, #8b929e);
  --skm-border-1: var(--dsw-alias-border-l1, #eceef1);
  --skm-border-2: var(--dsw-alias-border-l2, #e2e5ea);
  --skm-border-3: var(--dsw-alias-border-l3, #d5d9e0);
  --skm-layer-1: var(--dsw-alias-bg-layer-1, #f7f8fa);
  --skm-layer-2: var(--dsw-alias-bg-layer-2, #eef0f4);
  --skm-hover: var(--dsw-alias-interactive-bg-hover, rgba(20, 24, 32, .05));
  --skm-brand: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4d6bfe));
  --skm-brand-fg: var(--dsw-alias-label-primary-foreground, #fff);
  --skm-ok: var(--dsw-alias-state-success-primary, #16a34a);
  --skm-warn: var(--dsw-alias-state-warn-primary, #c2740a);
  --skm-err: var(--dsw-alias-state-error-primary, #dc2626);
  --skm-radius-sm: var(--dsw-radius-sm, 6px);
  --skm-radius-md: var(--dsw-radius-md, 8px);
  --skm-elevation: var(--dsw-elevation-prominent, 0 8px 28px rgba(16, 20, 28, .18));
  --skm-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  display: flex;
  flex-direction: column;
  gap: 0;
  max-width: 820px;
  color: var(--skm-label);
  font-size: 13px;
  line-height: 1.55;
}
.skm-root *, .skm-root *::before, .skm-root *::after { box-sizing: border-box; }
.skm-root button, .skm-root input, .skm-root select, .skm-root textarea { font-family: inherit; font-size: inherit; color: inherit; }
.skm-root button { cursor: pointer; }
.skm-root button:disabled { cursor: not-allowed; opacity: .45; }
.skm-root :focus-visible { outline: 2px solid var(--skm-brand); outline-offset: 1px; }

/* 页头 */
.skm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.skm-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
.skm-head .skm-meta { margin: 3px 0 0; color: var(--skm-label-3); font-size: 11.5px; }
.skm-head-actions { display: flex; align-items: center; gap: 6px; flex: none; }

/* 按钮 */
.skm-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 28px; padding: 0 10px; border: none; border-radius: var(--skm-radius-sm); background: transparent; color: inherit; font-size: 12px; white-space: nowrap; }
.skm-btn:hover:not(:disabled) { background: var(--skm-hover); }
.skm-btn.outline { border: .5px solid var(--skm-border-3); }
.skm-btn.primary { background: var(--skm-brand); color: var(--skm-brand-fg); }
.skm-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--skm-brand)); }
.skm-btn.quiet { color: var(--skm-label-2); }
.skm-btn.icon-only { width: 28px; padding: 0; color: var(--skm-label-2); }
.skm-btn.sm { height: 24px; padding: 0 7px; font-size: 11.5px; }
.skm-btn.danger:hover:not(:disabled) { color: var(--skm-err); background: color-mix(in srgb, var(--skm-err) 10%, transparent); }

/* 工具条 */
.skm-toolbar { display: flex; align-items: center; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.skm-search { flex: 1 1 200px; min-width: 150px; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 9px; border: .5px solid var(--skm-border-2); border-radius: var(--skm-radius-sm); color: var(--skm-label-3); }
.skm-search:focus-within { border-color: var(--skm-brand); }
.skm-search input { flex: 1; min-width: 0; height: 100%; border: none; outline: none; background: transparent; font-size: 12.5px; }
.skm-search input::placeholder { color: var(--skm-label-3); }
.skm-select { height: 30px; padding: 0 6px; border: .5px solid var(--skm-border-2); border-radius: var(--skm-radius-sm); background: transparent; color: var(--skm-label-2); font-size: 12px; }
.skm-spacer { flex: 1; }
.skm-selbar { display: flex; align-items: center; gap: 2px; font-size: 11.5px; color: var(--skm-label-2); }

/* 提示条 */
.skm-banner { display: flex; align-items: center; gap: 10px; margin-top: 14px; padding: 9px 12px; border-radius: var(--skm-radius-md); background: color-mix(in srgb, var(--skm-warn) 12%, transparent); color: var(--skm-warn); font-size: 12px; }
.skm-banner .skm-banner-text { flex: 1; color: var(--skm-label-2); }
.skm-banner strong { color: var(--skm-warn); font-weight: 600; }
.skm-banner .skm-btn { color: var(--skm-warn); border-color: currentColor; }
.skm-alert { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 8px 10px; border-radius: var(--skm-radius-sm); font-size: 12px; }
.skm-alert.err { background: color-mix(in srgb, var(--skm-err) 12%, transparent); color: var(--skm-err); }
.skm-alert.ok { background: color-mix(in srgb, var(--skm-ok) 12%, transparent); color: var(--skm-ok); }
.skm-alert .skm-alert-text { flex: 1; color: var(--skm-label); }
.skm-alert .skm-btn.icon-only { width: 22px; height: 22px; color: inherit; }

/* 列表 */
.skm-list { list-style: none; margin: 14px 0 0; padding: 0; border-top: .5px solid var(--skm-border-1); }
.skm-row { border-bottom: .5px solid var(--skm-border-1); }
.skm-row-line { display: flex; align-items: flex-start; gap: 8px; padding: 9px 2px; border-radius: var(--skm-radius-sm); }
.skm-row-line:hover { background: color-mix(in srgb, var(--skm-label) 2%, transparent); }
.skm-check { flex: none; width: 14px; height: 14px; margin: 4px 0 0 2px; accent-color: var(--skm-brand); }
.skm-row-main { flex: 1; min-width: 0; display: flex; align-items: flex-start; gap: 6px; padding: 0; border: none; background: transparent; text-align: left; }
.skm-chev { flex: none; margin-top: 3px; color: var(--skm-label-3); display: inline-flex; transition: transform .15s ease; }
.skm-row.open .skm-chev { transform: rotate(90deg); }
.skm-body { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.skm-title-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.skm-title { font-weight: 600; }
.skm-desc { color: var(--skm-label-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skm-meta-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: var(--skm-label-3); font-size: 11px; }
.skm-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; display: inline-block; flex: none; }
.skm-side { display: flex; align-items: center; gap: 6px; flex: none; padding-top: 1px; }
.skm-badge { font-size: 10px; padding: 0 5px; border-radius: 4px; white-space: nowrap; }
.skm-badge.warn { background: color-mix(in srgb, var(--skm-warn) 16%, transparent); color: var(--skm-warn); }
.skm-badge.ok { background: color-mix(in srgb, var(--skm-ok) 16%, transparent); color: var(--skm-ok); }
.skm-badge.err { background: color-mix(in srgb, var(--skm-err) 16%, transparent); color: var(--skm-err); }
.skm-badge.muted { background: var(--skm-layer-2); color: var(--skm-label-2); }

/* 策略 chip + 菜单 */
.skm-menu-wrap { position: relative; }
.skm-chip { height: 22px; display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; border: .5px solid var(--skm-border-2); border-radius: 999px; background: transparent; color: var(--skm-label-2); font-size: 11.5px; }
.skm-chip:hover:not(:disabled) { background: var(--skm-hover); }
.skm-chip.ok { color: var(--skm-ok); border-color: color-mix(in srgb, var(--skm-ok) 40%, var(--skm-border-2)); }
.skm-chip.off { color: var(--skm-err); border-color: color-mix(in srgb, var(--skm-err) 40%, var(--skm-border-2)); }
.skm-chip.soft { color: var(--skm-warn); border-color: color-mix(in srgb, var(--skm-warn) 40%, var(--skm-border-2)); }
.skm-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 40; width: 232px; padding: 4px; border: .5px solid var(--skm-border-2); border-radius: var(--skm-radius-md); background: var(--dsw-alias-bg-module-platform, var(--skm-layer-1)); box-shadow: var(--skm-elevation); }
.skm-menu-item { display: flex; flex-direction: column; gap: 1px; width: 100%; padding: 5px 8px; border: none; border-radius: var(--skm-radius-sm); background: transparent; text-align: left; }
.skm-menu-item:hover { background: var(--skm-hover); }
.skm-menu-item[aria-checked="true"] { background: var(--skm-layer-2); }
.skm-menu-label { font-size: 12px; }
.skm-menu-hint { font-size: 10.5px; color: var(--skm-label-3); }

/* 展开区 */
.skm-detail { margin: 0 0 10px 22px; padding: 10px 12px; border-radius: var(--skm-radius-md); background: var(--skm-layer-2); }
.skm-detail .skm-lede { margin: 0 0 8px; color: var(--skm-label-2); font-size: 11.5px; }
.skm-kv { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 3px 8px; margin: 0 0 10px; font-size: 11.5px; }
.skm-kv dt { color: var(--skm-label-3); }
.skm-kv dd { margin: 0; color: var(--skm-label-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skm-kv dd.mono { font-family: var(--skm-mono); font-size: 11px; }
.skm-capture { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.skm-field { height: 26px; min-width: 84px; flex: 1 1 96px; padding: 0 7px; border: .5px solid var(--skm-border-2); border-radius: var(--skm-radius-sm); background: transparent; font-size: 11.5px; }
.skm-field::placeholder { color: var(--skm-label-3); }
.skm-field.tag { flex: 0 0 84px; min-width: 0; }
.skm-vhead { display: flex; align-items: baseline; gap: 6px; margin: 14px 0 4px; font-size: 12px; font-weight: 600; }
.skm-vhead span { color: var(--skm-label-3); font-weight: 400; font-size: 11px; }
.skm-versions { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow: auto; }
.skm-rev { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 6px; border: none; border-top: .5px solid var(--skm-border-1); border-radius: 4px; background: transparent; text-align: left; font-size: 11.5px; }
.skm-versions li:first-child .skm-rev { border-top: none; }
.skm-rev:hover { background: var(--skm-hover); }
.skm-rev[aria-selected="true"] { background: var(--skm-layer-1); box-shadow: inset 0 0 0 1px var(--skm-border-3); }
.skm-hash { flex: none; font-family: var(--skm-mono); font-size: 11px; color: var(--skm-label-2); }
.skm-vt { flex: none; color: var(--skm-label-3); }
.skm-vnote { color: var(--skm-label-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skm-anno { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.skm-diff { margin-top: 8px; }
.skm-diff-head { display: flex; align-items: baseline; gap: 6px; color: var(--skm-label-3); font-size: 11px; margin-bottom: 4px; flex-wrap: wrap; }
.skm-pre { margin: 0; padding: 8px 10px; border-radius: var(--skm-radius-sm); background: var(--skm-layer-1); font-family: var(--skm-mono); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow: auto; }
.skm-pre div { min-height: 1.5em; }
.skm-add { color: var(--skm-ok); }
.skm-del { color: var(--skm-err); }
.skm-filechips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 0; }
.skm-filechip { padding: 1px 7px; border: .5px solid var(--skm-border-2); border-radius: 999px; background: transparent; color: var(--skm-label-2); font-size: 10.5px; }
.skm-filechip:hover { background: var(--skm-hover); color: var(--skm-label); }
.skm-raw { margin-top: 10px; }
.skm-raw summary { cursor: pointer; color: var(--skm-label-2); font-size: 11.5px; }
.skm-raw pre { margin: 6px 0 0; padding: 8px 10px; border-radius: var(--skm-radius-sm); background: var(--skm-layer-1); color: var(--skm-label-2); font-family: var(--skm-mono); font-size: 11px; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }

/* 空态 / 加载 */
.skm-empty { padding: 32px 0; text-align: center; color: var(--skm-label-3); font-size: 12px; }
.skm-empty p { margin: 0 0 4px; }
.skm-skeleton { padding: 10px 2px; }
.skm-skeleton div { height: 10px; margin: 6px 0; border-radius: 4px; background: var(--skm-layer-2); }

/* 诊断 */
.skm-diag { margin-top: 16px; padding-top: 10px; border-top: .5px solid var(--skm-border-1); }
.skm-diag summary { display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--skm-label-2); font-size: 12px; list-style: none; }
.skm-diag summary::-webkit-details-marker { display: none; }
.skm-diag[open] summary .skm-chev { transform: rotate(90deg); }
.skm-diag .skm-diag-count { color: var(--skm-warn); }
.skm-diag-body { display: flex; flex-direction: column; gap: 14px; margin-top: 12px; }
.skm-diag-body h3 { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
.skm-diag-body p { margin: 0; color: var(--skm-label-3); font-size: 11px; }
.skm-diag-list { list-style: none; margin: 4px 0 0; padding: 0; }
.skm-diag-list li { display: flex; align-items: baseline; gap: 6px; padding: 4px 0; border-top: .5px solid var(--skm-border-1); font-size: 11.5px; color: var(--skm-label-2); }
.skm-diag-list code { flex: none; font-family: var(--skm-mono); font-size: 11px; color: var(--skm-label); }

/* 对话框 */
.skm-veil { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(12, 15, 20, .48); }
.skm-dialog { width: min(560px, 100%); max-height: min(78vh, 640px); display: flex; flex-direction: column; border-radius: 12px; background: var(--dsw-alias-bg-module-platform, #fff); box-shadow: var(--skm-elevation); overflow: hidden; }
.skm-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 16px 8px; }
.skm-dialog-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
.skm-dialog-body { padding: 4px 16px 8px; overflow: auto; font-size: 12px; }
.skm-dialog-foot { display: flex; justify-content: flex-end; gap: 6px; padding: 10px 16px 14px; border-top: .5px solid var(--skm-border-1); }
.skm-drop { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
.skm-plan-summary { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.skm-plan { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.skm-plan th { text-align: left; font-weight: 600; color: var(--skm-label-3); padding: 4px 6px; border-bottom: .5px solid var(--skm-border-1); }
.skm-plan td { padding: 4px 6px; border-bottom: .5px solid var(--skm-border-1); }
`;
      document.head.appendChild(style);
      return () => {
        if (style.parentNode) style.parentNode.removeChild(style);
      };
    }

    /* ---------------- 小组件 ---------------- */

    function Btn(props) {
      const { variant, size, icon, children, className, ...rest } = props;
      const cls = ['skm-btn', variant || '', size || '', className || ''].filter(Boolean).join(' ');
      return h('button', { type: 'button', className: cls, ...rest },
        icon ? h('span', { style: { display: 'inline-flex' }, 'aria-hidden': 'true' }, icon) : null,
        children);
    }
    /** 策略 chip：点开一列候选策略，当前项打勾。原生 select 无法保留 token 外观，这里自绘。 */
    function PolicyChip(props) {
      const { value, disabled, onChange, label } = props;
      const [open, setOpen] = useState(false);
      const wrap = useRef(null);
      const conf = POLICY_MAP[value] ?? POLICY_MAP.follow;

      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (wrap.current && !wrap.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            const button = wrap.current && wrap.current.querySelector('button');
            if (button) button.focus();
          }
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [open]);

      return h('div', { className: 'skm-menu-wrap', ref: wrap },
        h('button', {
          type: 'button',
          className: `skm-chip ${conf.tone}`,
          title: `调用策略：${conf.label}`,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-label': `${label ?? ''} 当前策略 ${conf.label}，点此更改`,
          disabled: !!disabled,
          onClick: () => setOpen((v) => !v),
        }, conf.short, h(IconChevron, { size: 9 })),
        open ? h('div', { className: 'skm-menu', role: 'menu', 'aria-label': '调用策略' },
          POLICIES.map((policy) => h('button', {
            key: policy.id,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': policy.id === value,
            className: 'skm-menu-item',
            onClick: () => {
              setOpen(false);
              if (policy.id !== value) onChange(policy.id);
            },
          },
            h('span', { className: 'skm-menu-label' }, policy.label),
            h('span', { className: 'skm-menu-hint' }, policy.hint)))) : null);
    }

    function DiffView(props) {
      // 路由返回 { path, status, diff: '<unified diff 文本>' }
      const raw = props.diff;
      const text = typeof raw === 'string' ? raw : (raw && (raw.text || raw.diff)) || '';
      const lines = text.split('\n');
      return h('pre', { className: 'skm-pre' },
        lines.map((line, index) => h('div', {
          key: index,
          className: line.startsWith('+') && !line.startsWith('+++')
            ? 'skm-add'
            : line.startsWith('-') && !line.startsWith('---') ? 'skm-del' : undefined,
        }, line || ' ')));
    }

    function Versions(props) {
      const {
        revisions, current, head, selectedId, onSelect, busy,
        note, tag, onNote, onTag, onCapture, onCompare, onExport, onExportCurrent, onRestore, onAnnotate, cmp,
        onFile, diff, annoOpen, onAnnoToggle,
      } = props;

      const selected = revisions.find((rev) => rev.contentHash === selectedId) ?? null;
      const isHead = Boolean(selected) && selected.contentHash === head;

      return h('div', null,
        h('div', { className: 'skm-capture' },
          h('input', {
            className: 'skm-field',
            placeholder: '备注（可选，随新版本保存）',
            value: note,
            onChange: (e) => onNote(e.target.value),
            'aria-label': '新版本备注',
          }),
          h('input', {
            className: 'skm-field tag',
            placeholder: '标签',
            value: tag,
            onChange: (e) => onTag(e.target.value),
            'aria-label': '新版本标签',
          }),
          h(Btn, {
            variant: 'primary',
            disabled: !!busy,
            onClick: onCapture,
          }, busy === 'capture' ? '捕获中…' : '捕获当前为新版本'),
          h('span', { className: 'skm-spacer' }),
          h(Btn, {
            size: 'sm',
            variant: 'outline',
            disabled: !!busy,
            onClick: onExportCurrent,
          }, '导出当前')),

        h('div', { className: 'skm-vhead' }, '版本历史', h('span', null, `${revisions.length} 个修订`)),

        revisions.length === 0
          ? h('p', { className: 'skm-lede', style: { margin: '2px 0 0' } },
              '还没有版本记录。点上面的「捕获当前为新版本」建立基线，之后任何一次改坏都能回滚。')
          : h('ul', { className: 'skm-versions' },
              revisions.map((rev, index) => h('li', { key: `${rev.contentHash}-${rev.at}` },
                h('button', {
                  type: 'button',
                  className: 'skm-rev',
                  'aria-selected': rev.contentHash === selectedId,
                  onClick: () => onSelect(rev.contentHash),
                },
                  h('span', { className: 'skm-hash' }, rev.contentHash.slice(0, 10)),
                  index === 0 ? h('span', { className: 'skm-badge ok' }, '最新') : null,
                  current && current.headRevision === rev.contentHash && current.dirty
                    ? h('span', { className: 'skm-badge warn' }, '旧于磁盘') : null,
                  h('time', { className: 'skm-vt' }, relTime(rev.at)),
                  h('span', { className: 'skm-vnote' }, rev.note || rev.tag || '—'))))),

        selected
          ? h('div', { className: 'skm-selbar', style: { marginTop: 8, padding: '7px 8px', border: '.5px solid var(--skm-border-2)', borderRadius: 'var(--skm-radius-sm)' } },
              h('span', { style: { marginRight: 4 } }, '已选 ', h('code', { style: { fontFamily: 'var(--skm-mono)' } }, selected.contentHash.slice(0, 10))),
              h(Btn, { size: 'sm', disabled: !!busy || isHead, onClick: () => onCompare(selected) }, '对比最新'),
              h(Btn, { size: 'sm', disabled: !!busy, onClick: () => onExport(selected) }, '导出'),
              h(Btn, { size: 'sm', disabled: !!busy || isHead, onClick: () => onRestore(selected) },
                busy === 'restore' ? '回滚中…' : '回滚到此版本'),
              h(Btn, { size: 'sm', onClick: onAnnoToggle }, annoOpen ? '收起备注' : '加备注'))
          : null,

        selected && annoOpen
          ? h('div', { className: 'skm-anno' },
              h('input', {
                className: 'skm-field',
                placeholder: '备注',
                value: note,
                onChange: (e) => onNote(e.target.value),
                'aria-label': '所选版本的备注',
              }),
              h('input', {
                className: 'skm-field tag',
                placeholder: '标签',
                value: tag,
                onChange: (e) => onTag(e.target.value),
                'aria-label': '所选版本的标签',
              }),
              h(Btn, { size: 'sm', variant: 'outline', disabled: !!busy, onClick: () => onAnnotate(selected) }, '保存到所选版本'))
          : null,

        cmp
          ? h('div', { className: 'skm-diff' },
              h('div', { className: 'skm-diff-head' },
                `从所选版本到最新：新增 ${cmp.added.length} · 修改 ${cmp.changed.length} · 删除 ${cmp.removed.length}`),
              h('div', { className: 'skm-filechips' },
                cmp.changed.concat(cmp.added, cmp.removed).slice(0, 16).map((file) =>
                  h('button', {
                    key: file.path,
                    type: 'button',
                    className: 'skm-filechip',
                    onClick: () => onFile(file.path),
                    title: file.path,
                  }, file.path))) )
          : null,

        diff
          ? h('div', { className: 'skm-diff' },
              h('div', { className: 'skm-diff-head' }, `行级差异：${diff.path}（${diff.status}）`),
              h(DiffView, { diff }))
          : null);
    }

    function DemoSkeleton() {
      return h('div', { className: 'skm-skeleton', 'aria-hidden': 'true' },
        [0, 1, 2].map((i) => h('div', { key: i, style: { width: `${72 - i * 12}%` } })));
    }

    function SkillRow(props) {
      const {
        skill, open, status, busy, checked, onToggle, onOpen, onChangePolicy,
        detailState,
      } = props;
      const key = rowKey(skill);
      const statusKnown = status && !status.error;
      const dirty = Boolean(status && status.dirty);

      const meta = [
        h('span', { key: 'src' }, skill.sourceLabel),
        h('span', { key: 'd1' }, '·'),
        h('span', { key: 'rev' }, skill.revisionCount ? `${skill.revisionCount} 版` : '无版本'),
      ];
      if (skill.lastRevisionAt) {
        meta.push(h('span', { key: 'd2' }, '·'));
        meta.push(h('span', { key: 'at', title: fmtTime(skill.lastRevisionAt) }, relTime(skill.lastRevisionAt)));
      }
      if (dirty) {
        meta.push(h('span', { key: 'd3', className: 'skm-dot', style: { color: 'var(--skm-warn)' }, 'aria-hidden': 'true' }));
        meta.push(h('span', { key: 'dirty', style: { color: 'var(--skm-warn)' } }, '未捕获改动'));
      } else if (statusKnown && status && status.hasRevision === false) {
        meta.push(h('span', { key: 'd4', className: 'skm-dot', style: { color: 'var(--skm-label-3)' }, 'aria-hidden': 'true' }));
        meta.push(h('span', { key: 'nb' }, '未建基线'));
      }
      if (status && status.error) {
        meta.push(h('span', { key: 'd5', className: 'skm-dot', style: { color: 'var(--skm-err)' }, 'aria-hidden': 'true' }));
        meta.push(h('span', { key: 'err', style: { color: 'var(--skm-err)' } }, '巡检失败'));
      }

      return h('li', { className: `skm-row${open ? ' open' : ''}` },
        h('div', { className: 'skm-row-line' },
          h('input', {
            type: 'checkbox',
            className: 'skm-check',
            checked,
            onChange: () => onToggle(key),
            'aria-label': `选择 ${skill.name}`,
          }),
          h('button', {
            type: 'button',
            className: 'skm-row-main',
            'aria-expanded': open,
            'aria-label': `${open ? '收起' : '展开'} ${skill.name} 的详情`,
            onClick: () => onOpen(skill),
          },
            h('span', { className: 'skm-chev' }, h(IconChevron, { size: 11 })),
            h('span', { className: 'skm-body' },
              h('span', { className: 'skm-title-line' },
                h('span', { className: 'skm-title' }, skill.name),
                skill.shadowed ? h('span', { className: 'skm-badge warn', title: skill.shadowedBy ? `被 ${skill.shadowedBy} 遮蔽` : '被同名副本遮蔽' }, '被遮蔽') : null,
                skill.diagnostics && skill.diagnostics.length
                  ? h('span', { className: 'skm-badge muted' }, `${skill.diagnostics.length} 项提示`)
                  : null),
              h('span', { className: 'skm-desc', title: skill.description || '' }, skill.description || '（无描述）'),
              h('span', { className: 'skm-meta-line' }, meta))),
          h('span', { className: 'skm-side' },
            h(PolicyChip, {
              value: skill.policyId,
              label: skill.name,
              disabled: busy === key,
              onChange: (next) => onChangePolicy(skill, next),
            }))),
        open ? h(RowDetail, { skill, detailState, ...props }) : null);
    }

    function RowDetail(props) {
      const {
        skill, detailState, busy, onCapture, onNote, onTag, note, tag,
        revisionsFromDetail, onSelectRev, selectedRev, onExportRev, onRestore, onCompare,
        onFile, diff, cmp, annoOpen, onAnnoToggle, onAnnotate, current, onRefreshDetail,
      } = props;

      const data = detailState && detailState.data;
      const loading = detailState && detailState.loading;
      const error = detailState && detailState.error;

      if (loading && !data) {
        return h('div', { className: 'skm-detail' }, h(DemoSkeleton));
      }
      if (error && !data) {
        return h('div', { className: 'skm-detail' },
          h('div', { className: 'skm-alert err', style: { marginTop: 0 } },
            h('span', { className: 'skm-alert-text' }, `读取详情失败：${error}`),
            h(Btn, { className: 'icon-only', onClick: onRefreshDetail, 'aria-label': '重试' }, h(IconRefresh, { size: 12 }))));
      }

      const policy = POLICY_MAP[skill.policyId] ?? POLICY_MAP.follow;
      const revisions = revisionsFromDetail || (data && data.revisions) || [];
      const state = current || (data && data.current) || null;
      const parsed = (data && data.parsed) || null;
      const parseError = data && data.parseError;

      return h('div', { className: 'skm-detail' },
        h('p', { className: 'skm-lede' },
          `策略「${policy.label}」：${policy.hint}。`,
          skill.followFile ? '当前由文件内 frontmatter 决定。' : '策略变化在下一个模型步生效。'),

        h('dl', { className: 'skm-kv' },
          h('dt', null, '路径'), h('dd', { className: 'mono', title: skill.path }, skill.path),
          h('dt', null, '来源'), h('dd', null, `${skill.sourceLabel}（优先级 ${skill.rank}）`),
          h('dt', null, '体积'), h('dd', null, `${skill.fileCount} 个文件 · ${fmtBytes(skill.bytes)}`),
          h('dt', null, '状态'), h('dd', null, state
            ? (state.matchesHead === null
                ? '未建立基线'
                : state.matchesHead ? '与最新版本一致' : '有未捕获的改动')
            : '—')),

        parseError
          ? h('p', { className: 'skm-lede', style: { color: 'var(--skm-err)' } }, `frontmatter 不合法：${parseError.message}`)
          : null,
        parsed && parsed.whenToUse
          ? h('p', { className: 'skm-lede' }, `何时使用：${parsed.whenToUse}`)
          : null,
        parsed && parsed.extraKeys && parsed.extraKeys.length
          ? h('p', { className: 'skm-lede' }, `未知键（官方忽略、本插件保留）：${parsed.extraKeys.join(', ')}`)
          : null,

        h(Versions, {
          revisions,
          current: state,
          head: revisions[0] ? revisions[0].contentHash : null,
          selectedId: selectedRev,
          onSelect: onSelectRev,
          busy,
          note,
          tag,
          onNote,
          onTag,
          onCapture,
          onCompare,
          onExport: onExportRev,
          onExportCurrent: () => onExportRev(null),
          onRestore,
          onAnnotate,
          cmp,
          onFile,
          diff,
          annoOpen,
          onAnnoToggle,
        }),

        h('details', { className: 'skm-raw' },
          h('summary', null, '查看 SKILL.md 原文'),
          h('pre', null, (data && data.content) || '（读不到内容）')));
    }

    function Diagnostics(props) {
      const { listData } = props;
      const invalid = (listData && listData.invalid) || [];
      const warnings = (listData && listData.warnings) || [];
      const official = listData && listData.official;
      const overlay = (listData && listData.overlay) || {};
      const divergence = official && official.available && official.items ? official.items : [];
      const count = invalid.length + divergence.length + warnings.length;
      if (count === 0) return null;

      return h('details', { className: 'skm-diag' },
        h('summary', null,
          h('span', { className: 'skm-chev' }, h(IconChevron, { size: 10 })),
          '诊断',
          h('span', { className: 'skm-diag-count' },
            [
              invalid.length ? `${invalid.length} 条被官方静默丢弃` : null,
              divergence.length ? `${divergence.length} 处目录差异` : null,
              warnings.length ? `${warnings.length} 条扫描告警` : null,
            ].filter(Boolean).join(' · '))),
        h('div', { className: 'skm-diag-body' },
          invalid.length
            ? h('div', null,
                h('h3', null, '被官方静默丢弃的条目'),
                h('p', null, '官方 dsh-skill-filesystem 遇到非法 frontmatter 会直接跳过且不报错，所以这些技能「看起来在磁盘上但用不了」。'),
                h('ul', { className: 'skm-diag-list' },
                  invalid.map((item, index) => h('li', { key: index },
                    h('span', { className: 'skm-badge err' }, item.code),
                    h('code', { title: item.path }, item.path),
                    h('span', null, item.message)))))
            : null,
          divergence.length
            ? h('div', null,
                h('h3', null, '磁盘清单与官方目录的差异'),
                h('ul', { className: 'skm-diag-list' },
                  divergence.map((item, index) => h('li', { key: index },
                    h('code', null, item.name),
                    h('span', null, item.detail)))))
            : null,
          warnings.length
            ? h('div', null,
                h('h3', null, '扫描告警'),
                h('ul', { className: 'skm-diag-list' },
                  warnings.map((item, index) => h('li', { key: index }, h('span', null, item)))))
            : null,
          h('div', null,
            h('h3', null, '覆盖层与扫描范围'),
            h('p', null,
              `覆盖 provider：全局${overlay && overlay.global ? '已注册' : '未注册'}，agent 作用域 ${overlay ? overlay.scopes : 0} 个；生效覆盖 ${overlay && overlay.active ? overlay.active.length : 0} 条。`),
            h('p', { title: ((listData && listData.roots) || []).map((root) => root.dir).join('\n') },
              `扫描范围：${((listData && listData.roots) || []).map((root) => root.label || root.key).join('、') || '—'}`))));
    }

    function ImportDialog(props) {
      const { open, onClose, strategy, onStrategy, onPick, plan, onApply, onCancelPlan, busy, fileName } = props;
      const inputRef = useRef(null);
      const dialogRef = useRef(null);
      useEffect(() => {
        if (open && dialogRef.current) dialogRef.current.focus();
      }, [open]);
      if (!open) return null;

      const summary = plan && plan.plan && plan.plan.summary ? plan.plan.summary : {};
      const actions = (plan && plan.plan && plan.plan.actions) || [];
      const problems = (plan && plan.problems) || [];

      return h('div', {
        className: 'skm-veil',
        role: 'presentation',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); },
        onKeyDown: (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        },
      },
        h('div', { className: 'skm-dialog', ref: dialogRef, tabIndex: -1, role: 'dialog', 'aria-modal': 'true', 'aria-label': '导入技能包' },
          h('div', { className: 'skm-dialog-head' },
            h('h3', null, '导入技能包'),
            h(Btn, { className: 'icon-only', onClick: onClose, 'aria-label': '关闭' }, h(IconClose, { size: 12 }))),
          h('div', { className: 'skm-dialog-body' },
            h('p', { style: { margin: '0', color: 'var(--skm-label-3)' } },
              '支持本插件导出的带清单 zip，也支持裸包（<技能名>/SKILL.md、单个 SKILL.md、平铺 <技能名>.md）。导入前会校验清单 sha256 与 frontmatter。'),
            h('div', { className: 'skm-drop' },
              h('input', {
                ref: inputRef,
                type: 'file',
                accept: '.zip',
                'aria-label': '选择技能包 zip',
                onChange: (event) => {
                  const file = event.target.files && event.target.files[0];
                  if (file) onPick(file);
                },
              }),
              h('select', {
                className: 'skm-select',
                value: strategy,
                onChange: (event) => onStrategy(event.target.value),
                'aria-label': '重名处理策略',
              },
                h('option', { value: 'keep-both' }, '重名时保留两者'),
                h('option', { value: 'overwrite' }, '重名时覆盖'),
                h('option', { value: 'skip' }, '重名时跳过'))),
            fileName ? h('p', { style: { margin: '0 0 6px', color: 'var(--skm-label-3)' } }, `已选择：${fileName}`) : null,
            plan
              ? h('div', null,
                  h('p', { style: { margin: '4px 0' } }, `目标目录：${plan.targetDir}`),
                  h('div', { className: 'skm-plan-summary' },
                    ['create', 'overwrite', 'rename', 'skip', 'invalid'].map((kind) =>
                      h('span', { key: kind, className: 'skm-badge muted' }, `${kind} ${summary[kind] ?? 0}`))),
                  problems.length
                    ? h('p', { style: { margin: '4px 0', color: 'var(--skm-warn)' } },
                        `包级提示 ${problems.length} 条：${problems.map((p) => p.message).join('；')}`)
                    : null,
                  actions.length
                    ? h('table', { className: 'skm-plan' },
                        h('thead', null, h('tr', null,
                          h('th', null, '技能'), h('th', null, '动作'), h('th', null, '目标名'), h('th', null, '提示'))),
                        h('tbody', null, actions.map((action, index) => h('tr', { key: index },
                          h('td', null, action.name),
                          h('td', null, action.kind),
                          h('td', null, action.to ?? action.name),
                          h('td', null, (action.problems || []).map((p) => p.message).join('；') || '—')))))
                    : null)
              : null),
          h('div', { className: 'skm-dialog-foot' },
            plan ? h(Btn, { onClick: onCancelPlan, disabled: !!busy }, '重新选择') : null,
            h(Btn, { onClick: onClose }, '关闭'),
            plan ? h(Btn, { variant: 'primary', disabled: !!busy, onClick: onApply }, busy === 'import-apply' ? '导入中…' : '确认导入') : null)));
    }

    /* ---------------- 页面 ---------------- */

    function SkillManagerPage() {
      const [listData, setListData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(null);
      const [query, setQuery] = useState('');
      const [filter, setFilter] = useState('all');
      const [selected, setSelected] = useState(() => new Set());
      const [expandedKey, setExpandedKey] = useState(null);
      const [detailState, setDetailState] = useState({ data: null, loading: false, error: null });
      const [selectedRev, setSelectedRev] = useState(null);
      const [note, setNote] = useState('');
      const [tag, setTag] = useState('');
      const [cmp, setCmp] = useState(null);
      const [diff, setDiff] = useState(null);
      const [annoOpen, setAnnoOpen] = useState(false);
      const [statusMap, setStatusMap] = useState({});
      const [statusLoading, setStatusLoading] = useState(false);
      const [bannerDismissed, setBannerDismissed] = useState(false);
      const [importOpen, setImportOpen] = useState(false);
      const [importFile, setImportFile] = useState(null);
      const [importPlan, setImportPlan] = useState(null);
      const [strategy, setStrategy] = useState('keep-both');

      const run = useCallback(async (label, fn) => {
        setBusy(label);
        setError(null);
        try {
          return await fn();
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
          return null;
        } finally {
          setBusy(null);
        }
      }, []);

      const refreshStatus = useCallback(async () => {
        setStatusLoading(true);
        try {
          const data = await api(R.status);
          const map = {};
          for (const item of data.items || []) map[`${item.sourceKey}::${item.name}`] = item;
          setStatusMap(map);
        } catch {
          setStatusMap({});
        } finally {
          setStatusLoading(false);
        }
      }, []);

      const refresh = useCallback(async () => {
        const data = await run('refresh', async () => {
          const body = await api(R.list);
          setListData(body);
          return body;
        });
        if (data) refreshStatus();
        setLoading(false);
        return data;
      }, [run, refreshStatus]);

      /** 用户点「重新扫描」：连被手动忽略的提示条一起恢复 */
      const manualRefresh = useCallback(() => {
        setBannerDismissed(false);
        return refresh();
      }, [refresh]);

      useEffect(() => {
        refresh();
      }, [refresh]);

      useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(null), 6000);
        return () => clearTimeout(timer);
      }, [notice]);

      const skills = (listData && listData.skills) || [];
      const statusOf = useCallback((skill) => statusMap[rowKey(skill)] || null, [statusMap]);

      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return skills.filter((skill) => {
          if (needle) {
            const haystack = `${skill.name} ${skill.description || ''} ${skill.sourceLabel || ''}`.toLowerCase();
            if (!haystack.includes(needle)) return false;
          }
          const status = statusMap[rowKey(skill)];
          switch (filter) {
            case 'disabled': return skill.policyId === 'disabled';
            case 'dirty': return Boolean(status && status.dirty);
            case 'missing': return skill.revisionCount === 0;
            case 'issue': return Boolean(skill.shadowed || (skill.diagnostics && skill.diagnostics.length) || (status && status.error));
            default: return true;
          }
        });
      }, [skills, query, filter, statusMap]);

      const currentSkill = useMemo(
        () => skills.find((skill) => rowKey(skill) === expandedKey) || null,
        [skills, expandedKey],
      );

      const loadDetail = useCallback(async (skill, keepData) => {
        setDetailState((prev) => ({ data: keepData ? prev.data : null, loading: true, error: null }));
        try {
          const data = await api(`${R.detail}?sourceKey=${encodeURIComponent(skill.sourceKey)}&name=${encodeURIComponent(skill.name)}`);
          setDetailState({ data, loading: false, error: null });
          setSelectedRev((prev) => {
            const revisions = data.revisions || [];
            if (prev && revisions.some((rev) => rev.contentHash === prev)) return prev;
            return revisions[0] ? revisions[0].contentHash : null;
          });
        } catch (e) {
          setDetailState({ data: null, loading: false, error: e && e.message ? e.message : String(e) });
        }
      }, []);

      const openRow = (skill) => {
        const key = rowKey(skill);
        if (expandedKey === key) {
          setExpandedKey(null);
          setDetailState({ data: null, loading: false, error: null });
          setCmp(null);
          setDiff(null);
          setSelectedRev(null);
          setAnnoOpen(false);
          return;
        }
        setExpandedKey(key);
        setDetailState({ data: null, loading: true, error: null });
        setCmp(null);
        setDiff(null);
        setAnnoOpen(false);
        setNote('');
        setTag('');
        loadDetail(skill);
      };

      const toggle = (key) => {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      };

      const allVisibleSelected = visible.length > 0 && visible.every((skill) => selected.has(rowKey(skill)));
      const selectAll = () => {
        setSelected((prev) => {
          const next = new Set(prev);
          if (allVisibleSelected) visible.forEach((skill) => next.delete(rowKey(skill)));
          else visible.forEach((skill) => next.add(rowKey(skill)));
          return next;
        });
      };

      const changePolicy = (skill, policyId) => run(`policy:${rowKey(skill)}`, async () => {
        const result = await postJson(R.policy, {
          sourceKey: skill.sourceKey,
          name: skill.name,
          policy: policyId,
          meta: { path: skill.path, dir: skill.dir, officialRank: skill.rank },
        });
        setNotice({
          kind: 'ok',
          text: `${skill.name} → ${result.policyLabel}。策略在下一个模型步生效。`,
        });
        await refresh();
        if (rowKey(skill) === expandedKey) await loadDetail(skill, true);
      });

      const capture = () => run('capture', async () => {
        if (!currentSkill) return;
        const result = await postJson(R.capture, {
          sourceKey: currentSkill.sourceKey,
          name: currentSkill.name,
          note: note || null,
          tag: tag || null,
        });
        setNotice({ kind: 'ok', text: result.created ? '已创建新版本' : '内容与最新版本一致，未新建版本' });
        setNote('');
        setTag('');
        await loadDetail(currentSkill, true);
        await refresh();
      });

      const runBaseline = (mode) => run(`baseline:${mode}`, async () => {
        const result = await postJson(R.baseline, { mode });
        const failed = result.failed || [];
        setNotice({
          kind: failed.length ? 'err' : 'ok',
          text: mode === 'missing'
            ? `已为 ${result.created} 个技能建立基线${failed.length ? `，${failed.length} 个失败` : ''}`
            : `已捕获 ${result.created} 个技能的改动${result.unchanged ? `，${result.unchanged} 个内容未变` : ''}`,
        });
        await refresh();
      });

      const exportRows = (rows, filename) => run('export', async () => {
        if (!rows.length) return;
        await downloadZip(rows.map((skill) => ({ sourceKey: skill.sourceKey, name: skill.name })), filename);
        setNotice({ kind: 'ok', text: `已导出 ${rows.length} 个技能` });
      });

      const exportRevision = (rev) => run('export', async () => {
        if (!currentSkill) return;
        if (!rev) return exportAllForSkill();
        await downloadZip(
          [{ sourceKey: currentSkill.sourceKey, name: currentSkill.name, revisionId: rev.contentHash }],
          `${currentSkill.name}-${rev.contentHash.slice(0, 8)}.zip`,
        );
        setNotice({ kind: 'ok', text: `已导出 ${currentSkill.name} 的版本 ${rev.contentHash.slice(0, 10)}` });
      });

      const exportAllForSkill = () => run('export', async () => {
        if (!currentSkill) return;
        await downloadZip([{ sourceKey: currentSkill.sourceKey, name: currentSkill.name }], `${currentSkill.name}.zip`);
        setNotice({ kind: 'ok', text: `已导出 ${currentSkill.name}` });
      });

      const restore = (rev) => run('restore', async () => {
        if (!currentSkill) return;
        const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(`回滚 ${currentSkill.name} 到 ${rev.contentHash.slice(0, 10)}？\n\n当前磁盘内容会先被备份为一个新版本，因此回滚本身可逆。`)
          : true;
        if (!confirmed) return;
        await postJson(R.restore, {
          sourceKey: currentSkill.sourceKey,
          name: currentSkill.name,
          revisionId: rev.contentHash,
        });
        setNotice({ kind: 'ok', text: `已回滚到 ${rev.contentHash.slice(0, 10)}（回滚前状态已备份）` });
        await loadDetail(currentSkill, true);
        await refresh();
      });

      const annotate = (rev) => run('annotate', async () => {
        if (!currentSkill) return;
        await postJson(R.annotate, {
          sourceKey: currentSkill.sourceKey,
          name: currentSkill.name,
          revisionId: rev.contentHash,
          note: note || null,
          tag: tag || null,
        });
        setNotice({ kind: 'ok', text: '备注已保存' });
        setAnnoOpen(false);
        await loadDetail(currentSkill, true);
      });

      /** 对比所选旧版本 → 最新版本（a=所选, b=最新），所以「新增」= 之后新增的文件 */
      const compare = (rev) => run('compare', async () => {
        if (!currentSkill) return;
        const latest = detailState.data && detailState.data.revisions && detailState.data.revisions[0];
        if (!latest) return;
        setDiff(null);
        const summary = await api(
          `${R.compare}?sourceKey=${encodeURIComponent(currentSkill.sourceKey)}&name=${encodeURIComponent(currentSkill.name)}&a=${rev.contentHash}&b=${latest.contentHash}`,
        );
        setCmp({ ...summary, a: rev.contentHash, b: latest.contentHash });
      });

      const openFile = (relPath) => run('diff', async () => {
        if (!currentSkill || !cmp) return;
        const body = await api(
          `${R.compare}?sourceKey=${encodeURIComponent(currentSkill.sourceKey)}&name=${encodeURIComponent(currentSkill.name)}&a=${cmp.a}&b=${cmp.b}&path=${encodeURIComponent(relPath)}`,
        );
        setDiff(body);
      });

      const pickImport = (file) => run('import-plan', async () => {
        const buffer = await file.arrayBuffer();
        setImportFile({ buffer, name: file.name });
        const response = await fetch(`${R.import}?strategy=${strategy}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/zip' },
          body: buffer,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
        setImportPlan(body);
      });

      const applyImport = () => run('import-apply', async () => {
        if (!importFile) return;
        const response = await fetch(`${R.import}?apply=1&strategy=${strategy}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/zip' },
          body: importFile.buffer,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
        setNotice({ kind: 'ok', text: `已导入 ${body.written.length} 个技能` });
        setImportOpen(false);
        setImportPlan(null);
        setImportFile(null);
        await refresh();
      });

      const missingBaseline = skills.filter((skill) => skill.revisionCount === 0).length;
      const dirtyCount = skills.filter((skill) => {
        const status = statusOf(skill);
        return Boolean(status && status.dirty);
      }).length;
      const selectedSkills = skills.filter((skill) => selected.has(rowKey(skill)));
      const showBanner = !bannerDismissed && (missingBaseline > 0 || dirtyCount > 0);

      return h('div', { className: 'skm-root' },
        /* 页头 */
        h('header', { className: 'skm-head' },
          h('div', null,
            h('h2', null, '技能管理'),
            h('p', { className: 'skm-meta' },
              listData
                ? `${skills.length} 个技能${dirtyCount ? ` · ${dirtyCount} 个有未捕获改动` : ''}${statusLoading ? ' · 巡检中…' : ''} · 扫描于 ${fmtTime(listData.scannedAt)}`
                : loading ? '加载中…' : '扫描失败，点右侧按钮重试')),
          h('div', { className: 'skm-head-actions' },
            h(Btn, { variant: 'outline', onClick: () => setImportOpen(true), disabled: !!busy },
              h(IconImport, { size: 13 }), '导入'),
            h(Btn, {
              variant: 'outline',
              onClick: () => exportRows(skills, 'all-skills.zip'),
              disabled: !!busy || !skills.length,
            }, h(IconExport, { size: 13 }), '导出全部'),
            h(Btn, {
              className: 'icon-only',
              onClick: manualRefresh,
              disabled: !!busy,
              title: '重新扫描',
              'aria-label': '重新扫描技能目录',
            }, h(IconRefresh, { size: 13 })))),

        /* 工具条 */
        h('div', { className: 'skm-toolbar' },
          h('label', { className: 'skm-search' },
            h(IconSearch, { size: 13 }),
            h('input', {
              placeholder: '搜索技能名或描述',
              value: query,
              onChange: (e) => setQuery(e.target.value),
              'aria-label': '搜索技能',
            })),
          h('select', {
            className: 'skm-select',
            value: filter,
            onChange: (e) => setFilter(e.target.value),
            'aria-label': '筛选',
          }, FILTERS.map((item) => h('option', { key: item.id, value: item.id }, item.label))),
          h('span', { className: 'skm-spacer' }),
          h('div', { className: 'skm-selbar' },
            selected.size
              ? [
                  h('span', { key: 'n' }, `已选 ${selected.size}`),
                  h(Btn, { key: 'all', size: 'sm', onClick: selectAll }, allVisibleSelected ? '取消全选' : '全选'),
                  h(Btn, { key: 'clear', size: 'sm', onClick: () => setSelected(new Set()) }, '清除'),
                  h(Btn, {
                    key: 'exp',
                    size: 'sm',
                    variant: 'outline',
                    onClick: () => exportRows(selectedSkills, 'selected-skills.zip'),
                    disabled: !!busy,
                  }, '导出选中'),
                ]
              : [h(Btn, { key: 'all-only', size: 'sm', onClick: selectAll, disabled: !visible.length }, '全选')])),

        /* 提示条 */
        error
          ? h('div', { className: 'skm-alert err' },
              h('span', { className: 'skm-alert-text' }, error),
              h(Btn, { className: 'icon-only', onClick: () => setError(null), 'aria-label': '关闭错误提示' }, h(IconClose, { size: 11 })))
          : null,
        notice
          ? h('div', { className: 'skm-alert ok' },
              h('span', { className: 'skm-alert-text' }, notice.text),
              h(Btn, { className: 'icon-only', onClick: () => setNotice(null), 'aria-label': '关闭提示' }, h(IconClose, { size: 11 })))
          : null,

        showBanner
          ? h('div', { className: 'skm-banner' },
              h(IconWarning, { size: 14 }),
              h('span', { className: 'skm-banner-text' },
                missingBaseline
                  ? h('span', null, h('strong', null, `${missingBaseline} 个技能还没有版本基线`), '，建立后任何一次改坏都能一键回滚。')
                  : null,
                missingBaseline && dirtyCount ? ' ' : null,
                dirtyCount
                  ? h('span', null, h('strong', null, `${dirtyCount} 个技能有未捕获的改动`), '，改动不会自动记录。')
                  : null),
              h(Btn, {
                variant: 'outline',
                disabled: !!busy,
                onClick: () => runBaseline(missingBaseline ? 'missing' : 'dirty'),
              }, busy && String(busy).startsWith('baseline') ? '处理中…' : (missingBaseline ? '建立基线' : '捕获改动')),
              h(Btn, { className: 'icon-only', onClick: () => setBannerDismissed(true), 'aria-label': '忽略' }, h(IconClose, { size: 11 })))
          : null,

        /* 列表 */
        loading
          ? h('div', { style: { marginTop: 14 } }, h(DemoSkeleton))
          : visible.length === 0
            ? h('div', { className: 'skm-empty' },
                h('p', null, skills.length === 0 ? '还没有可管理的技能。' : '没有匹配的技能。'),
                h('p', null, skills.length === 0
                  ? '技能放在 ~/.dsh/skills、profile 的 skills 目录或工作区的 .dsh/skills 下（每个技能是一个含 SKILL.md 的目录，或单个 .md）。'
                  : '换个关键词，或把筛选切回「全部」。'))
            : h('ul', { className: 'skm-list' },
                visible.map((skill) => h(SkillRow, {
                  key: rowKey(skill),
                  skill,
                  open: expandedKey === rowKey(skill),
                  status: statusOf(skill),
                  busy,
                  checked: selected.has(rowKey(skill)),
                  onToggle: toggle,
                  onOpen: openRow,
                  onChangePolicy: changePolicy,
                  detailState: expandedKey === rowKey(skill) ? detailState : null,
                  revisionsFromDetail: detailState.data && detailState.data.revisions,
                  current: detailState.data && detailState.data.current,
                  selectedRev: expandedKey === rowKey(skill) ? selectedRev : null,
                  onSelectRev: (id) => { setSelectedRev(id); setCmp(null); setDiff(null); },
                  onExportRev: exportRevision,
                  onRestore: restore,
                  onCompare: compare,
                  onFile: openFile,
                  diff: expandedKey === rowKey(skill) ? diff : null,
                  cmp: expandedKey === rowKey(skill) ? cmp : null,
                  annoOpen,
                  onAnnoToggle: () => setAnnoOpen((v) => !v),
                  onAnnotate: annotate,
                  onCapture: capture,
                  note,
                  tag,
                  onNote: setNote,
                  onTag: setTag,
                  onRefreshDetail: () => currentSkill && loadDetail(currentSkill),
                }))),

        h(Diagnostics, { listData }),

        h(ImportDialog, {
          open: importOpen,
          onClose: () => setImportOpen(false),
          strategy,
          onStrategy: setStrategy,
          onPick: pickImport,
          plan: importPlan,
          onApply: applyImport,
          onCancelPlan: () => { setImportPlan(null); setImportFile(null); },
          busy,
          fileName: importFile && importFile.name,
        }));
    }

    /* ---------------- 装配 ---------------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposeStyle = installStyle();
        const disposeSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'skill-manager',
          order: 60,
          label: () => '技能管理',
        }, SkillManagerPage));
        return () => {
          try { disposeSection(); } catch { /* 忽略 */ }
          try { disposeStyle(); } catch { /* 忽略 */ }
        };
      },
    };
  },
});
