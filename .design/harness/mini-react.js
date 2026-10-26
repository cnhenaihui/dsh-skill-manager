/**
 * 仅用于本地可视化验证的极简渲染器（不随插件发布）。
 * 支持本插件用到的 React 子集：createElement / useState / useEffect / useMemo / useCallback / useRef。
 * 每次 setState 后整树重渲染；hooks 状态按「组件路径 + 序号」保存。
 */
(function () {
  const slots = new Map();
  const effects = [];
  let renderRoot = null;
  let scheduled = false;
  let currentPath = '';
  let hookIndex = 0;

  function createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    const merged = Object.assign({}, props || {});
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged };
  }

  function slotOf(kind) {
    const key = currentPath + '#' + hookIndex++;
    if (!slots.has(key)) slots.set(key, { kind, value: undefined, deps: undefined });
    return slots.get(key);
  }

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  function useState(initial) {
    const slot = slotOf('state');
    if (slot.value === undefined) slot.value = typeof initial === 'function' ? initial() : initial;
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      schedule();
    };
    return [slot.value, set];
  }

  function useRef(initial) {
    const slot = slotOf('ref');
    if (slot.value === undefined) slot.value = { current: initial === undefined ? null : initial };
    return slot.value;
  }

  function useMemo(factory, deps) {
    const slot = slotOf('memo');
    if (slot.deps === undefined || !sameDeps(slot.deps, deps)) {
      slot.value = factory();
      slot.deps = deps;
    }
    return slot.value;
  }

  function useCallback(fn, deps) {
    return useMemo(() => fn, deps);
  }

  function useEffect(fn, deps) {
    const slot = slotOf('effect');
    if (slot.deps === undefined || !sameDeps(slot.deps, deps)) {
      slot.deps = deps || [];
      slot.value = fn;
      effects.push(slot);
    }
  }

  function applyProps(el, props, path) {
    Object.keys(props).forEach((name) => {
      if (name === 'children' || name === 'key' || name === 'ref') return;
      const value = props[name];
      if (value === undefined || value === null || value === false) return;
      if (name === 'className') { el.setAttribute('class', value); return; }
      if (name === 'style' && typeof value === 'object') {
        Object.keys(value).forEach((k) => {
          const cssName = k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
          el.style.setProperty(cssName, String(value[k]));
        });
        return;
      }
      if (name === 'onClick' || name === 'onMouseDown' || name === 'onKeyDown' || name === 'onChange') {
        const eventName = name === 'onChange' ? (/^(input|select|textarea)$/i.test(el.tagName) ? 'input' : 'change') : name.slice(2).toLowerCase();
        el.addEventListener(eventName, value);
        if (name === 'onChange') el.addEventListener('change', value);
        return;
      }
      if (name === 'value') { el.value = value; return; }
      if (name === 'checked') { el.checked = Boolean(value); return; }
      if (name === 'disabled') { el.disabled = Boolean(value); return; }
      if (name === 'type') { el.setAttribute('type', value); return; }
      if (name === 'tabIndex') { el.setAttribute('tabindex', value); return; }
      if (name === 'autoFocus' || name === 'focusable') { return; }
      el.setAttribute(name, String(value));
    });
    if (props.ref && props.ref.current !== el) props.ref.current = el;
    void path;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function mountChild(child, parent, path) {
    if (child === null || child === undefined || child === false || child === true) return;
    if (Array.isArray(child)) {
      child.forEach((item, i) => mountChild(item, parent, path + '.' + i));
      return;
    }
    if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(document.createTextNode(String(child)));
      return;
    }
    if (typeof child.type === 'function') {
      const prevPath = currentPath;
      const prevIndex = hookIndex;
      currentPath = path;
      hookIndex = 0;
      let out;
      try {
        out = child.type(child.props || {});
      } finally {
        currentPath = prevPath;
        hookIndex = prevIndex;
      }
      mountChild(out, parent, path);
      return;
    }
    const tag = child.type;
    const inSvg = tag === 'svg' || parent.namespaceURI === SVG_NS;
    const el = inSvg
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag);
    applyProps(el, child.props || {}, path);
    parent.appendChild(el);
    const kids = child.props ? child.props.children : undefined;
    if (kids !== undefined) mountChild(kids, el, path + '>' + tag);
  }

  function render(component, container) {
    renderRoot = { component, container };
    paint();
  }

  function paint() {
    if (!renderRoot) return;
    effects.length = 0;
    currentPath = 'root';
    hookIndex = 0;
    renderRoot.container.textContent = '';
    mountChild(createElement(renderRoot.component, {}), renderRoot.container, 'root');
    const pending = effects.slice();
    pending.forEach((slot) => {
      try {
        if (typeof slot.value === 'function') slot.value();
      } catch (error) {
        window.__harnessError && window.__harnessError(error);
      }
    });
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(() => {
      scheduled = false;
      paint();
    });
  }

  window.MiniReact = {
    createElement, useState, useEffect, useMemo, useCallback, useRef, render,
    Fragment: 'fragment',
  };
})();
