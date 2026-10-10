/**
 * 页面内探针生成（DOM 断言 / 计算样式读取 / 偏好强制注入）。
 *
 * 全部以**字符串源码**下发给 `Runtime.evaluate`：单次求值拿全量数据 —— 少往返，
 * 且同一次布局快照内取数（不会出现档位间串味）。
 */
import { fill } from './config.mjs'

/** DOM 断言 + 溢出探针（一档一次）。 */
export function buildDomProbe(checks, overflowTargets) {
  return `(async () => {
  await document.fonts.ready;
  const resolveTarget = (sel) => (sel === 'html' ? document.documentElement : sel === 'body' ? document.body : document.querySelector(sel));
  const checks = [];
  for (const c of ${JSON.stringify(checks)}) {
    let nodes = null, root = null, scopeMissing = false;
    try {
      if (c.scope) {
        root = document.querySelector(c.scope);
        if (!root) { scopeMissing = true; nodes = []; } else nodes = Array.from(root.querySelectorAll(c.selector));
      } else {
        nodes = Array.from(document.querySelectorAll(c.selector));
      }
    } catch (e) {
      checks.push({ id: c.id, error: String((e && e.message) || e) });
      continue;
    }
    let emptyAt = null;
    if (c.nonEmpty) {
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        const hasChild = el.childElementCount > 0;
        const text = (el.textContent || '').trim();
        if (!hasChild && text.length === 0) { emptyAt = i; break; }
      }
    }
    checks.push({ id: c.id, count: nodes.length, emptyAt, scopeMissing });
  }
  const overflow = [];
  for (const t of ${JSON.stringify(overflowTargets)}) {
    const el = resolveTarget(t.selector);
    overflow.push(el
      ? { selector: t.selector, desc: t.desc || '', scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
      : { selector: t.selector, desc: t.desc || '', missing: true });
  }
  return { checks, overflow, viewport: { w: window.innerWidth, h: window.innerHeight }, lang: document.documentElement.lang };
})()`
}

/**
 * 计算样式探针：逐目标读 计算样式 31+ 项 + 圆整后的盒尺寸。
 * 与 DOM 探针分开一次求值 —— 样式只在样式档位跑（默认 1 档），不必拖慢五档循环。
 */
export function buildStyleProbe(targets, props) {
  return `(async () => {
  await document.fonts.ready;
  const PROPS = ${JSON.stringify(props)};
  const out = [];
  for (const t of ${JSON.stringify(targets)}) {
    const el = document.querySelector(t.selector);
    if (!el) { out.push({ name: t.name, selector: t.selector, missing: true }); continue }
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const style = {};
    for (const p of PROPS) style[p] = cs[p];
    out.push({ name: t.name, selector: t.selector, missing: false,
      box: { w: Math.round(box.width), h: Math.round(box.height) },
      text: (el.textContent || '').trim().slice(0, 40),
      style });
  }
  const root = document.documentElement;
  return { targets: out, theme: root.getAttribute('data-theme'), lang: root.getAttribute('lang'),
           viewport: { w: window.innerWidth, h: window.innerHeight } };
})()`
}

/**
 * 文档起始注入脚本（`Page.addScriptToEvaluateOnNewDocument`）——
 * 在页面任何脚本之前落 localStorage 偏好 ⇒ 应用**自己**按配置的 theme/locale 启动，
 * 而不是「先按默认渲染、再被工具改属性」（后者会让依赖 JS 的文案/派生样式对不上）。
 */
export function buildPrefsScript({ apply, theme, locale, localeTag }) {
  const values = { theme, locale, localeTag }
  const ls = Object.entries(apply.localStorage ?? {})
    .map(([k, v]) => [k, fill(v, values)])
    .filter(([, v]) => v !== null)
  const attrs = Object.entries(apply.htmlAttributes ?? {})
    .map(([k, v]) => [k, fill(v, values)])
    .filter(([, v]) => v !== null)
  if (!ls.length && !attrs.length) return null

  return `(() => {
  const LS = ${JSON.stringify(ls)};
  const ATTRS = ${JSON.stringify(attrs)};
  try { for (const [k, v] of LS) localStorage.setItem(k, v); } catch (e) {}
  const applyAttrs = () => {
    const root = document.documentElement;
    if (!root) return false;
    for (const [k, v] of ATTRS) root.setAttribute(k, v);
    return true;
  };
  applyAttrs();
  document.addEventListener('DOMContentLoaded', applyAttrs, { once: true });
})()`
}

/** 载入后复施（幂等）：兜住「页面脚本把属性写回去了」的情况；同时返回实际生效值以便取证。 */
export function buildApplyExpr({ apply, theme, locale, localeTag }) {
  const values = { theme, locale, localeTag }
  const attrs = Object.entries(apply.htmlAttributes ?? {})
    .map(([k, v]) => [k, fill(v, values)])
    .filter(([, v]) => v !== null)
  return `(() => {
  const ATTRS = ${JSON.stringify(attrs)};
  const root = document.documentElement;
  for (const [k, v] of ATTRS) root.setAttribute(k, v);
  return { applied: ATTRS, theme: root.getAttribute('data-theme'), lang: root.getAttribute('lang') };
})()`
}
