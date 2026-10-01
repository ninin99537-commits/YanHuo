// ---------------------------------------------------------------------------
// 悬浮球旁弹窗: 所有提示都贴着彼方悬浮球出现(左侧优先, 空间不足弹到右方), 带弹出动画;
// 错误加重显示(红边+晃动+更长停留)。悬浮球界面与脚本运行在两个 iframe 上下文,
// 通过酒馆页面上的隐藏锚点元素共享球的位置。与烟火的 yh- 系列元素互不冲突。
// ---------------------------------------------------------------------------

import { 弹窗变量, 取弹窗配色, 悬浮球直径 } from './theme';
import type { 弹窗配色 } from './theme';

export type ToastType = 'success' | 'info' | 'warning' | 'error';

const TOAST_DURATION: Record<ToastType, number> = { success: 3400, info: 3400, warning: 5200, error: 8000 };

const TOAST_ACCENT: Record<ToastType, string> = {
  success: '#4f9d69',
  info: '#7d8ea8',
  warning: '#b07a33',
  error: '#e0574a',
};

/** 面板配色还没送到时的兜底(= 深色主题): 和面板同一个来源, 不再手抄一串颜色 */
const 兜底 = 取弹窗配色('dark');

/** 悬浮球直径见 theme.ts(锚点 x,y 是球心, 见其定位注释"锚点-20") */

const BASE_STYLE =
  `display:flex;align-items:flex-start;gap:9px;padding:9px 14px;border-radius:12px;background:var(${弹窗变量.bg},${兜底.bg});` +
  `border:1px solid var(${弹窗变量.border},${兜底.border});color:var(${弹窗变量.text},${兜底.text});font:12px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;` +
  'box-shadow:0 8px 24px rgba(0,0,0,.45);pointer-events:auto;cursor:pointer;max-width:100%;' +
  'max-height:50vh;overflow:auto;white-space:pre-wrap;word-break:break-word;' +
  'animation:bfToastIn .3s cubic-bezier(.34,1.56,.64,1);';

/** 错误弹窗加重: 红底红边 + 晃动(弹出动画结束后接一段抖动) */
const ERROR_STYLE =
  `background:var(${弹窗变量.errorBg},${兜底.errorBg});border:1px solid var(${弹窗变量.errorBorder},${兜底.errorBorder});color:var(${弹窗变量.errorText},${兜底.errorText});` +
  'box-shadow:0 8px 28px rgba(224,87,74,.3);' +
  'animation:bfToastIn .3s cubic-bezier(.34,1.56,.64,1),bfToastShake .45s ease .32s;';

const TOAST_STYLE: Record<ToastType, string> = {
  success: `border-left:3px solid ${TOAST_ACCENT.success};`,
  info: `border-left:3px solid ${TOAST_ACCENT.info};`,
  warning: `border-left:3px solid var(${弹窗变量.accent},${TOAST_ACCENT.warning});`,
  error: ERROR_STYLE + `border-left:3px solid var(${弹窗变量.errorBorder},${兜底.errorBorder});`,
};

const KEYFRAMES = [
  '@keyframes bfToastIn{from{opacity:0;transform:translateX(12px) scale(.92)}to{opacity:1;transform:none}}',
  '@keyframes bfToastOut{to{opacity:0;transform:translateX(12px) scale(.96)}}',
  '@keyframes bfToastShake{0%,100%{transform:none}20%{transform:translateX(-6px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}',
].join('');

function parentDoc(): Document | null {
  try {
    return window.parent !== window ? window.parent.document : null;
  } catch {
    return null;
  }
}

function ensureStyles(doc: Document) {
  if (doc.getElementById('bf-toast-style')) return;
  const style = doc.createElement('style');
  style.id = 'bf-toast-style';
  style.textContent = KEYFRAMES;
  doc.head.appendChild(style);
}

/** 弹窗容器(两个上下文按 id 共享同一个), 贴着球定位, 内部纵向堆叠 */
function ensureStack(doc: Document): HTMLElement {
  let stack = doc.getElementById('bf-toast-stack');
  if (!stack) {
    stack = doc.createElement('div');
    stack.id = 'bf-toast-stack';
    stack.style.cssText =
      'position:fixed;left:0;top:0;display:flex;flex-direction:column;gap:8px;align-items:flex-end;' +
      'z-index:2147482998;pointer-events:none;max-width:min(380px,70vw);';
    doc.body.appendChild(stack);
  }
  if (!stack.dataset.resizeBound) {
    stack.dataset.resizeBound = '1';
    doc.defaultView?.addEventListener('resize', () => reposition(doc));
  }
  return stack;
}

/** 读取球的位置(由悬浮球界面写入锚点元素); 缺省回退到球的默认位置(右下角) */
function readAnchor(doc: Document): { x: number; y: number } {
  const marker = doc.getElementById('bf-toast-anchor');
  if (marker) {
    const x = Number(marker.getAttribute('data-x'));
    const y = Number(marker.getAttribute('data-y'));
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  const win = doc.defaultView;
  return { x: (win?.innerWidth ?? 1080) - 悬浮球直径, y: (win?.innerHeight ?? 720) - 110 };
}

/** 容器整体贴球定位: 左侧优先, 空间不足弹到右方; 垂直居中对齐球, 越界时收进视口 */
function reposition(doc: Document) {
  const stack = doc.getElementById('bf-toast-stack');
  const win = doc.defaultView;
  if (!stack || stack.children.length === 0 || !win) return;
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const { x, y } = readAnchor(doc);
  const w = stack.offsetWidth;
  const h = stack.offsetHeight;
  const ballL = x - 悬浮球直径 / 2;
  const ballR = x + 悬浮球直径 / 2;
  let left = ballL - 10 - w;
  if (left < 8) left = ballR + 10;
  left = Math.min(Math.max(left, 8), Math.max(8, vw - w - 8));
  const top = Math.min(Math.max(y - h / 2, 8), Math.max(8, vh - h - 8));
  stack.style.left = `${Math.round(left)}px`;
  stack.style.top = `${Math.round(top)}px`;
}

function makeMark(type: ToastType): HTMLElement {
  const mark = document.createElement('span');
  if (type === 'error') {
    mark.style.cssText =
      `width:16px;height:16px;border-radius:50%;background:var(${弹窗变量.errorBorder},${兜底.errorBorder});color:#fff;flex:none;margin-top:2px;` +
      'font:bold 11px/16px "Segoe UI","Microsoft YaHei",sans-serif;text-align:center;';
    mark.textContent = '!';
  } else {
    const color = type === 'warning' ? `var(${弹窗变量.accent},${TOAST_ACCENT.warning})` : TOAST_ACCENT[type];
    mark.style.cssText = `width:7px;height:7px;border-radius:50%;background:${color};flex:none;margin-top:7px;`;
  }
  return mark;
}

function dismiss(el: HTMLElement, timer: ReturnType<typeof setTimeout>) {
  if (el.dataset.dismissed) return;
  el.dataset.dismissed = '1';
  clearTimeout(timer);
  const doc = el.ownerDocument;
  el.style.animation = 'bfToastOut .2s ease forwards';
  window.setTimeout(() => {
    el.remove();
    reposition(doc);
  }, 210);
}

export function showToast(type: ToastType, message: string, title?: string): void {
  const doc = parentDoc();
  if (!doc) return;
  ensureStyles(doc);
  const stack = ensureStack(doc);
  const el = doc.createElement('div');
  el.style.cssText = BASE_STYLE + TOAST_STYLE[type];
  el.append(makeMark(type));
  const body = doc.createElement('span');
  if (title) {
    const label = doc.createElement('b');
    label.style.cssText = 'font-weight:600;margin-right:6px;';
    label.textContent = title;
    body.append(label);
  }
  body.append(doc.createTextNode(message));
  el.append(body);
  el.addEventListener('click', () => dismiss(el, timer));
  stack.appendChild(el);
  const timer = setTimeout(() => dismiss(el, timer), TOAST_DURATION[type]);
  reposition(doc);
}

export const toastSuccess = (message: string, title?: string) => showToast('success', message, title);
export const toastInfo = (message: string, title?: string) => showToast('info', message, title);
export const toastWarning = (message: string, title?: string) => showToast('warning', message, title);
export const toastError = (message: string, title?: string) => showToast('error', message, title);

/** 弹窗配色(可选给, 没给的项用样式里的兜底值); 具体键与变量名见 theme.ts */
export type ToastColors = Partial<弹窗配色>;

/** 悬浮球界面把面板主题色写给弹窗容器(两个 iframe 上下文经 DOM 共享), 浅色/深色主题跟随面板 */
export function setToastColors(colors: ToastColors): void {
  const doc = parentDoc();
  if (!doc) return;
  const stack = ensureStack(doc);
  for (const [key, prop] of Object.entries(弹窗变量) as [keyof 弹窗配色, string][]) {
    const value = colors[key];
    if (value) stack.style.setProperty(prop, value);
  }
}

/** 悬浮球界面在球移动/初始化时调用, 让弹窗跟随球的位置 */
export function setToastAnchor(x: number, y: number): void {
  const doc = parentDoc();
  if (!doc) return;
  let marker = doc.getElementById('bf-toast-anchor');
  if (!marker) {
    marker = doc.createElement('div');
    marker.id = 'bf-toast-anchor';
    marker.style.cssText = 'display:none;';
    doc.body.appendChild(marker);
  }
  marker.setAttribute('data-x', String(Math.round(x)));
  marker.setAttribute('data-y', String(Math.round(y)));
  reposition(doc);
}
