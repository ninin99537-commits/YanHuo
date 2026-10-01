<script setup lang="ts">
import {
  PhCaretDown,
  PhCheck,
  PhCopySimple,
  PhEye,
  PhEyeSlash,
  PhGraph,
  PhLightning,
  PhMoonStars,
  PhPause,
  PhPencilSimple,
  PhPlay,
  PhPlus,
  PhScroll,
  PhSun,
  PhTrash,
  PhWind,
  PhX,
} from '@phosphor-icons/vue';
import { klona } from 'klona';
import { storeToRefs } from 'pinia';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { chatCompletion, fetchModelList } from './api';
import { useHost } from './host';
import { syncWorldbookEntry } from './inject';
import { buildInjectionPrompt } from './prompts';
import type { WorldData, WorldEvent, WorldFaction } from './schema';
import { METRIC_TREND, SEED_MATURITY } from './schema';
import { getSettings, useSettingsStore } from './settings';
import { clearAllData, UI_KEY, useConsoleStore, useDebugStore, useStateStore, useUpdatingStore } from './state';
import { setToastAnchor, setToastColors, toastError, toastInfo, toastSuccess, toastWarning } from './toast';
import { updateWorld } from './update';
import WorldEditForm from './世界编辑表单.vue';

// ---------------------------------------------------------------------------
// stores
// ---------------------------------------------------------------------------

const settingsStore = useSettingsStore();
const { settings } = storeToRefs(settingsStore);
const stateStore = useStateStore();
const { data } = storeToRefs(stateStore);
const debugStore = useDebugStore();
const { log: debugLog } = storeToRefs(debugStore);
const consoleStore = useConsoleStore();
const { lines: consoleLines } = storeToRefs(consoleStore);
const consoleLinesReversed = computed(() => [...consoleLines.value].reverse());
const updatingStore = useUpdatingStore();
const { active: updatingActive, message: updatingMessage } = storeToRefs(updatingStore);

// ---------------------------------------------------------------------------
// 界面偏好(悬浮球位置/面板位置/主题)存全局变量
// ---------------------------------------------------------------------------

type Theme = 'dark' | 'light';
interface UiPrefs {
  x: number;
  y: number;
  主题: Theme;
  面板x: number | null;
  面板y: number | null;
}
const LS_KEY = '烟火_界面';
/**
 * 读取界面偏好: 优先全局变量(跨设备共享); 页面刷新后脚本启动时全局变量可能尚未从服务器
 * 加载完(读到空), 此时回退 localStorage(本机同步写入, 不受刷新时机影响), 避免位置被重置
 */
function readUiPrefs(): UiPrefs | null {
  try {
    const saved = useHost().vars.get({ type: 'global' })?.[UI_KEY];
    if (saved && typeof saved === 'object' && typeof (saved as UiPrefs).x === 'number') return saved as UiPrefs;
  } catch {
    // 忽略
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as UiPrefs;
      if (saved && typeof saved === 'object' && typeof saved.x === 'number') return saved;
    }
  } catch {
    // 忽略
  }
  return null;
}
function saveUiPrefs(prefs: UiPrefs) {
  try {
    useHost().vars.insertOrAssign({ [UI_KEY]: klona(prefs) }, { type: 'global' });
  } catch {
    // 忽略
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs));
  } catch {
    // 忽略
  }
}
function persistPrefs() {
  // 挂载完成前锚点还是无效值, 不写入, 避免把坏坐标存进全局变量
  if (!mountedDone || anchorX.value <= 0 || anchorY.value <= 0) return;
  saveUiPrefs({
    x: anchorX.value,
    y: anchorY.value,
    主题: theme.value,
    面板x: panelPos.value?.x ?? null,
    面板y: panelPos.value?.y ?? null,
  });
}

const CLOSED_SIZE = 40;
const theme = ref<Theme>(readUiPrefs()?.主题 ?? 'dark');
/** 把面板主题色同步给贴球弹窗与更新弹条(浅色/深色跟随面板) */
function applyToastTheme() {
  const root = rootEl.value;
  const s = root ? getComputedStyle(root) : null;
  const v = (name: string, fallback: string) => (s ? s.getPropertyValue(name).trim() : '') || fallback;
  const light = theme.value === 'light';
  setToastColors({
    bg: v('--yh-panel', '#202024'),
    border: v('--yh-line-strong', '#3c3c42'),
    text: v('--yh-ink', '#e9e8e6'),
    accent: v('--yh-seal', '#e0574a'),
    errorBg: light ? '#fbe9e7' : '#2a1413',
    errorBorder: v('--yh-seal', '#e0574a'),
    errorText: light ? '#8c3125' : '#ffe3de',
  });
  // 更新弹条不在弹窗容器里, 单独补主题变量
  if (pillEl.value) {
    pillEl.value.style.setProperty('--yh-toast-bg', v('--yh-panel', '#202024'));
    pillEl.value.style.setProperty('--yh-toast-border', v('--yh-line-strong', '#3c3c42'));
    pillEl.value.style.setProperty('--yh-toast-text', v('--yh-ink', '#e9e8e6'));
    pillEl.value.style.setProperty('--yh-toast-accent', v('--yh-seal', '#e0574a'));
  }
}
watch(theme, () => {
  persistPrefs();
  // 主题切换会改变阴影变量, 重算面板阴影层; 弹窗配色也跟随
  if (panelOpen.value) syncPanelShadow();
  applyToastTheme();
});

// ---------------------------------------------------------------------------
// iframe 尺寸、悬浮球拖动、面板拖动
// ---------------------------------------------------------------------------

const rootEl = ref<HTMLElement | null>(null);
const frameWin = computed<Window | null>(() => rootEl.value?.ownerDocument?.defaultView ?? null);
const frame = computed<HTMLIFrameElement | null>(
  () => (frameWin.value?.frameElement as HTMLIFrameElement | null) ?? null,
);
const parentWin = computed<Window | null>(() => frameWin.value?.parent ?? null);

const panelOpen = ref(false);
const tab = ref<'now' | 'chronicle' | 'factions' | 'world' | 'logs' | 'settings'>('now');
const isDragging = ref(false);
const isPanelDragging = ref(false);
const panelRef = ref<HTMLElement | null>(null);

/** 面板阴影载体: 挂在酒馆页面上与面板同位的纯阴影层。iframe 会被 clip-path 裁剪,
 * 内部画的阴影会出现硬边, 因此阴影移到 iframe 之外(酒馆页面)绘制 */
const panelShadowEl = ref<HTMLElement | null>(null);

function ensurePanelShadow() {
  const parentDoc = parentWin.value?.document;
  if (!parentDoc || panelShadowEl.value) return;
  const el = parentDoc.createElement('div');
  el.style.cssText =
    'position:fixed;left:0;top:0;display:none;pointer-events:none;background:transparent;z-index:2147482997;';
  parentDoc.body.appendChild(el);
  panelShadowEl.value = el;
}

function removePanelShadow() {
  panelShadowEl.value?.remove();
  panelShadowEl.value = null;
}

/** 同步阴影层的位置/圆角/阴影(跟随主题变量), 并随面板一起淡入 */
function syncPanelShadow(fade = false) {
  const shadow = panelShadowEl.value;
  if (!shadow) return;
  if (!panelOpen.value) {
    shadow.style.display = 'none';
    return;
  }
  const panel = panelRectView.value;
  shadow.style.display = 'block';
  shadow.style.left = `${panel.x}px`;
  shadow.style.top = `${panel.y}px`;
  shadow.style.width = `${panelW.value}px`;
  shadow.style.height = `${panelH.value}px`;
  const panelNode = panelRef.value;
  if (panelNode) {
    const style = getComputedStyle(panelNode);
    shadow.style.borderRadius = style.borderRadius;
    shadow.style.boxShadow = style.getPropertyValue('--yh-shadow').trim() || 'none';
  }
  if (fade)
    shadow.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'cubic-bezier(0.2, 0.9, 0.25, 1)' });
}

const viewportW = (): number => parentWin.value?.innerWidth ?? window.innerWidth;
const viewportH = (): number => parentWin.value?.innerHeight ?? window.innerHeight;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const anchorX = ref<number>(-100);
const anchorY = ref<number>(-100);
/** 面板位置(null=默认居中); 面板宽高由 CSS 决定 */
const panelPos = ref<{ x: number; y: number } | null>(null);
/** 挂载完成前 iframe 还没有布局, 视口尺寸不可信, 不计算默认锚点也不保存偏好 */
let mountedDone = false;

/** 面板尺寸(视口够小时收缩), 由 JS 按父窗口算好以内联样式固定, 避免面板依赖 iframe 视口 */
const panelW = ref(880);
const panelH = ref(620);
/** 是否窄屏(手机/窄窗口): 触发"面板近乎全屏 + 底部标签栏"的手机布局 */
const isNarrow = ref(false);
function computePanelSize() {
  isNarrow.value = viewportW() < 700;
  if (isNarrow.value) {
    // 窄屏: 面板铺满视口(只留安全边距), 高度给到可用高度的 94%——手机上小窗没有意义,
    // 全屏才能容纳五页内容; 边距从 24px 收到 8px
    panelW.value = Math.max(240, viewportW() - 8);
    panelH.value = Math.max(300, Math.round(viewportH() * 0.94));
  } else {
    panelW.value = Math.min(880, viewportW() - 24);
    panelH.value = Math.min(620, viewportH() - 24);
  }
}
/** 面板的视口位置(未拖动时居中); 若与悬浮球重叠, 自动沿有空间的方向推开 */
const panelRectView = computed(() => {
  const raw = panelPos.value ?? { x: (viewportW() - panelW.value) / 2, y: (viewportH() - panelH.value) / 2 };
  let x = clamp(raw.x, 8, Math.max(8, viewportW() - panelW.value - 8));
  let y = clamp(raw.y, 8, Math.max(8, viewportH() - panelH.value - 8));
  // 球的外扩矩形(含 6px 呼吸空间)
  const orbL = anchorX.value - CLOSED_SIZE / 2 - 6;
  const orbR = anchorX.value + CLOSED_SIZE / 2 + 6;
  const orbT = anchorY.value - CLOSED_SIZE / 2 - 6;
  const orbB = anchorY.value + CLOSED_SIZE / 2 + 6;
  const overlaps = () => orbR > x && orbL < x + panelW.value && orbB > y && orbT < y + panelH.value;
  if (overlaps()) {
    const spaceRight = viewportW() - orbR - 8;
    const spaceLeft = orbL - 8;
    if (spaceRight >= panelW.value) x = orbR + 8;
    else if (spaceLeft >= panelW.value) x = Math.max(8, orbL - panelW.value - 8);
    if (overlaps()) {
      const spaceBottom = viewportH() - orbB - 8;
      const spaceTop = orbT - 8;
      if (spaceBottom >= panelH.value) y = orbB + 8;
      else if (spaceTop >= panelH.value) y = Math.max(8, orbT - panelH.value - 8);
    }
  }
  return { x, y };
});
/** iframe 当前原点(视口坐标), 面板打开时 iframe 只罩住"面板+球"的联合矩形 */
const frameOrigin = ref({ x: 0, y: 0 });

const panelStyleRef = computed<Record<string, string>>(() => ({
  left: `${panelRectView.value.x - frameOrigin.value.x}px`,
  top: `${panelRectView.value.y - frameOrigin.value.y}px`,
  width: `${panelW.value}px`,
  height: `${panelH.value}px`,
}));

function applyFrame() {
  const target = frame.value;
  if (!target) return;
  if (!panelOpen.value) {
    // 关闭: iframe 缩到球的大小跟随锚点, 不遮挡酒馆其他区域。
    // iframe 元素本身也裁成圆形——否则四个透明方角会把底下(可能是浅色的)楼层界面露出来,
    // 看起来就像球自带一个方形背景
    target.style.width = `${CLOSED_SIZE}px`;
    target.style.height = `${CLOSED_SIZE}px`;
    target.style.left = `${clamp(anchorX.value - CLOSED_SIZE / 2, 2, Math.max(2, viewportW() - CLOSED_SIZE - 2))}px`;
    target.style.top = `${clamp(anchorY.value - CLOSED_SIZE / 2, 2, Math.max(2, viewportH() - CLOSED_SIZE - 2))}px`;
    target.style.borderRadius = '50%';
    target.style.clipPath = 'none';
    syncPanelShadow();
    frameOrigin.value = {
      x: clamp(anchorX.value - CLOSED_SIZE / 2, 2, Math.max(2, viewportW() - CLOSED_SIZE - 2)),
      y: clamp(anchorY.value - CLOSED_SIZE / 2, 2, Math.max(2, viewportH() - CLOSED_SIZE - 2)),
    };
    return;
  }
  // 打开: iframe 罩住"面板+球"的联合矩形, 其余区域酒馆照常可点
  computePanelSize();
  const panel = panelRectView.value;
  const orbL = clamp(anchorX.value - CLOSED_SIZE / 2, 0, Math.max(0, viewportW() - CLOSED_SIZE));
  const orbT = clamp(anchorY.value - CLOSED_SIZE / 2, 0, Math.max(0, viewportH() - CLOSED_SIZE));
  const left = Math.max(0, Math.min(orbL, panel.x) - 4);
  const top = Math.max(0, Math.min(orbT, panel.y) - 4);
  const right = Math.min(viewportW(), Math.max(orbL + CLOSED_SIZE, panel.x + panelW.value) + 4);
  const bottom = Math.min(viewportH(), Math.max(orbT + CLOSED_SIZE, panel.y + panelH.value) + 4);
  target.style.left = `${left}px`;
  target.style.top = `${top}px`;
  target.style.width = `${right - left}px`;
  target.style.height = `${bottom - top}px`;
  target.style.borderRadius = '12px';
  frameOrigin.value = { x: left, y: top };
  // 把 iframe 的可点/可见区域裁剪成"球的圆形 ∪ 面板矩形"两个子形状的并集(同为顺时针绕向,
  // nonzero 填充规则下不会互相挖洞): 联合矩形中间的透明空隙不再挡住底下其他插件的悬浮球等
  // 元素——clip-path 会同时裁剪渲染与命中测试。面板的阴影不画在 iframe 内(会被裁出硬边),
  // 而是画在酒馆页面上的阴影层里(syncPanelShadow)。
  const pad = 4;
  const r = CLOSED_SIZE / 2 + 4;
  const bcx = anchorX.value - left;
  const bcy = anchorY.value - top;
  const px = panel.x - left - pad;
  const py = panel.y - top - pad;
  const pw = panelW.value + pad * 2;
  const ph = panelH.value + pad * 2;
  target.style.clipPath =
    `path('M ${bcx - r} ${bcy} A ${r} ${r} 0 1 1 ${bcx + r} ${bcy} A ${r} ${r} 0 1 1 ${bcx - r} ${bcy} Z ` +
    `M ${px} ${py} H ${px + pw} V ${py + ph} H ${px} Z')`;
  syncPanelShadow();
}

function onViewportResize() {
  anchorX.value = clamp(anchorX.value, CLOSED_SIZE / 2, viewportW() - CLOSED_SIZE / 2);
  anchorY.value = clamp(anchorY.value, CLOSED_SIZE / 2, viewportH() - CLOSED_SIZE / 2);
  // 拖动过的面板跟随视口收回可视范围
  if (panelPos.value) {
    computePanelSize();
    panelPos.value = {
      x: clamp(panelPos.value.x, 8, Math.max(8, viewportW() - panelW.value - 8)),
      y: clamp(panelPos.value.y, 8, Math.max(8, viewportH() - panelH.value - 8)),
    };
  }
  applyFrame();
}

watch([panelOpen, anchorX, anchorY, panelPos], applyFrame);
watch([anchorX, anchorY], () => persistPrefs());

/** 球在 iframe 内的位置: 关闭时填满小 iframe, 打开时按锚点相对 iframe 原点定位 */
const orbStyle = computed(() =>
  panelOpen.value
    ? {
        left: `${clamp(anchorX.value - CLOSED_SIZE / 2, 0, Math.max(0, viewportW() - CLOSED_SIZE)) - frameOrigin.value.x}px`,
        top: `${clamp(anchorY.value - CLOSED_SIZE / 2, 0, Math.max(0, viewportH() - CLOSED_SIZE)) - frameOrigin.value.y}px`,
      }
    : { left: '0px', top: '0px' },
);

let startX = 0;
let startY = 0;
let startAnchorX = 0;
let startAnchorY = 0;
let moved = false;

function parentClient(e: PointerEvent): { x: number; y: number } {
  const rect = frame.value?.getBoundingClientRect();
  if (e.view === frameWin.value && rect) {
    return { x: rect.left + e.clientX, y: rect.top + e.clientY };
  }
  return { x: e.clientX, y: e.clientY };
}

// ---- 悬浮球拖动 ----

function onOrbPointerDown(e: PointerEvent) {
  e.preventDefault();
  isDragging.value = true;
  moved = false;
  const rect = frame.value?.getBoundingClientRect();
  startX = (rect?.left ?? 0) + e.clientX;
  startY = (rect?.top ?? 0) + e.clientY;
  startAnchorX = anchorX.value;
  startAnchorY = anchorY.value;
  frameWin.value?.addEventListener('pointermove', onOrbMove);
  frameWin.value?.addEventListener('pointerup', onOrbUp);
  parentWin.value?.addEventListener('pointermove', onOrbMove);
  parentWin.value?.addEventListener('pointerup', onOrbUp);
}

function onOrbMove(e: PointerEvent) {
  const point = parentClient(e);
  if (Math.abs(point.x - startX) + Math.abs(point.y - startY) > 4) moved = true;
  anchorX.value = clamp(startAnchorX + (point.x - startX), CLOSED_SIZE / 2, viewportW() - CLOSED_SIZE / 2);
  anchorY.value = clamp(startAnchorY + (point.y - startY), CLOSED_SIZE / 2, viewportH() - CLOSED_SIZE / 2);
}

function onOrbUp() {
  isDragging.value = false;
  frameWin.value?.removeEventListener('pointermove', onOrbMove);
  frameWin.value?.removeEventListener('pointerup', onOrbUp);
  parentWin.value?.removeEventListener('pointermove', onOrbMove);
  parentWin.value?.removeEventListener('pointerup', onOrbUp);
  window.setTimeout(() => {
    moved = false;
  }, 200);
}

function onOrbClick() {
  if (moved) {
    moved = false;
    return;
  }
  panelOpen.value = !panelOpen.value;
}

function closePanel() {
  panelOpen.value = false;
}

// ---------------------------------------------------------------------------
// 推进中弹条(挂在酒馆页面上, 面板收起时也可见, 可中断)
// ---------------------------------------------------------------------------

const pillEl = ref<HTMLElement | null>(null);

function removeUpdatePill() {
  pillEl.value?.remove();
  pillEl.value = null;
}

/** 弹条贴着悬浮球左方弹出(左方空间不足则弹到右方), 垂直居中对齐球, 跟随球的位置 */
function positionUpdatePill() {
  const el = pillEl.value;
  if (!el) return;
  const vw = viewportW();
  const vh = viewportH();
  // 窄屏: 弹条太宽会超出视口, 先压缩内容(允许换行)再定位
  if (vw < 700) {
    el.style.whiteSpace = 'normal';
    el.style.maxWidth = `${Math.min(240, vw - 96)}px`;
  }
  const w = el.offsetWidth || 160;
  const h = el.offsetHeight || 32;
  const ballL = anchorX.value - CLOSED_SIZE / 2;
  const ballR = anchorX.value + CLOSED_SIZE / 2;
  let left = ballL - w - 10;
  if (left < 8) left = ballR + 10;
  left = clamp(left, 8, Math.max(8, vw - w - 8));
  const top = clamp(anchorY.value - h / 2, 8, Math.max(8, vh - h - 8));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function ensureUpdatePill() {
  const parentDoc = parentWin.value?.document;
  if (!parentDoc || pillEl.value) return;
  const el = parentDoc.createElement('div');
  el.style.cssText =
    'position:fixed;top:0;left:0;display:flex;align-items:center;gap:9px;padding:7px 9px 7px 15px;border-radius:999px;background:var(--yh-toast-bg,#202024);border:1px solid var(--yh-toast-border,#3c3c42);color:var(--yh-toast-text,#e9e8e6);font:12px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);z-index:2147482999;cursor:pointer;white-space:nowrap;transform-origin:left center;animation:yhPillIn .32s cubic-bezier(.34,1.56,.64,1);';
  const keyframes = parentDoc.createElement('style');
  keyframes.textContent =
    '@keyframes yhPillBreath{0%,100%{opacity:.35}50%{opacity:1}}@keyframes yhPillIn{from{opacity:0;transform:translateX(14px) scale(.9)}to{opacity:1;transform:none}}';
  const dot = parentDoc.createElement('span');
  dot.style.cssText =
    'width:7px;height:7px;border-radius:50%;background:var(--yh-toast-accent,#e0574a);animation:yhPillBreath 1.4s ease-in-out infinite;flex:none;';
  const text = parentDoc.createElement('span');
  text.textContent = updatingMessage.value || '世界运转中…';
  const btn = parentDoc.createElement('button');
  btn.textContent = '中断';
  btn.style.cssText =
    'padding:3px 11px;border-radius:999px;border:1px solid var(--yh-toast-accent,#e0574a);background:transparent;color:var(--yh-toast-accent,#e0574a);cursor:pointer;font:12px "Segoe UI","Microsoft YaHei",sans-serif;';
  btn.addEventListener('click', ev => {
    ev.stopPropagation();
    updatingStore.cancel();
  });
  el.addEventListener('click', () => {
    panelOpen.value = true;
  });
  el.append(keyframes, dot, text, btn);
  parentDoc.body.appendChild(el);
  pillEl.value = el;
  applyToastTheme();
  positionUpdatePill();
}

watch([updatingActive, panelOpen], ([active, open]) => {
  if (active && !open) ensureUpdatePill();
  else removeUpdatePill();
});
watch(updatingMessage, msg => {
  if (pillEl.value) pillEl.value.children[2].textContent = msg || '世界运转中…';
});
// 拖动球时弹条与弹窗跟随
watch([anchorX, anchorY], () => {
  if (pillEl.value) positionUpdatePill();
  setToastAnchor(anchorX.value, anchorY.value);
});
// 面板阴影随面板一起淡入
watch(panelOpen, open => {
  if (open) syncPanelShadow(true);
});
parentWin.value?.addEventListener('resize', () => positionUpdatePill());
onUnmounted(removeUpdatePill);

// ---- 面板拖动(按住头部空白处) ----

const headerEl = ref<HTMLElement | null>(null);

function onPanelPointerDown(e: PointerEvent) {
  const target = e.target as HTMLElement;
  if (target.closest('button, input, select, textarea, a')) return;
  e.preventDefault();
  isPanelDragging.value = true;
  // 全程用视口坐标计算, iframe 跟随移动不影响手感。
  // 注意: iframe 内元素的 getBoundingClientRect 是 iframe 局部坐标, 要加上 iframe 原点才是视口坐标
  const panelEl = headerEl.value?.closest('.yh-panel') as HTMLElement | null;
  const panelRect = panelEl?.getBoundingClientRect();
  const fr = frame.value?.getBoundingClientRect();
  const panelLeftV = (panelRect?.left ?? 0) + (fr?.left ?? 0);
  const panelTopV = (panelRect?.top ?? 0) + (fr?.top ?? 0);
  const start = parentClient(e);
  const grabX = start.x - panelLeftV;
  const grabY = start.y - panelTopV;
  panelPos.value = { ...panelRectView.value };

  const onMove = (ev: PointerEvent) => {
    const point = parentClient(ev);
    panelPos.value = {
      x: clamp(point.x - grabX, 8, Math.max(8, viewportW() - panelW.value - 8)),
      y: clamp(point.y - grabY, 8, Math.max(8, viewportH() - panelH.value - 8)),
    };
    applyFrame();
  };
  const onUp = () => {
    isPanelDragging.value = false;
    frameWin.value?.removeEventListener('pointermove', onMove);
    frameWin.value?.removeEventListener('pointerup', onUp);
    parentWin.value?.removeEventListener('pointermove', onMove);
    parentWin.value?.removeEventListener('pointerup', onUp);
    persistPrefs();
  };
  frameWin.value?.addEventListener('pointermove', onMove);
  frameWin.value?.addEventListener('pointerup', onUp);
  parentWin.value?.addEventListener('pointermove', onMove);
  parentWin.value?.addEventListener('pointerup', onUp);
}

// ---------------------------------------------------------------------------
// 世界数据视图
// ---------------------------------------------------------------------------

const world = computed<WorldData>(() => data.value);
const hasWorld = computed(() =>
  Boolean(
    world.value.世界.时间 ||
    world.value.世界.总览 ||
    world.value.事件.length > 0 ||
    Object.keys(world.value.势力).length > 0 ||
    Object.keys(world.value.地域 ?? {}).length > 0 ||
    Object.keys(world.value.大势 ?? {}).length > 0 ||
    (world.value.伏笔 ?? []).length > 0 ||
    (world.value.节令 ?? []).length > 0 ||
    Object.keys(world.value.指标 ?? {}).length > 0,
  ),
);
const activeEvents = computed(() =>
  world.value.事件
    .filter(event => event.阶段 !== '已结束')
    .slice(-4)
    .reverse(),
);
const factionEntries = computed(() => Object.entries(world.value.势力));
const regionEntries = computed(() => Object.entries(world.value.地域 ?? {}));
const trendEntries = computed(() => Object.entries(world.value.大势 ?? {}));
const seedList = computed(() => world.value.伏笔 ?? []);
const occasionList = computed(() => world.value.节令 ?? []);
const metricEntries = computed(() => Object.entries(world.value.指标 ?? {}));

// ---- 世界页手动编辑: 五层共用一套「名称+字段」增删改 ----
type WorldLayer = '地域' | '大势' | '伏笔' | '节令' | '指标';
const layerFields: Record<WorldLayer, { key: string; label: string; enum?: readonly string[]; multiline?: boolean }[]> = {
  地域: [
    { key: '名称', label: '名称' },
    { key: '概况', label: '概况', multiline: true },
    { key: '局势', label: '局势', multiline: true },
    { key: '当权者', label: '当权者' },
    { key: '对外关系', label: '对外关系', multiline: true },
    { key: '前情', label: '前情', multiline: true },
  ],
  大势: [
    { key: '名称', label: '名称' },
    { key: '概况', label: '概况', multiline: true },
    { key: '进展', label: '进展', multiline: true },
    { key: '走向', label: '走向', multiline: true },
    { key: '前情', label: '前情', multiline: true },
  ],
  伏笔: [
    { key: '标题', label: '标题' },
    { key: '埋设', label: '埋设', multiline: true },
    { key: '指向', label: '指向', multiline: true },
    { key: '成熟度', label: '成熟度', enum: SEED_MATURITY },
    { key: '前情', label: '前情', multiline: true },
  ],
  节令: [
    { key: '名称', label: '名称' },
    { key: '周期', label: '周期' },
    { key: '时间', label: '时间(下次发生)' },
    { key: '概况', label: '概况', multiline: true },
  ],
  指标: [
    { key: '名称', label: '名称' },
    { key: '值', label: '值' },
    { key: '趋势', label: '趋势', enum: METRIC_TREND },
    { key: '说明', label: '说明', multiline: true },
  ],
};
const worldEditing = ref(false);
const worldDraft = ref<{ layer: WorldLayer; key: string; fields: Record<string, string> }>({ layer: '地域', key: '', fields: {} });
function startWorldEdit(layer: WorldLayer, key: string, item: Record<string, unknown>) {
  const fields: Record<string, string> = {};
  for (const f of layerFields[layer]) fields[f.key] = String(item[f.key] ?? (f.key === '名称' || f.key === '标题' ? key : ''));
  worldDraft.value = { layer, key, fields };
  worldEditing.value = true;
}
function startWorldAdd(layer: WorldLayer) {
  const fields: Record<string, string> = {};
  for (const f of layerFields[layer]) fields[f.key] = f.enum ? String(f.enum[0]) : '';
  worldDraft.value = { layer, key: '', fields };
  worldEditing.value = true;
}
function saveWorldEdit() {
  const { layer, key, fields } = worldDraft.value;
  const nameKey = layer === '伏笔' ? '标题' : '名称';
  const name = String(fields[nameKey] ?? '').trim();
  if (!name) {
    toastWarning('名称不能为空', '烟火');
    return;
  }
  const d = data.value as any;
  if (layer === '地域' || layer === '大势' || layer === '指标') {
    const store = (d[layer] ??= {}) as Record<string, Record<string, string>>;
    const payload: Record<string, string> = {};
    for (const f of layerFields[layer]) if (f.key !== '名称') payload[f.key] = String(fields[f.key] ?? '');
    if (key && key !== name) delete store[key];
    store[name] = { ...store[name], ...payload };
  } else if (layer === '伏笔') {
    const arr = (d.伏笔 ??= []) as any[];
    const idx = key ? arr.findIndex(item => item.标题 === key) : -1;
    const entry = { 标题: name, 埋设: fields.埋设 ?? '', 指向: fields.指向 ?? '', 成熟度: fields.成熟度 ?? '酝酿', 前情: fields.前情 ?? '' };
    if (idx >= 0) arr[idx] = entry;
    else arr.push(entry);
  } else {
    const arr = (d.节令 ??= []) as any[];
    const idx = key ? arr.findIndex(item => item.名称 === key) : -1;
    const entry = { 名称: name, 周期: fields.周期 ?? '', 时间: fields.时间 ?? '', 概况: fields.概况 ?? '' };
    if (idx >= 0) arr[idx] = entry;
    else arr.push(entry);
  }
  saveAndSync();
  worldEditing.value = false;
  toastSuccess(`已保存${layer}「${name}」, 注入内容已同步`, '烟火');
}
function removeWorldItem(layer: WorldLayer, key: string) {
  const d = data.value as any;
  if (layer === '地域' || layer === '大势' || layer === '指标') delete (d[layer] ?? {})[key];
  else if (layer === '伏笔') d.伏笔 = (d.伏笔 ?? []).filter((item: any) => item.标题 !== key);
  else d.节令 = (d.节令 ?? []).filter((item: any) => item.名称 !== key);
  if (worldEditing.value && worldDraft.value.layer === layer && worldDraft.value.key === key) worldEditing.value = false;
  saveAndSync();
}

const stageFilter = ref<'全部' | '进行中' | '已结束'>('全部');
const scaleFilter = ref<'全部' | '要事' | '大事'>('全部');
const chronicleEvents = computed(() => {
  const events = [...world.value.事件].reverse();
  return events.filter(event => {
    if (stageFilter.value === '进行中' && event.阶段 === '已结束') return false;
    if (stageFilter.value === '已结束' && event.阶段 !== '已结束') return false;
    if (scaleFilter.value !== '全部' && event.规模 !== scaleFilter.value) return false;
    return true;
  });
});
const selectedFaction = ref<string>('');
watch(factionEntries, entries => {
  if (!entries.some(([name]) => name === selectedFaction.value)) {
    selectedFaction.value = entries[0]?.[0] ?? '';
  }
});
const selectedFactionData = computed(
  () => factionEntries.value.find(([name]) => name === selectedFaction.value)?.[1] ?? null,
);

function trendArrow(trend: string): string {
  return trend === '上升' ? '↑' : trend === '下降' ? '↓' : '→';
}

function fmtTimestamp(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '';
}

// ---------------------------------------------------------------------------
// 手动编辑(修笔) — 所有编辑保存后立即落快照并同步世界书注入
// ---------------------------------------------------------------------------

/** 保存世界数据并同步「【烟火】世界动向」注入内容(开关关闭时同步会删除条目) */
function saveAndSync() {
  stateStore.save();
  const s = getSettings();
  syncWorldbookEntry(stateStore.data, s.启用运转 && s.运转.注入世界书条目, s).catch(error => {
    console.error('[烟火] 手动编辑后同步世界书条目失败:', error);
  });
}

/** 切换「启用世界运转」/「注入世界动向到主AI」时立即生效: 关=删条目, 开=建/刷新条目 */
watch(
  () => [settings.value.启用运转, settings.value.运转.注入世界书条目],
  ([启用运转, 注入]) => {
    syncWorldbookEntry(stateStore.data, 启用运转 && 注入, settings.value).catch(error => {
      console.error('[烟火] 切换注入开关后同步世界书条目失败:', error);
    });
  },
);

const editOpen = ref(false);
const editDraft = ref({ 时间: '', 氛围: '', 总览: '' });
function openEdit() {
  editDraft.value = {
    时间: world.value.世界.时间,
    氛围: world.value.世界.氛围,
    总览: world.value.世界.总览,
  };
  editOpen.value = true;
}
function saveEdit() {
  data.value.世界.时间 = editDraft.value.时间.trim();
  data.value.世界.氛围 = editDraft.value.氛围.trim();
  data.value.世界.总览 = editDraft.value.总览.trim();
  saveAndSync();
  editOpen.value = false;
  toastSuccess('已保存世界概述, 注入内容已同步');
}
function removeEvent(event: WorldEvent) {
  data.value.事件 = data.value.事件.filter(item => item !== event);
  saveAndSync();
  toastInfo(`已移除事件「${event.标题}」, 注入内容已同步`, '烟火');
}
function removeFaction(name: string) {
  delete data.value.势力[name];
  saveAndSync();
  toastInfo(`已移除势力「${name}」, 注入内容已同步`, '烟火');
}
function selectFaction(name: string) {
  selectedFaction.value = name;
  tab.value = 'factions';
}

/** 事件编辑: 一次编辑一条, 按对象引用定位 */
const editingEvent = ref<WorldEvent | null>(null);
const eventDraft = ref<WorldEvent>({
  id: '',
  标题: '',
  描述: '',
  地点: '',
  时间: '',
  规模: '要事',
  传播: '本埠',
  渠道: '',
  势力: '',
  阶段: '进行',
  隐秘: '公开',
  前情: '',
  代表人物: '',
  演变: [],
});
function startEditEvent(event: WorldEvent) {
  editingEvent.value = event;
  eventDraft.value = { ...event };
}
function saveEventEdit() {
  const idx = data.value.事件.indexOf(editingEvent.value);
  if (idx >= 0) {
    data.value.事件[idx] = {
      ...eventDraft.value,
      标题: eventDraft.value.标题.trim() || '未命名事件',
      描述: eventDraft.value.描述.trim() || '（无描述）',
    };
    saveAndSync();
    toastSuccess('已保存事件修改, 注入内容已同步');
  }
  editingEvent.value = null;
}

/** 势力编辑(在脉络详情页) */
const factionEditing = ref(false);
const factionDraft = ref<WorldFaction>({
  目标: '',
  动向: '',
  前情: '',
  势力范围: '',
  对外关系: '',
  头面人物: '',
});
/** 选中势力关联的进行中/最近事件(从事件的势力字段派生, 不让 AI 写) */
const factionRelatedEvents = computed(() =>
  world.value.事件
    .filter(event => event.势力 === selectedFaction.value)
    .slice(-6)
    .reverse(),
);
function startEditFaction() {
  if (!selectedFactionData.value) return;
  factionDraft.value = { ...selectedFactionData.value };
  factionEditing.value = true;
}
function saveFactionEdit() {
  const name = selectedFaction.value;
  if (name && data.value.势力[name]) {
    data.value.势力[name] = { ...factionDraft.value };
    saveAndSync();
    toastSuccess('已保存势力修改, 注入内容已同步');
  }
  factionEditing.value = false;
}
watch(selectedFaction, () => {
  factionEditing.value = false;
});

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

async function tickNow() {
  await updateWorld(true);
  stateStore.reload();
}
const confirmClear = ref(false);
let confirmClearTimer: ReturnType<typeof setTimeout> | null = null;
async function clearWorld() {
  if (!confirmClear.value) {
    confirmClear.value = true;
    if (confirmClearTimer) clearTimeout(confirmClearTimer);
    confirmClearTimer = setTimeout(() => {
      confirmClear.value = false;
    }, 3000);
    return;
  }
  confirmClear.value = false;
  clearAllData();
  stateStore.reload();
  // 清空后世界为空, 删除角色卡主世界书里的「世界动向」条目(对齐彼方清空逻辑)
  const s = getSettings();
  syncWorldbookEntry(stateStore.data, false, s).catch(error => {
    console.error('[烟火] 清空后删除世界书条目失败:', error);
  });
  toastSuccess('世界已归零: 快照清空, 世界书条目已删除, 之后只推进新楼层');
}

// ---------------------------------------------------------------------------
// 设置操作
// ---------------------------------------------------------------------------

const showKey = ref(false);
const fetchingModels = ref(false);
const testing = ref(false);
async function onFetchModels() {
  fetchingModels.value = true;
  try {
    const list = await fetchModelList();
    settings.value.接口.模型列表 = list;
    toastSuccess(`获取到 ${list.length} 个模型`);
  } catch (error) {
    toastError(error instanceof Error ? error.message : String(error), '烟火·获取模型失败');
  } finally {
    fetchingModels.value = false;
  }
}
async function onTestConnection() {
  testing.value = true;
  try {
    const content = await chatCompletion([{ role: 'user', content: '收到请只回复两个字: 成功' }], { max_tokens: 16 });
    toastSuccess(`连接成功: ${content.trim().slice(0, 40)}`);
  } catch (error) {
    toastError(error instanceof Error ? error.message : String(error), '烟火·测试失败');
  } finally {
    testing.value = false;
  }
}

// 接口配置预设: 保存/加载/删除多套接口配置
const presetName = ref('');
const selectedPreset = ref('');
const presetNames = computed(() => Object.keys(settings.value.接口预设 ?? {}));
function saveApiPreset() {
  const name = String(presetName.value).trim();
  if (!name) {
    toastWarning('请填写预设名');
    return;
  }
  if (!settings.value.接口预设) settings.value.接口预设 = {};
  settings.value.接口预设[name] = klona(settings.value.接口);
  presetName.value = '';
  selectedPreset.value = name;
  toastSuccess(`已保存接口配置预设「${name}」`);
}
function loadApiPreset() {
  const name = String(selectedPreset.value).trim();
  if (!name || !settings.value.接口预设?.[name]) {
    toastWarning('请选择要加载的预设');
    return;
  }
  settings.value.接口 = klona(settings.value.接口预设[name]);
  toastSuccess(`已加载接口配置预设「${name}」`);
}
function deleteApiPreset() {
  const name = String(selectedPreset.value).trim();
  if (!name || !settings.value.接口预设?.[name]) {
    toastWarning('请选择要删除的预设');
    return;
  }
  delete settings.value.接口预设[name];
  selectedPreset.value = '';
  toastSuccess(`已删除接口配置预设「${name}」`);
}

/** 列表设置(排除条目/标签)的文本双向绑定: 逗号/顿号/空格分隔 */
function listText(key: '世界书排除' | '标签列表') {
  if (key === '世界书排除') {
    return computed({
      get: () => (settings.value.运转.世界书排除 ?? []).join('、'),
      set: (text: string) => {
        settings.value.运转.世界书排除 = text
          .split(/[,,、\s]+/)
          .map(item => item.trim())
          .filter(Boolean);
      },
    });
  }
  return computed({
    get: () => (settings.value.标签.列表 ?? []).join('、'),
    set: (text: string) => {
      settings.value.标签.列表 = text
        .split(/[,,、\s]+/)
        .map(item => item.trim().replace(/^<|>$/g, ''))
        .filter(Boolean);
    },
  });
}
const worldbookExcludeText = listText('世界书排除');
const tagListText = listText('标签列表');

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

function joinRecord(): string {
  const log = debugLog.value;
  if (!log) return '(暂无推进记录)';
  const parts = [
    '[烟火] 推进记录',
    `时间: ${fmtTimestamp(log.time)} / 模型: ${log.model || '(未选)'} / 楼层: ${log.replyIds.length > 0 ? log.replyIds.map(id => `#${id}`).join(', ') : '(无)'} / 小结: ${log.summary || '(无)'}`,
    ...(log.addedEvents.length > 0 ? [`新增事件: ${log.addedEvents.join('、')}`] : []),
    ...(log.updatedEvents.length > 0 ? [`推进事件: ${log.updatedEvents.join('、')}`] : []),
    ...(log.removedEvents.length > 0 ? [`了结事件: ${log.removedEvents.join('、')}`] : []),
    ...(log.request ? ['\n── 发送给世界引擎的内容 ──\n' + log.request] : []),
    ...(log.response ? ['\n── 世界引擎输出 ──\n' + log.response] : []),
    ...(log.error ? ['\n── 报错 ──\n' + log.error] : []),
  ];
  return parts.join('\n');
}
function buildErrorReport(): string {
  const log = debugLog.value;
  const settingsNow = getSettings();
  const parts = [
    '[烟火] 报错报告',
    `时间: ${fmtTimestamp(log?.time)} / 模型: ${settingsNow.接口.模型 || '(未选)'} / 服务端转发: ${settingsNow.接口.服务端转发 ? '开' : '关'}`,
    ...(log?.replyIds?.length ? [`楼层: ${log.replyIds.map(id => `#${id}`).join(', ')}`] : []),
    ...(log?.request ? ['\n── 发送给世界引擎的内容 ──\n' + log.request] : []),
    ...(log?.response ? ['\n── 世界引擎输出 ──\n' + log.response] : []),
    ...(log?.error ? ['\n── 报错 ──\n' + log.error] : ['\n(无报错记录——请描述你遇到的问题)']),
  ];
  return parts.join('\n');
}
async function copyText(text: string, tip = '已复制到剪贴板') {
  // iframe 内 navigator.clipboard 常被权限策略禁用, 优先用父窗口的剪贴板
  const clipboard = parentWin.value?.navigator.clipboard ?? navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      toastSuccess(tip);
      return;
    } catch {
      // 落入降级
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    toastSuccess(tip);
  } catch {
    toastError('复制失败, 请手动选择文本复制', '烟火');
  }
}
const injectionPreview = ref<string | null>(null);
function showInjection() {
  injectionPreview.value = buildInjectionPrompt(world.value, getSettings());
}
const collapsed = ref<Record<string, boolean>>({});
function toggleCollapse(key: string) {
  collapsed.value[key] = !collapsed.value[key];
}

/** 风闻页事件「演变」时间线的展开状态(键=事件 id, 无 id 时退回标题——id 稳定, 改名/重排不丢展开状态) */
const trailOpen = ref<Record<string, boolean>>({});
function toggleTrail(key: string) {
  trailOpen.value[key] = !trailOpen.value[key];
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

onMounted(() => {
  const saved = readUiPrefs();
  const vw = viewportW();
  const vh = viewportH();
  if (saved) {
    if (typeof saved.x === 'number' && saved.x >= CLOSED_SIZE / 2 && saved.x <= vw - CLOSED_SIZE / 2)
      anchorX.value = saved.x;
    if (typeof saved.y === 'number' && saved.y >= CLOSED_SIZE / 2 && saved.y <= vh - CLOSED_SIZE / 2)
      anchorY.value = saved.y;
    if (typeof saved.面板x === 'number' && typeof saved.面板y === 'number')
      panelPos.value = { x: saved.面板x, y: saved.面板y };
  }
  // 无有效存档时给默认位置: 右下角(避开酒馆自带的悬浮元素)
  if (anchorX.value <= 0) anchorX.value = Math.max(CLOSED_SIZE / 2, vw - 60);
  if (anchorY.value <= 0) anchorY.value = Math.max(CLOSED_SIZE / 2, vh - 130);
  mountedDone = true;
  ensurePanelShadow();
  applyFrame();
  applyToastTheme();
  setToastAnchor(anchorX.value, anchorY.value);
  parentWin.value?.addEventListener('resize', onViewportResize);
});
onUnmounted(() => {
  parentWin.value?.removeEventListener('resize', onViewportResize);
  removePanelShadow();
});

const tabs = [
  { key: 'now', label: '此刻' },
  { key: 'chronicle', label: '风闻' },
  { key: 'factions', label: '势力' },
  { key: 'world', label: '世界' },
  { key: 'logs', label: '日志' },
  { key: 'settings', label: '设置' },
] as const;

const scaleLabel: Record<string, string> = { 要事: '要事', 大事: '大事' };
</script>

<template>
  <div ref="rootEl" class="yh-root" :data-theme="theme">
    <!-- 悬浮球: 扁平墨印, 一点青瓷 -->
    <button
      class="yh-orb"
      :class="{ 'is-dragging': isDragging, 'is-updating': updatingActive, 'is-open': panelOpen }"
      :style="orbStyle"
      title="烟火 · 世界运转"
      @pointerdown="onOrbPointerDown"
      @click="onOrbClick"
    >
      <svg class="yh-orb-mark" viewBox="0 0 24 24" aria-hidden="true">
        <path class="yh-flame" d="M13.6 4.8 17.9 15.6 16.4 18.8 8 18.8 6.5 15.4 10.6 8.4 12.4 11.2Z" />
      </svg>
    </button>

    <!-- 面板: 小窗悬在酒馆上空, iframe 只罩住面板+球, 其余区域酒馆照常可点; 点外部不关闭 -->
    <section
      v-if="panelOpen"
      ref="panelRef"
      class="yh-panel"
      :class="{ 'is-dragging': isPanelDragging }"
      :style="panelStyleRef"
      role="dialog"
      aria-label="烟火 · 世界运转"
    >
      <header ref="headerEl" class="yh-header" @pointerdown="onPanelPointerDown">
        <div class="yh-brand">
          <svg class="yh-mark" viewBox="0 0 24 24" aria-hidden="true">
            <rect class="yh-seal-base" x="2.6" y="2.6" width="18.8" height="18.8" rx="5.4" />
            <path class="yh-seal-cut" d="M13.6 4.8 17.9 15.6 16.4 18.8 8 18.8 6.5 15.4 10.6 8.4 12.4 11.2Z" />
          </svg>
          <div class="yh-brand-text">
            <span class="yh-brand-name">烟火</span>
            <span class="yh-brand-sub">世界运转 · 楼层之外，人间照常</span>
          </div>
        </div>
        <div class="yh-header-side">
          <span class="yh-status" :class="{ 'is-on': settings.启用运转 && settings.运转.自动更新 }">
            <i class="yh-status-dot" aria-hidden="true"></i>
            {{ !settings.启用运转 ? '已停转' : settings.运转.自动更新 ? '自动运转' : '手动' }}
          </span>
          <button
            v-if="updatingActive"
            class="yh-btn yh-btn-sm yh-interrupt"
            title="中断本次推进, 不会写入任何数据"
            @click="updatingStore.cancel()"
          >
            中断
          </button>
          <button
            class="yh-icon-btn"
            :title="theme === 'dark' ? '切换白天' : '切换夜晚'"
            @click="theme = theme === 'dark' ? 'light' : 'dark'"
          >
            <PhSun v-if="theme === 'dark'" :size="16" weight="regular" />
            <PhMoonStars v-else :size="16" weight="regular" />
          </button>
          <button class="yh-icon-btn" title="收起" @click="closePanel"><PhX :size="16" weight="regular" /></button>
        </div>
      </header>

      <div class="yh-frame">
        <nav class="yh-rail">
          <button
            v-for="item in tabs"
            :key="item.key"
            class="yh-rail-item"
            :class="{ 'is-active': tab === item.key }"
            @click="tab = item.key"
          >
            <span class="yh-rail-text">{{ item.label }}</span>
          </button>
        </nav>

        <div class="yh-body">
          <!-- ============ 此刻 ============ -->
          <div v-if="tab === 'now'" class="yh-page">
            <div class="yh-now-head">
              <div class="yh-now-time">
                <span class="yh-time-label">世界时间</span>
                <strong class="yh-time-value">{{ world.世界.时间 || '未知' }}</strong>
              </div>
              <p v-if="world.世界.氛围" class="yh-now-mood">{{ world.世界.氛围 }}</p>
              <p v-if="world.世界.总览" class="yh-now-trend">{{ world.世界.总览 }}</p>
              <p v-if="!hasWorld" class="yh-now-empty">
                世界尚无档案——生成一条 AI 回复后自动建立；或在设置里配好接口后点下方「推进世界」。
              </p>
              <div class="yh-now-actions">
                <button class="yh-btn yh-btn-primary" :disabled="updatingActive" @click="tickNow">
                  <PhLightning :size="13" weight="fill" />
                  推进世界
                </button>
                <button class="yh-btn" @click="settings.运转.自动更新 = !settings.运转.自动更新">
                  <PhPause v-if="settings.运转.自动更新" :size="13" weight="regular" />
                  <PhPlay v-else :size="13" weight="regular" />
                  {{ settings.运转.自动更新 ? '暂停自动' : '恢复自动' }}
                </button>
                <button class="yh-btn" @click="editOpen ? saveEdit() : openEdit()">
                  <PhCheck v-if="editOpen" :size="13" weight="regular" />
                  {{ editOpen ? '保存概述' : '修笔' }}
                </button>
                <button class="yh-btn yh-btn-danger" :class="{ 'is-confirm': confirmClear }" @click="clearWorld">
                  <PhTrash :size="13" weight="regular" />
                  {{ confirmClear ? '再点一次确认' : '清空' }}
                </button>
              </div>
            </div>

            <div v-if="editOpen" class="yh-edit-grid">
              <label class="yh-field">
                <span class="yh-field-label">世界时间</span>
                <input v-model="editDraft.时间" type="text" class="yh-input" placeholder="如 0137-06-12 07:45" />
              </label>
              <label class="yh-field">
                <span class="yh-field-label">氛围</span>
                <input
                  v-model="editDraft.氛围"
                  type="text"
                  class="yh-input"
                  placeholder="一句当前世界整体氛围，非主角身边的氛围，而是整个世界的主调"
                />
              </label>
              <label class="yh-field yh-field-wide">
                <span class="yh-field-label">总览</span>
                <textarea
                  v-model="editDraft.总览"
                  class="yh-input yh-textarea"
                  rows="2"
                  placeholder="一两句世界总体走向"
                ></textarea>
              </label>
            </div>

            <div class="yh-now-columns">
              <div class="yh-now-col">
                <h3 class="yh-col-title">事态</h3>
                <ul v-if="activeEvents.length > 0" class="yh-mini-list">
                  <li v-for="event in activeEvents" :key="event.标题">
                    <span class="yh-mini-title" @click="tab = 'chronicle'">{{ event.标题 }}</span>
                    <span class="yh-mini-desc">{{ event.描述 }}</span>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无进行中的事</p>
              </div>
              <div class="yh-now-col">
                <h3 class="yh-col-title">势力</h3>
                <ul v-if="factionEntries.length > 0" class="yh-mini-list">
                  <li v-for="[name, faction] in factionEntries.slice(0, 4)" :key="name">
                    <span class="yh-mini-title" @click="selectFaction(name)">{{ name }}</span>
                    <span class="yh-mini-desc">{{ faction.动向 || faction.目标 }}</span>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无追踪的势力</p>
              </div>
            </div>

            <p class="yh-now-meta">
              已推进 {{ world.统计.推进次数 }} 次 · 上次 {{ fmtTimestamp(world.统计.最后推进)
              }}{{ world.小结 ? ` · ${world.小结}` : '' }}
            </p>
          </div>

          <!-- ============ 风闻 ============ -->
          <div v-else-if="tab === 'chronicle'" class="yh-page">
            <div class="yh-filter-row">
              <div class="yh-chip-group">
                <button
                  v-for="option in ['全部', '进行中', '已结束'] as const"
                  :key="option"
                  class="yh-chip"
                  :class="{ 'is-active': stageFilter === option }"
                  @click="stageFilter = option"
                >
                  {{ option }}
                </button>
              </div>
              <div class="yh-chip-group">
                <button
                  v-for="option in ['全部', '要事', '大事'] as const"
                  :key="option"
                  class="yh-chip"
                  :class="{ 'is-active': scaleFilter === option }"
                  @click="scaleFilter = option"
                >
                  {{ option }}
                </button>
              </div>
            </div>
            <ol v-if="chronicleEvents.length > 0" class="yh-feed">
              <li
                v-for="(event, index) in chronicleEvents"
                :key="event.id || `${event.标题}-${index}`"
                class="yh-feed-item"
                :class="[`is-${event.阶段}`, `scale-${event.规模}`]"
              >
                <div class="yh-feed-when">
                  <span class="yh-feed-time">{{ event.时间 || '时间未知' }}</span>
                  <span v-if="event.地点" class="yh-feed-place">{{ event.地点 }}</span>
                </div>
                <div class="yh-feed-main">
                  <template v-if="editingEvent === event">
                    <div class="yh-inline-edit">
                      <div class="yh-edit-row">
                        <input v-model="eventDraft.标题" class="yh-input" placeholder="标题" />
                        <input v-model="eventDraft.时间" class="yh-input" placeholder="时间" />
                        <input v-model="eventDraft.地点" class="yh-input" placeholder="地点" />
                      </div>
                      <textarea
                        v-model="eventDraft.描述"
                        class="yh-input yh-textarea"
                        rows="2"
                        placeholder="描述"
                      ></textarea>
                      <input v-model="eventDraft.前情" class="yh-input" placeholder="前情（来龙去脉总结）" />
                      <div class="yh-edit-row">
                        <select v-model="eventDraft.规模" class="yh-input yh-select">
                          <option v-for="s in ['要事', '大事']" :key="s" :value="s">{{ s }}</option>
                        </select>
                        <select v-model="eventDraft.传播" class="yh-input yh-select">
                          <option v-for="s in ['本埠', '区域', '天下']" :key="s" :value="s">{{ s }}</option>
                        </select>
                        <select v-model="eventDraft.阶段" class="yh-input yh-select">
                          <option v-for="s in ['酝酿', '进行', '尾声', '已结束']" :key="s" :value="s">{{ s }}</option>
                        </select>
                      </div>
                      <div class="yh-edit-row">
                        <input v-model="eventDraft.渠道" class="yh-input" placeholder="渠道" />
                        <input v-model="eventDraft.势力" class="yh-input" placeholder="关联势力" />
                      </div>
                      <div class="yh-edit-row">
                        <input
                          v-model="eventDraft.代表人物"
                          class="yh-input"
                          placeholder="代表人物（头衔+名字，如 首席信息官·林素问）"
                        />
                      </div>
                      <div class="yh-edit-row">
                        <select v-model="eventDraft.隐秘" class="yh-input yh-select">
                          <option v-for="s in ['公开', '隐秘']" :key="s" :value="s">{{ s }}</option>
                        </select>
                      </div>
                      <div class="yh-edit-actions">
                        <button class="yh-btn yh-btn-primary yh-btn-sm" @click="saveEventEdit">
                          <PhCheck :size="12" weight="bold" />保存
                        </button>
                        <button class="yh-btn yh-btn-sm" @click="editingEvent = null">取消</button>
                      </div>
                    </div>
                  </template>
                  <template v-else>
                    <div class="yh-feed-head">
                      <strong class="yh-feed-title">{{ event.标题 }}</strong>
                      <span class="yh-badge" :class="`yh-badge-${event.规模}`">{{
                        scaleLabel[event.规模] ?? event.规模
                      }}</span>
                      <span v-if="event.阶段 === '已结束'" class="yh-badge yh-badge-done">已了结</span>
                      <span v-if="event.隐秘 === '隐秘'" class="yh-badge yh-badge-secret">隐秘</span>
                      <button class="yh-icon-btn yh-feed-edit" title="编辑此事件" @click="startEditEvent(event)">
                        <PhPencilSimple :size="11" weight="regular" />
                      </button>
                      <button class="yh-icon-btn yh-feed-remove" title="移除此事件" @click="removeEvent(event)">
                        <PhX :size="11" weight="bold" />
                      </button>
                    </div>
                    <p class="yh-feed-desc">{{ event.描述 }}</p>
                    <p v-if="event.前情" class="yh-feed-cause">前情 · {{ event.前情 }}</p>
                    <button
                      v-if="event.演变.length > 0"
                      class="yh-collapse yh-trail-toggle"
                      @click="toggleTrail(event.id || event.标题)"
                    >
                      <PhCaretDown :size="11" :class="{ 'is-flipped': !trailOpen[event.id || event.标题] }" />
                      演变 · {{ event.演变.length }}
                    </button>
                    <ul v-if="event.演变.length > 0 && trailOpen[event.id || event.标题]" class="yh-feed-trail">
                      <li v-for="(step, stepIndex) in event.演变" :key="stepIndex">
                        <span class="yh-trail-time">{{ step.时间 || '时间未知' }}</span>
                        <span class="yh-trail-text">{{ step.变化 }}</span>
                      </li>
                    </ul>
                    <div class="yh-feed-meta">
                      <span v-if="event.传播">传播:{{ event.传播 }}</span>
                      <span v-if="event.渠道">渠道:{{ event.渠道 }}</span>
                      <span v-if="event.势力">关联:{{ event.势力 }}</span>
                      <span v-if="event.代表人物">人物:{{ event.代表人物 }}</span>
                      <span>阶段:{{ event.阶段 }}</span>
                    </div>
                  </template>
                </div>
              </li>
            </ol>
            <div v-else class="yh-empty">
              <PhWind :size="26" weight="light" />
              <p>{{ stageFilter === '已结束' ? '还没有了结的事' : '无事发生——世界很安静' }}</p>
            </div>
          </div>

          <!-- ============ 势力 ============ -->
          <div v-else-if="tab === 'factions'" class="yh-page yh-page-master">
            <aside class="yh-master">
              <div v-if="factionEntries.length > 0" class="yh-master-list">
                <button
                  v-for="[name, faction] in factionEntries"
                  :key="name"
                  class="yh-master-item"
                  :class="{ 'is-active': selectedFaction === name }"
                  @click="selectedFaction = name"
                >
                  <strong>{{ name }}</strong>
                  <span>{{ faction.动向 || faction.目标 || '（无动向）' }}</span>
                </button>
              </div>
              <div v-else class="yh-empty yh-empty-slim">
                <PhGraph :size="22" weight="light" />
                <p>尚无势力档案<br />世界推进后自动识别</p>
              </div>
            </aside>
            <div class="yh-detail">
              <template v-if="selectedFactionData">
                <div class="yh-detail-head">
                  <h3>{{ selectedFaction }}</h3>
                  <div class="yh-detail-actions">
                    <button v-if="!factionEditing" class="yh-icon-btn" title="编辑此势力" @click="startEditFaction()">
                      <PhPencilSimple :size="13" weight="regular" />
                    </button>
                    <button class="yh-icon-btn" title="移除此势力" @click="removeFaction(selectedFaction)">
                      <PhTrash :size="13" weight="regular" />
                    </button>
                  </div>
                </div>
                <dl v-if="!factionEditing" class="yh-detail-rows">
                  <div class="yh-detail-row">
                    <dt>目标</dt>
                    <dd>{{ selectedFactionData.目标 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>头面人物</dt>
                    <dd>{{ selectedFactionData.头面人物 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>动向</dt>
                    <dd>{{ selectedFactionData.动向 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>势力范围</dt>
                    <dd>{{ selectedFactionData.势力范围 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>对外关系</dt>
                    <dd>{{ selectedFactionData.对外关系 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>关联事件</dt>
                    <dd>
                      <template v-if="factionRelatedEvents.length > 0">
                        <span
                          v-for="event in factionRelatedEvents"
                          :key="event.id || event.标题"
                          class="yh-mini-title"
                          style="display: inline-block; margin-right: 10px"
                          @click="tab = 'chronicle'"
                          >{{ event.标题 }}（{{ event.阶段 }}）</span
                        >
                      </template>
                      <template v-else>—</template>
                    </dd>
                  </div>
                </dl>
                <div v-else class="yh-inline-edit">
                  <label class="yh-field">
                    <span class="yh-field-label">目标</span>
                    <textarea v-model="factionDraft.目标" class="yh-input yh-textarea" rows="2"></textarea>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">动向</span>
                    <textarea v-model="factionDraft.动向" class="yh-input yh-textarea" rows="2"></textarea>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">前情（来龙去脉滚动总结）</span>
                    <textarea v-model="factionDraft.前情" class="yh-input yh-textarea" rows="3"></textarea>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">势力范围（地盘与影响：地区/行业/阶层/渠道）</span>
                    <input
                      v-model="factionDraft.势力范围"
                      type="text"
                      class="yh-input"
                      placeholder="如 北境三城；垄断盐铁 / 好莱坞六大制片厂主导；无明确地盘"
                    />
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">对外关系（与其他势力的关系，每方一条）</span>
                    <textarea
                      v-model="factionDraft.对外关系"
                      class="yh-input yh-textarea"
                      rows="2"
                      placeholder="如 与X商团盟约渐固；与Y帮派摩擦升级"
                    ></textarea>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">头面人物（首领/掌门/对外代言人，头衔+名字）</span>
                    <input v-model="factionDraft.头面人物" type="text" class="yh-input" placeholder="如 家主·林远山" />
                  </label>
                  <div class="yh-edit-actions">
                    <button class="yh-btn yh-btn-primary yh-btn-sm" @click="saveFactionEdit">
                      <PhCheck :size="12" weight="bold" />保存
                    </button>
                    <button class="yh-btn yh-btn-sm" @click="factionEditing = false">取消</button>
                  </div>
                </div>
                <p class="yh-detail-hint">势力动向由世界推进自动维护, 也可在此手动修改(保存后同步注入)。</p>
              </template>
              <div v-else class="yh-empty">
                <PhGraph :size="26" weight="light" />
                <p>选择一个势力查看详情</p>
              </div>
            </div>
          </div>

          <!-- ============ 世界 ============ -->
          <div v-else-if="tab === 'world'" class="yh-page">
            <p v-if="!hasWorld" class="yh-world-hint">世界尚无档案——推进世界后自动建立, 也可用各区块的「添一笔」手动建档</p>
            <div class="yh-world-body">
              <details class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>大势</span>
                  <em>{{ trendEntries.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('大势')">
                    <PhPlus :size="11" weight="bold" />添一笔
                  </button>
                </summary>
                <world-edit-form
                  v-if="worldEditing && worldDraft.layer === '大势'"
                  :draft="worldDraft"
                  :defs="layerFields['大势']"
                  @save="saveWorldEdit"
                  @cancel="worldEditing = false"
                />
                <ul v-if="trendEntries.length > 0" class="yh-world-list">
                  <li v-for="[name, t] in trendEntries" :key="name" class="yh-world-card">
                    <div class="yh-world-card-head">
                      <strong>{{ name }}</strong>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('大势', name, t)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('大势', name)">
                          <PhTrash :size="12" weight="regular" />
                        </button>
                      </div>
                    </div>
                    <p v-if="t.进展" class="yh-world-main">{{ t.进展 }}</p>
                    <dl class="yh-world-fields">
                      <div v-if="t.概况">
                        <dt>概况</dt>
                        <dd>{{ t.概况 }}</dd>
                      </div>
                      <div v-if="t.走向">
                        <dt>走向</dt>
                        <dd>{{ t.走向 }}</dd>
                      </div>
                      <div v-if="t.前情">
                        <dt>前情</dt>
                        <dd>{{ t.前情 }}</dd>
                      </div>
                    </dl>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无大势</p>
              </details>

              <details class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>地域</span>
                  <em>{{ regionEntries.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('地域')">
                    <PhPlus :size="11" weight="bold" />添一笔
                  </button>
                </summary>
                <world-edit-form
                  v-if="worldEditing && worldDraft.layer === '地域'"
                  :draft="worldDraft"
                  :defs="layerFields['地域']"
                  @save="saveWorldEdit"
                  @cancel="worldEditing = false"
                />
                <ul v-if="regionEntries.length > 0" class="yh-world-list">
                  <li v-for="[name, r] in regionEntries" :key="name" class="yh-world-card">
                    <div class="yh-world-card-head">
                      <strong>{{ name }}</strong>
                      <span v-if="r.当权者" class="yh-world-delta">{{ r.当权者 }}</span>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('地域', name, r)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('地域', name)">
                          <PhTrash :size="12" weight="regular" />
                        </button>
                      </div>
                    </div>
                    <p v-if="r.局势" class="yh-world-main">{{ r.局势 }}</p>
                    <dl class="yh-world-fields">
                      <div v-if="r.概况">
                        <dt>概况</dt>
                        <dd>{{ r.概况 }}</dd>
                      </div>
                      <div v-if="r.对外关系">
                        <dt>对外关系</dt>
                        <dd>{{ r.对外关系 }}</dd>
                      </div>
                      <div v-if="r.前情">
                        <dt>前情</dt>
                        <dd>{{ r.前情 }}</dd>
                      </div>
                    </dl>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无地域</p>
              </details>

              <details class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>伏笔</span>
                  <em>{{ seedList.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('伏笔')">
                    <PhPlus :size="11" weight="bold" />添一笔
                  </button>
                </summary>
                <world-edit-form
                  v-if="worldEditing && worldDraft.layer === '伏笔'"
                  :draft="worldDraft"
                  :defs="layerFields['伏笔']"
                  @save="saveWorldEdit"
                  @cancel="worldEditing = false"
                />
                <ul v-if="seedList.length > 0" class="yh-world-list">
                  <li v-for="seed in seedList" :key="seed.标题" class="yh-world-card">
                    <div class="yh-world-card-head">
                      <strong>{{ seed.标题 }}</strong>
                      <span class="yh-badge" :class="'yh-maturity-' + seed.成熟度">{{ seed.成熟度 }}</span>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('伏笔', seed.标题, seed)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('伏笔', seed.标题)">
                          <PhTrash :size="12" weight="regular" />
                        </button>
                      </div>
                    </div>
                    <p v-if="seed.指向" class="yh-world-main">指向 · {{ seed.指向 }}</p>
                    <dl class="yh-world-fields">
                      <div v-if="seed.埋设">
                        <dt>埋设</dt>
                        <dd>{{ seed.埋设 }}</dd>
                      </div>
                      <div v-if="seed.前情">
                        <dt>前情</dt>
                        <dd>{{ seed.前情 }}</dd>
                      </div>
                    </dl>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无伏笔</p>
              </details>

              <details v-if="settings.运转.节令历法" class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>节令</span>
                  <em>{{ occasionList.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('节令')">
                    <PhPlus :size="11" weight="bold" />添一笔
                  </button>
                </summary>
                <world-edit-form
                  v-if="worldEditing && worldDraft.layer === '节令'"
                  :draft="worldDraft"
                  :defs="layerFields['节令']"
                  @save="saveWorldEdit"
                  @cancel="worldEditing = false"
                />
                <ul v-if="occasionList.length > 0" class="yh-world-list">
                  <li v-for="o in occasionList" :key="o.名称" class="yh-world-card">
                    <div class="yh-world-card-head">
                      <strong>{{ o.名称 }}</strong>
                      <span v-if="o.时间" class="yh-badge">{{ o.时间 }}</span>
                      <span v-if="o.周期" class="yh-world-delta">{{ o.周期 }}</span>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('节令', o.名称, o)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('节令', o.名称)">
                          <PhTrash :size="12" weight="regular" />
                        </button>
                      </div>
                    </div>
                    <p v-if="o.概况" class="yh-world-main">{{ o.概况 }}</p>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无节令</p>
              </details>

              <details v-if="settings.运转.世界指标" class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>指标</span>
                  <em>{{ metricEntries.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('指标')">
                    <PhPlus :size="11" weight="bold" />添一笔
                  </button>
                </summary>
                <world-edit-form
                  v-if="worldEditing && worldDraft.layer === '指标'"
                  :draft="worldDraft"
                  :defs="layerFields['指标']"
                  @save="saveWorldEdit"
                  @cancel="worldEditing = false"
                />
                <ul v-if="metricEntries.length > 0" class="yh-world-grid">
                  <li v-for="[name, m] in metricEntries" :key="name" class="yh-world-card yh-metric-card">
                    <div class="yh-metric-top">
                      <span class="yh-metric-name">{{ name }}</span>
                      <span class="yh-metric-value">{{ m.值 }}</span>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('指标', name, m)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('指标', name)">
                          <PhTrash :size="12" weight="regular" />
                        </button>
                      </div>
                    </div>
                    <span class="yh-metric-trend">{{ trendArrow(m.趋势) }} {{ m.趋势 }}</span>
                    <p v-if="m.说明" class="yh-metric-note">{{ m.说明 }}</p>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无指标</p>
              </details>
            </div>
          </div>

          <!-- ============ 日志 ============ -->
          <div v-else-if="tab === 'logs'" class="yh-page yh-page-logs">
            <div class="yh-log-left">
              <div v-if="debugLog" class="yh-log-record">
                <p class="yh-log-meta">
                  {{ fmtTimestamp(debugLog.time) }} · {{ debugLog.model || '(未选模型)' }} · 楼层
                  {{ debugLog.replyIds.length > 0 ? debugLog.replyIds.map(id => `#${id}`).join(', ') : '—' }}
                </p>
                <p v-if="debugLog.summary" class="yh-log-summary">{{ debugLog.summary }}</p>
                <div
                  v-if="debugLog.addedEvents.length || debugLog.updatedEvents.length || debugLog.removedEvents.length"
                  class="yh-log-diff"
                >
                  <span v-if="debugLog.addedEvents.length" class="yh-badge yh-badge-add"
                    >新增 {{ debugLog.addedEvents.join('、') }}</span
                  >
                  <span v-if="debugLog.updatedEvents.length" class="yh-badge yh-badge-upd"
                    >推进 {{ debugLog.updatedEvents.join('、') }}</span
                  >
                  <span v-if="debugLog.removedEvents.length" class="yh-badge yh-badge-done"
                    >了结 {{ debugLog.removedEvents.join('、') }}</span
                  >
                </div>
                <div class="yh-log-section">
                  <button class="yh-collapse" @click="toggleCollapse('request')">
                    <PhCaretDown :size="12" :class="{ 'is-flipped': collapsed.request }" />
                    发送给世界引擎的内容
                  </button>
                  <pre v-if="!collapsed.request" class="yh-pre">{{ debugLog.request || '（空）' }}</pre>
                </div>
                <div class="yh-log-section">
                  <button class="yh-collapse" @click="toggleCollapse('response')">
                    <PhCaretDown :size="12" :class="{ 'is-flipped': collapsed.response }" />
                    世界引擎输出
                  </button>
                  <pre v-if="!collapsed.response" class="yh-pre">{{ debugLog.response || '（空）' }}</pre>
                </div>
                <div v-if="debugLog.error" class="yh-log-section">
                  <button class="yh-collapse" @click="toggleCollapse('error')">
                    <PhCaretDown :size="12" :class="{ 'is-flipped': collapsed.error }" />
                    报错
                  </button>
                  <pre v-if="!collapsed.error" class="yh-pre yh-pre-error">{{ debugLog.error }}</pre>
                </div>
                <div class="yh-log-actions">
                  <button class="yh-btn" @click="copyText(joinRecord(), '已复制推进记录')">
                    <PhCopySimple :size="13" weight="regular" />复制推进记录
                  </button>
                  <button class="yh-btn" @click="copyText(buildErrorReport(), '已复制报错报告，可直接发给助手排查')">
                    <PhCopySimple :size="13" weight="regular" />复制报错发给助手
                  </button>
                </div>
              </div>
              <div v-else class="yh-empty">
                <PhScroll :size="26" weight="light" />
                <p>还没有推进记录</p>
              </div>
            </div>
            <div class="yh-log-right">
              <div class="yh-log-right-head">
                <h3 class="yh-col-title">注入给主AI的内容</h3>
                <div class="yh-log-right-actions">
                  <button class="yh-btn yh-btn-sm" @click="showInjection">生成预览</button>
                  <button v-if="injectionPreview" class="yh-btn yh-btn-sm" @click="copyText(injectionPreview)">
                    <PhCopySimple :size="11" weight="regular" />
                  </button>
                </div>
              </div>
              <pre v-if="injectionPreview" class="yh-pre yh-pre-short">{{ injectionPreview }}</pre>
              <p v-else class="yh-mini-empty">点「生成预览」查看当前世界动向会注入给主AI的文本</p>
              <h3 class="yh-col-title">控制台输出</h3>
              <div class="yh-console">
                <p
                  v-for="(line, index) in consoleLinesReversed"
                  :key="`${line.time}-${index}`"
                  class="yh-console-line"
                  :class="`is-${line.type}`"
                >
                  <span class="yh-console-time">{{
                    new Date(line.time).toLocaleTimeString('zh-CN', { hour12: false })
                  }}</span>
                  {{ line.text }}
                </p>
                <p v-if="consoleLines.length === 0" class="yh-mini-empty">（无输出）</p>
              </div>
              <button class="yh-btn yh-btn-sm" @click="consoleStore.clear()">清空控制台</button>
            </div>
          </div>

          <!-- ============ 设置 ============ -->
          <div v-else class="yh-page yh-page-settings">
            <div class="yh-set-stack">
              <div class="yh-set-col">
                <h3 class="yh-col-title">接口配置</h3>
                <div class="yh-preset-row">
                  <select v-model="selectedPreset" class="yh-input yh-select">
                    <option value="">选择预设…</option>
                    <option v-for="name in presetNames" :key="name" :value="name">{{ name }}</option>
                  </select>
                  <button class="yh-btn yh-btn-sm" :disabled="!selectedPreset" @click="loadApiPreset">加载</button>
                  <button class="yh-btn yh-btn-sm yh-btn-danger" :disabled="!selectedPreset" @click="deleteApiPreset">
                    删除
                  </button>
                </div>
                <div class="yh-preset-row">
                  <input
                    v-model="presetName"
                    class="yh-input"
                    placeholder="预设名，如 DeepSeek"
                    @keyup.enter="saveApiPreset"
                  />
                  <button class="yh-btn yh-btn-sm" @click="saveApiPreset">
                    <PhPlus :size="11" weight="bold" />存为预设
                  </button>
                </div>
                <label class="yh-field">
                  <span class="yh-field-label">接口地址（OpenAI 兼容，末尾自动补 /v1）</span>
                  <input
                    v-model="settings.接口.地址"
                    type="text"
                    class="yh-input"
                    placeholder="https://api.example.com"
                  />
                </label>
                <label class="yh-field">
                  <span class="yh-field-label">API 密钥</span>
                  <div class="yh-key-row">
                    <input
                      v-model="settings.接口.密钥"
                      :type="showKey ? 'text' : 'password'"
                      class="yh-input"
                      placeholder="sk-…"
                    />
                    <button class="yh-icon-btn" @click="showKey = !showKey">
                      <PhEye v-if="!showKey" :size="14" weight="regular" />
                      <PhEyeSlash v-else :size="14" weight="regular" />
                    </button>
                  </div>
                </label>
                <div class="yh-field">
                  <span class="yh-field-label">模型</span>
                  <div class="yh-key-row">
                    <select v-model="settings.接口.模型" class="yh-input yh-select">
                      <option value="">未选择</option>
                      <option v-for="model in settings.接口.模型列表" :key="model" :value="model">{{ model }}</option>
                      <option
                        v-if="settings.接口.模型 && !settings.接口.模型列表.includes(settings.接口.模型)"
                        :value="settings.接口.模型"
                      >
                        {{ settings.接口.模型 }}
                      </option>
                    </select>
                    <button class="yh-btn yh-btn-sm" :disabled="fetchingModels" @click="onFetchModels">
                      {{ fetchingModels ? '获取中…' : '获取模型列表' }}
                    </button>
                  </div>
                </div>
                <div class="yh-field-pair">
                  <label class="yh-field">
                    <span class="yh-field-label">温度（越低越稳定）</span>
                    <input
                      v-model.number="settings.接口.温度"
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      class="yh-input"
                    />
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">最大输出Token</span>
                    <input
                      v-model.number="settings.接口.最大token"
                      type="number"
                      min="1"
                      max="131072"
                      step="128"
                      class="yh-input"
                    />
                  </label>
                </div>
                <div class="yh-toggles">
                  <label class="yh-toggle">
                    <input v-model="settings.接口.服务端转发" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">走酒馆服务器转发请求<em>接口不支持浏览器跨域(CORS)时开启</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.接口.关闭思维链" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">关闭模型思维链<em>原生支持 Responses API 的模型可用</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.接口.流式" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">流式输出<em>长输出更不易被网关掐断</em></span>
                  </label>
                </div>
                <button class="yh-btn" :disabled="testing" @click="onTestConnection">
                  <PhLightning :size="13" weight="fill" />
                  {{ testing ? '测试中…' : '测试连接' }}
                </button>
              </div>
              <div class="yh-set-col">
                <h3 class="yh-col-title">请求技巧</h3>
                <div class="yh-toggles">
                  <label class="yh-toggle">
                    <input v-model="settings.运转.预填充" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">预填充<em>引导模型直接输出 JSON，减少格式失败</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.破限" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">破限<em>接口有内容政策拦截时使用</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.头部填充" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >头部填充<em>填充文本作为第一条消息单独发送，留空用内置小说原文</em></span
                    >
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.防截断" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">防截断<em>缝在 system 末尾</em></span>
                  </label>
                </div>
                <label class="yh-field" style="margin-top: 2px">
                  <span class="yh-field-label">头部填充文本（留空使用内置小说原文，建议1W字左右）</span>
                  <textarea
                    v-model="settings.运转.头部填充文本"
                    class="yh-input yh-textarea"
                    rows="6"
                    placeholder="开启「头部填充」后，这段文本会作为第一条消息原样发送；留空则使用内置的小说原文"
                  ></textarea>
                </label>
              </div>
            </div>
            <div class="yh-set-stack">
              <div class="yh-set-col">
                <h3 class="yh-col-title">运转</h3>
                <div class="yh-toggles">
                  <label class="yh-toggle">
                    <input v-model="settings.启用运转" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">启用世界运转<em>关闭后不再调用接口、不再自动推进</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.自动更新" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">自动推进<em>每次（或每 N 次）AI 回复后推进一次世界</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.节令历法" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">节令历法<em>按世界观生成节庆/汛期/开市/检阅等周期节点</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.世界指标" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >世界指标<em>少量慢变数值（丰歉/物价/能源/民心等，按世界观取名）</em></span
                    >
                  </label>
                </div>
                <div class="yh-field-pair">
                  <label class="yh-field">
                    <span class="yh-field-label">更新频率</span>
                    <input v-model.number="settings.运转.更新频率" type="number" min="1" max="50" class="yh-input" />
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">读取最近回复数</span>
                    <input
                      v-model.number="settings.运转.读取最近回复数"
                      type="number"
                      min="1"
                      max="20"
                      class="yh-input"
                    />
                  </label>
                </div>
                <div class="yh-field-pair">
                  <label class="yh-field">
                    <span class="yh-field-label">快照保留份数</span>
                    <input
                      v-model.number="settings.运转.快照保留份数"
                      type="number"
                      min="1"
                      max="100"
                      class="yh-input"
                    />
                    <span class="yh-field-label" style="font-weight: 400; color: var(--yh-ink-faint)"
                      >删楼回退的保险窗口：保留最近 N
                      份楼层快照（1~100）。每份几KB~30KB，保留过多时聊天文件随之变大</span
                    >
                  </label>
                </div>
              </div>
              <div class="yh-set-col">
                <h3 class="yh-col-title">注入主AI</h3>
                <div class="yh-toggles">
                  <label class="yh-toggle">
                    <input v-model="settings.运转.注入世界书条目" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >注入世界动向到主AI<em>写入角色卡主世界书常驻条目「【烟火】世界动向」，切聊天自动重写</em></span
                    >
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.注入隐秘事件" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >注入隐秘事件到主AI<em
                        >默认关闭——隐秘事件只进面板，供烟火推演；开启后标注"主角绝不可能知道"注入</em
                      ></span
                    >
                  </label>
                </div>
              </div>
              <div class="yh-set-col">
                <h3 class="yh-col-title">世界书与标签</h3>
                <div class="yh-toggles">
                  <label class="yh-toggle">
                    <input v-model="settings.运转.读取世界书" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >给世界引擎注入世界书<em>与主AI相同的激活方式，主AI读到什么它读到什么</em></span
                    >
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.读取全局世界书" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">包含全局世界书<em>默认只读角色卡与聊天绑定的世界书</em></span>
                  </label>
                </div>
                <label class="yh-field">
                  <span class="yh-field-label">世界书排除条目（顿号分隔）</span>
                  <input
                    v-model="worldbookExcludeText"
                    type="text"
                    class="yh-input"
                    placeholder="如 某条目名、某关键词"
                  />
                </label>
                <div class="yh-field-pair">
                  <label class="yh-field">
                    <span class="yh-field-label">楼层标签过滤·模式</span>
                    <select v-model="settings.标签.模式" class="yh-input yh-select">
                      <option value="排除">排除——删掉这些标签里的内容</option>
                      <option value="只读">只读——只读这些标签里的内容</option>
                    </select>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">标签列表（顿号分隔）</span>
                    <input v-model="tagListText" type="text" class="yh-input" placeholder="如 thinking、aftertalk" />
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <footer class="yh-footer">
        <span>{{ settings.接口.模型 || '未配置接口' }}</span>
        <span>{{ world.世界.时间 || '世界时间未知' }}</span>
        <span>快照 {{ world.锚点楼层 >= 0 ? `#${world.锚点楼层}` : '无' }}</span>
      </footer>
    </section>
  </div>
</template>

<style lang="scss">
// ---------------------------------------------------------------------------
// 「石墨 × 象牙 × 朱砂印」— 按 color-expert 方法构建: OKLCH 极中性石墨面层(无色相倾向),
// 象牙白文字, 交互主色=反相(暗色下象牙按钮/亮色下墨按钮), 朱砂只占 10%(印章/焦点/山雨欲来)
// ---------------------------------------------------------------------------

.yh-root {
  --yh-accent: oklch(0.92 0.004 95);
  --yh-accent-strong: oklch(0.84 0.005 95);
  --yh-accent-deep: oklch(0.78 0.006 95);
  --yh-on-accent: oklch(0.2 0.005 270);
  --yh-seal: oklch(0.66 0.17 30);
  --yh-ink: oklch(0.92 0.004 95);
  --yh-ink-dim: oklch(0.72 0.006 95);
  --yh-ink-faint: oklch(0.55 0.007 95);
  --yh-bg: oklch(0.19 0.005 270);
  --yh-panel: oklch(0.23 0.005 270);
  --yh-raise: oklch(0.27 0.005 270);
  --yh-hover: oklch(0.32 0.006 270);
  --yh-line: oklch(0.3 0.005 270);
  --yh-line-strong: oklch(0.4 0.006 270);
  --yh-gold: oklch(0.76 0.1 85);
  --yh-good: oklch(0.72 0.09 148);
  --yh-shadow: 0 18px 48px rgba(0, 0, 0, 0.5), 0 3px 12px rgba(0, 0, 0, 0.4);
  --yh-serif: 'Source Han Serif SC', 'Noto Serif SC', 'SimSun', serif;

  position: fixed;
  inset: 0;
  font-family: 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;
  font-size: 13px;
  line-height: 1.6;
  color: var(--yh-ink);
  pointer-events: none;
  z-index: 2147483000;

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  button,
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
  }

  // ---- 印章 logo(朱文方印: 实心朱砂 + 镂空火纹) ----
  .yh-seal-base {
    fill: var(--yh-seal);
  }
  .yh-seal-cut {
    fill: var(--yh-panel);
  }
  .yh-flame {
    fill: var(--yh-seal);
  }

  // ---- 悬浮球: 扁平墨印, 一点朱砂 ----
  .yh-orb {
    pointer-events: auto;
    position: absolute;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    background: var(--yh-panel);
    border: 1px solid var(--yh-line-strong);
    border-radius: 50%;
    cursor: grab;
    padding: 0;
    appearance: none;
    outline: none;
    -webkit-tap-highlight-color: transparent;
    // 触屏拖动: 禁止浏览器把 pointermove 当滚动/长按手势吞掉, 拖球才跟手
    touch-action: none;
    z-index: 4;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
    transition:
      border-color 0.2s,
      box-shadow 0.2s;

    .yh-orb-mark {
      width: 22px;
      height: 22px;
      transform-origin: 50% 78%;
    }
    &:hover {
      border-color: var(--yh-accent);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    }
    &.is-dragging {
      cursor: grabbing;
    }
    &.is-open {
      border-color: var(--yh-seal);
    }
    // 推进中: 火苗摇曳(缩放+透明度微抖), 替代原来的状态小圆点
    &.is-updating {
      .yh-orb-mark {
        animation: yh-flicker 1.1s ease-in-out infinite;
      }
    }
  }
  @keyframes yh-flicker {
    0%,
    100% {
      transform: scale(1, 1);
      opacity: 1;
    }
    25% {
      transform: scale(1.06, 0.94);
      opacity: 0.82;
    }
    50% {
      transform: scale(0.95, 1.06);
      opacity: 1;
    }
    75% {
      transform: scale(1.03, 0.97);
      opacity: 0.88;
    }
  }
  @keyframes yh-breath {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }

  // ---- 面板: 小窗 ----
  .yh-panel {
    z-index: 3;
    pointer-events: auto;
    position: absolute;
    display: flex;
    flex-direction: column;
    background: var(--yh-panel);
    border: 1px solid var(--yh-line-strong);
    border-radius: 12px;
    // 阴影由酒馆页面上的阴影层绘制(iframe 内绘制会被 clip-path 裁出硬边), 见 syncPanelShadow
    box-shadow: none;
    overflow: hidden;
    animation: yh-panel-in 0.22s cubic-bezier(0.2, 0.9, 0.25, 1);
    &.is-dragging {
      user-select: none;
    }
  }
  @keyframes yh-panel-in {
    from {
      opacity: 0;
      scale: 0.97;
    }
    to {
      opacity: 1;
      scale: 1;
    }
  }

  .yh-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px 10px 16px;
    border-bottom: 1px solid var(--yh-line);
    cursor: grab;
    user-select: none;
    // 触屏拖动面板: 禁止浏览器手势接管 pointermove(同悬浮球)
    touch-action: none;
    &:active {
      cursor: grabbing;
    }
  }
  .yh-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    pointer-events: none;
  }
  .yh-mark {
    width: 26px;
    height: 26px;
  }
  .yh-brand-name {
    font-family: var(--yh-serif);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 0.3em;
    margin-right: -0.3em;
  }
  .yh-brand-sub {
    display: block;
    font-size: 10.5px;
    color: var(--yh-ink-faint);
    letter-spacing: 0.05em;
  }
  .yh-header-side {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .yh-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--yh-ink-dim);
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid var(--yh-line);
    .yh-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--yh-ink-faint);
    }
    &.is-on .yh-status-dot {
      background: var(--yh-seal);
    }
  }
  .yh-icon-btn {
    pointer-events: auto;
    display: inline-grid;
    place-items: center;
    padding: 0;
    line-height: 0;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--yh-ink-dim);
    cursor: pointer;
    transition: all 0.15s;
    svg {
      display: block;
    }
    &:hover {
      background: var(--yh-bg-hover);
      color: var(--yh-ink);
      border-color: var(--yh-line);
    }
  }

  // ---- 左侧竖排文字栏 ----
  .yh-frame {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .yh-rail {
    flex: none;
    width: 56px;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    padding: 14px 0;
    border-right: 1px solid var(--yh-line);
    background: var(--yh-bg);
  }
  .yh-rail-item {
    position: relative;
    display: grid;
    place-items: center;
    padding: 12px 0;
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background 0.15s;
    .yh-rail-text {
      writing-mode: vertical-rl;
      letter-spacing: 0.34em;
      font-size: 12.5px;
      color: var(--yh-ink-faint);
      transition: color 0.15s;
    }
    &::before {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%) scaleY(0);
      width: 2px;
      height: 18px;
      background: var(--yh-seal);
      transition: transform 0.18s ease-out;
    }
    &:hover {
      background: var(--yh-hover);
      .yh-rail-text {
        color: var(--yh-ink-dim);
      }
    }
    &.is-active {
      .yh-rail-text {
        color: var(--yh-accent-strong);
      }
      &::before {
        transform: translateY(-50%) scaleY(1);
      }
    }
  }

  .yh-body {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .yh-page {
    height: 100%;
    overflow-y: auto;
    padding: 16px 18px 18px;
    &.yh-page-master,
    &.yh-page-logs,
    &.yh-page-settings {
      display: grid;
      gap: 16px;
    }
    &.yh-page-master {
      grid-template-columns: 220px 1fr;
      padding: 0;
      overflow: hidden;
    }
    &.yh-page-logs {
      grid-template-columns: 1.15fr 1fr;
    }
    &.yh-page-settings {
      grid-template-columns: 1fr 1fr;
      align-items: start;
    }
  }

  // ---- 此刻 ----
  .yh-now-head {
    padding: 2px 0 14px;
    border-bottom: 1px solid var(--yh-line);
    margin-bottom: 14px;
  }
  .yh-now-time {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  .yh-time-label {
    font-size: 11px;
    color: var(--yh-ink-faint);
    letter-spacing: 0.3em;
  }
  .yh-time-value {
    font-family: var(--yh-serif);
    font-size: 26px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--yh-ink);
    font-variant-numeric: tabular-nums;
  }
  .yh-now-mood {
    margin: 5px 0 0;
    color: var(--yh-accent-strong);
    font-size: 13.5px;
  }
  .yh-now-trend {
    margin: 5px 0 0;
    color: var(--yh-ink-dim);
    max-width: 68ch;
  }
  .yh-now-empty {
    margin: 8px 0 0;
    color: var(--yh-ink-faint);
  }
  .yh-now-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-top: 12px;
  }
  .yh-btn {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid var(--yh-line-strong);
    background: var(--yh-raise);
    color: var(--yh-ink);
    cursor: pointer;
    font-size: 12px;
    transition: all 0.15s;
    &:hover:not(:disabled) {
      border-color: var(--yh-accent-deep);
      background: var(--yh-hover);
    }
    &:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    &.yh-btn-primary {
      background: var(--yh-accent);
      border-color: var(--yh-accent);
      color: var(--yh-on-accent);
      &:hover:not(:disabled) {
        background: color-mix(in oklab, var(--yh-accent) 86%, var(--yh-panel));
        border-color: color-mix(in oklab, var(--yh-accent) 86%, var(--yh-panel));
      }
    }
    &.yh-btn-danger {
      color: var(--yh-seal);
      &.is-confirm {
        background: var(--yh-seal);
        border-color: var(--yh-seal);
        color: #fff5f0;
      }
    }
    &.yh-btn-sm {
      padding: 3px 9px;
      font-size: 11.5px;
      border-radius: 6px;
    }
    &.yh-interrupt {
      color: var(--yh-seal);
      border-color: color-mix(in srgb, var(--yh-seal) 60%, transparent);
      &:hover:not(:disabled) {
        background: color-mix(in srgb, var(--yh-seal) 12%, transparent);
        border-color: var(--yh-seal);
      }
    }
  }

  .yh-edit-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 9px 12px;
    padding: 11px 13px;
    margin-bottom: 14px;
    background: var(--yh-raise);
    border: 1px solid var(--yh-line);
    border-radius: 10px;
    .yh-field-wide {
      grid-column: 1 / -1;
    }
  }

  .yh-urgent {
    display: flex;
    gap: 11px;
    align-items: flex-start;
    padding: 11px 14px;
    margin-bottom: 14px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--yh-seal) 45%, transparent);
    background: color-mix(in srgb, var(--yh-seal) 8%, transparent);
    color: var(--yh-seal);
    strong {
      font-size: 12.5px;
      letter-spacing: 0.2em;
    }
    p {
      margin: 2px 0 0;
      color: var(--yh-ink-dim);
    }
  }

  .yh-now-columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }
  .yh-col-title {
    margin: 0 0 9px;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.22em;
    color: var(--yh-ink-dim);
  }
  .yh-mini-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
    li {
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: 7px 11px;
      border-radius: 8px;
      background: var(--yh-raise);
      border: 1px solid var(--yh-line);
    }
  }
  .yh-mini-title {
    font-weight: 600;
    font-size: 12.5px;
    cursor: pointer;
    &:hover {
      color: var(--yh-accent-strong);
    }
  }
  .yh-mini-desc {
    font-size: 11.5px;
    color: var(--yh-ink-dim);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .yh-mini-empty {
    color: var(--yh-ink-faint);
    font-size: 12px;
    margin: 0;
  }
  .yh-now-meta {
    margin: 14px 0 0;
    font-size: 11.5px;
    color: var(--yh-ink-faint);
  }

  // ---- 风闻 ----
  .yh-filter-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    margin-bottom: 13px;
  }
  .yh-chip-group {
    display: flex;
    gap: 5px;
  }
  .yh-chip {
    padding: 3px 11px;
    border-radius: 999px;
    border: 1px solid var(--yh-line);
    background: transparent;
    color: var(--yh-ink-dim);
    cursor: pointer;
    font-size: 11.5px;
    transition: all 0.15s;
    &:hover {
      color: var(--yh-ink);
      border-color: var(--yh-line-strong);
    }
    &.is-active {
      background: var(--yh-accent);
      border-color: var(--yh-accent);
      color: var(--yh-on-accent);
    }
  }
  .yh-feed {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .yh-feed-item {
    display: grid;
    grid-template-columns: 132px 1fr;
    gap: 14px;
    padding: 11px 4px;
    border-bottom: 1px solid var(--yh-line);
    &.scale-大事 .yh-feed-title {
      color: var(--yh-seal);
    }
    &.is-已结束 {
      opacity: 0.55;
      .yh-feed-title {
        color: var(--yh-ink-dim);
      }
    }
    &:hover .yh-feed-remove {
      opacity: 1;
    }
  }
  .yh-feed-when {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 2px;
  }
  .yh-feed-time {
    font-size: 11.5px;
    color: var(--yh-ink-dim);
    font-variant-numeric: tabular-nums;
  }
  .yh-feed-place {
    font-size: 11px;
    color: var(--yh-ink-faint);
  }
  .yh-feed-main {
    min-width: 0;
  }
  .yh-feed-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .yh-feed-title {
    font-size: 13.5px;
    font-weight: 600;
  }
  .yh-feed-desc {
    margin: 3px 0 4px;
    color: var(--yh-ink-dim);
    max-width: 66ch;
  }
  .yh-feed-cause {
    margin: 0 0 3px;
    font-size: 11.5px;
    color: var(--yh-ink-faint);
    max-width: 66ch;
  }
  .yh-trail-toggle {
    font-size: 11px;
    padding: 1px 0;
    margin: 0 0 4px;
    color: var(--yh-ink-faint);
    &:hover {
      color: var(--yh-accent-strong);
    }
  }
  .yh-feed-trail {
    list-style: none;
    margin: 0 0 5px;
    padding: 3px 0 3px 13px;
    border-left: 2px solid var(--yh-line-strong);
    display: flex;
    flex-direction: column;
    gap: 4px;
    li {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .yh-trail-time {
      flex: none;
      font-size: 10.5px;
      color: var(--yh-ink-faint);
      font-variant-numeric: tabular-nums;
    }
    .yh-trail-text {
      font-size: 11.5px;
      color: var(--yh-ink-dim);
    }
  }
  .yh-feed-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 11px;
    font-size: 11px;
    color: var(--yh-ink-faint);
  }
  .yh-feed-remove {
    opacity: 0;
    width: 20px;
    height: 20px;
    border-radius: 6px;
    color: var(--yh-ink-faint);
    &:hover {
      color: var(--yh-seal);
    }
  }
  .yh-feed-edit {
    width: 20px;
    height: 20px;
    border-radius: 6px;
    color: var(--yh-ink-faint);
    opacity: 0.6;
    &:hover {
      color: var(--yh-accent-strong);
      opacity: 1;
    }
  }
  .yh-inline-edit {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .yh-edit-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 7px;
  }
  .yh-edit-actions {
    display: flex;
    gap: 6px;
  }
  .yh-detail-actions {
    display: flex;
    gap: 4px;
  }
  .yh-badge {
    display: inline-flex;
    align-items: center;
    padding: 0 7px;
    border-radius: 999px;
    font-size: 10.5px;
    border: 1px solid var(--yh-line-strong);
    color: var(--yh-ink-dim);
    &.yh-badge-大事 {
      border-color: var(--yh-seal);
      color: var(--yh-seal);
      background: color-mix(in srgb, var(--yh-seal) 10%, transparent);
    }
    &.yh-badge-要事 {
      border-color: var(--yh-gold);
      color: var(--yh-gold);
    }
    &.yh-badge-urgent {
      border-color: var(--yh-seal);
      color: var(--yh-seal);
      background: color-mix(in srgb, var(--yh-seal) 10%, transparent);
    }
    &.yh-badge-secret {
      border-style: dashed;
      color: var(--yh-seal);
    }
    &.yh-badge-done {
      color: var(--yh-ink-faint);
    }
    &.yh-badge-add {
      border-color: var(--yh-good);
      color: var(--yh-good);
    }
    &.yh-badge-upd {
      border-color: var(--yh-gold);
      color: var(--yh-gold);
    }
  }

  // ---- 脉络 ----
  .yh-master {
    border-right: 1px solid var(--yh-line);
    overflow-y: auto;
    padding: 16px 0;
    height: 100%;
  }
  .yh-master-list {
    display: flex;
    flex-direction: column;
  }
  .yh-master-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: 9px 16px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    cursor: pointer;
    transition: background 0.15s;
    strong {
      font-size: 13px;
      color: var(--yh-ink);
    }
    span {
      font-size: 11px;
      color: var(--yh-ink-faint);
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    &:hover {
      background: var(--yh-hover);
    }
    &.is-active {
      background: var(--yh-raise);
      border-left-color: var(--yh-accent);
    }
  }
  .yh-detail {
    overflow-y: auto;
    padding: 18px 20px;
    height: 100%;
  }
  .yh-detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    h3 {
      margin: 0;
      font-family: var(--yh-serif);
      font-size: 20px;
      letter-spacing: 0.1em;
    }
  }
  .yh-detail-rows {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .yh-detail-row {
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: 12px;
    padding: 9px 13px;
    background: var(--yh-raise);
    border: 1px solid var(--yh-line);
    border-radius: 9px;
    dt {
      font-size: 11.5px;
      color: var(--yh-ink-faint);
      padding-top: 2px;
      letter-spacing: 0.1em;
    }
    dd {
      margin: 0;
      color: var(--yh-ink);
    }
  }
  .yh-detail-hint {
    margin-top: 14px;
    font-size: 11.5px;
    color: var(--yh-ink-faint);
  }

  // ---- 日志 ----
  .yh-log-left,
  .yh-log-right {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .yh-log-record {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .yh-log-meta {
    margin: 0;
    font-size: 11.5px;
    color: var(--yh-ink-faint);
  }
  .yh-log-summary {
    margin: 0;
    color: var(--yh-accent-strong);
  }
  .yh-log-diff {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;

    // 长标题列表会让徽标折成多行: 限制宽度让其正常换行, 胶囊圆角在多行下会撑破边框, 放宽为小圆角
    .yh-badge {
      max-width: 100%;
      border-radius: 8px;
      white-space: normal;
      word-break: break-word;
      text-align: left;
    }
  }
  .yh-log-section {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .yh-collapse {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: none;
    color: var(--yh-ink-dim);
    cursor: pointer;
    font-size: 12px;
    padding: 2px 0;
    &:hover {
      color: var(--yh-ink);
    }
    svg {
      transition: transform 0.15s;
      &.is-flipped {
        transform: rotate(-90deg);
      }
    }
  }
  .yh-pre {
    margin: 0;
    padding: 9px 11px;
    background: var(--yh-bg);
    border: 1px solid var(--yh-line);
    border-radius: 9px;
    font-size: 11px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 190px;
    overflow-y: auto;
    color: var(--yh-ink-dim);
    &.yh-pre-short {
      max-height: 140px;
    }
    &.yh-pre-error {
      color: var(--yh-seal);
      border-color: color-mix(in srgb, var(--yh-seal) 40%, transparent);
    }
  }
  .yh-log-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-top: 3px;
  }
  .yh-log-right-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .yh-log-right-actions {
    display: flex;
    gap: 5px;
  }
  .yh-console {
    background: var(--yh-bg);
    border: 1px solid var(--yh-line);
    border-radius: 9px;
    padding: 7px 11px;
    max-height: 220px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .yh-console-line {
    margin: 0;
    font-size: 11px;
    color: var(--yh-ink-dim);
    word-break: break-all;
    &.is-warn {
      color: var(--yh-gold);
    }
    &.is-error {
      color: var(--yh-seal);
    }
  }
  .yh-console-time {
    color: var(--yh-ink-faint);
    margin-right: 7px;
    font-variant-numeric: tabular-nums;
  }

  // ---- 设置 ----
  .yh-set-col {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 15px;
    background: var(--yh-bg);
    border: 1px solid var(--yh-line);
    border-radius: 11px;
  }
  .yh-set-col .yh-col-title {
    margin-bottom: 1px;
  }
  .yh-set-stack {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .yh-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .yh-field-label {
    font-size: 11.5px;
    color: var(--yh-ink-dim);
  }
  .yh-field-pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 11px;
  }
  .yh-input {
    pointer-events: auto;
    width: 100%;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--yh-line-strong);
    background: var(--yh-panel);
    color: var(--yh-ink);
    outline: none;
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
    &::placeholder {
      color: var(--yh-ink-faint);
    }
    &:focus {
      border-color: var(--yh-accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--yh-seal) 15%, transparent);
    }
  }
  textarea.yh-input {
    resize: vertical;
    min-height: 52px;
  }
  .yh-select {
    appearance: none;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--yh-ink-dim) 50%),
      linear-gradient(135deg, var(--yh-ink-dim) 50%, transparent 50%);
    background-position:
      calc(100% - 15px) 55%,
      calc(100% - 10px) 55%;
    background-size: 5px 5px;
    background-repeat: no-repeat;
    padding-right: 26px;
  }
  .yh-key-row {
    display: flex;
    gap: 5px;
    align-items: center;
    .yh-input {
      flex: 1;
    }
  }
  .yh-preset-row {
    display: flex;
    gap: 5px;
    align-items: center;
    .yh-input {
      flex: 1;
    }
  }
  .yh-toggles {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .yh-toggle {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    cursor: pointer;
    input {
      display: none;
      &:checked + .yh-toggle-track {
        background: var(--yh-accent);
        border-color: var(--yh-accent);
        &::after {
          left: 14px;
          background: var(--yh-on-accent);
        }
      }
    }
  }
  .yh-toggle-track {
    flex: none;
    position: relative;
    width: 30px;
    height: 17px;
    margin-top: 2px;
    border-radius: 999px;
    border: 1px solid var(--yh-line-strong);
    background: var(--yh-panel);
    transition: all 0.18s;
    &::after {
      content: '';
      position: absolute;
      left: 2px;
      top: 2px;
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: var(--yh-ink-faint);
      transition: all 0.18s;
    }
  }
  .yh-toggle-text {
    font-size: 12px;
    em {
      display: block;
      font-style: normal;
      font-size: 11px;
      color: var(--yh-ink-faint);
    }
  }

  // ---- 空状态 / 滚动条 / 选区 / 焦点 ----
  .yh-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 9px;
    color: var(--yh-ink-faint);
    padding: 40px 0;
    p {
      margin: 0;
      text-align: center;
    }
    &.yh-empty-slim {
      padding: 20px 0;
    }
  }
  ::selection {
    background: color-mix(in srgb, var(--yh-seal) 32%, transparent);
  }
  ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  ::-webkit-scrollbar-thumb {
    background: var(--yh-line-strong);
    border-radius: 999px;
    border: 2px solid transparent;
    background-clip: padding-box;
    &:hover {
      background: var(--yh-ink-faint);
      background-clip: padding-box;
    }
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--yh-seal) 55%, transparent);
    outline-offset: 1px;
  }

  .yh-footer {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    padding: 7px 14px;
    border-top: 1px solid var(--yh-line);
    font-size: 11px;
    color: var(--yh-ink-faint);
  }

  // ---- 白天: 月白 × 黛青 × 朱 ----
  &[data-theme='light'] {
    --yh-accent: oklch(0.25 0.006 270);
    --yh-accent-strong: oklch(0.4 0.007 270);
    --yh-accent-deep: oklch(0.33 0.007 270);
    --yh-on-accent: oklch(0.97 0.002 95);
    --yh-seal: oklch(0.55 0.19 30);
    --yh-ink: oklch(0.25 0.006 270);
    --yh-ink-dim: oklch(0.47 0.007 270);
    --yh-ink-faint: oklch(0.6 0.007 270);
    --yh-bg: oklch(0.93 0.003 95);
    --yh-panel: oklch(0.975 0.002 95);
    --yh-raise: oklch(0.945 0.003 95);
    --yh-hover: oklch(0.9 0.004 95);
    --yh-line: oklch(0.88 0.004 95);
    --yh-line-strong: oklch(0.78 0.006 95);
    --yh-gold: oklch(0.5 0.09 85);
    --yh-good: oklch(0.47 0.08 148);
    --yh-shadow: 0 18px 48px rgba(0, 0, 0, 0.18), 0 3px 12px rgba(0, 0, 0, 0.12);
    .yh-orb {
      background: var(--yh-panel);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
      .yh-orb-status {
        border-color: var(--yh-panel);
      }
    }
  }

  // ---- 窄屏/手机 ----
  // 断点与 computePanelSize 的 isNarrow(<700) 保持一致; 此外面板尺寸由 JS 决定,
  // CSS 只负责面板**内部**布局的收缩
  @media (max-width: 700px) {
    .yh-panel {
      border-radius: 10px;
    }
    // 左侧竖排 rail → 底部横排标签栏(拇指可达): 竖排文字在窄屏挤占宽度,
    // 底栏是手机的原生导航位置
    .yh-frame {
      flex-direction: column-reverse;
    }
    .yh-rail {
      flex-direction: row;
      width: 100%;
      justify-content: space-around;
      gap: 0;
      padding: 4px 2px calc(4px + env(safe-area-inset-bottom, 0px));
      border-right: none;
      border-top: 1px solid var(--yh-line);
      .yh-rail-item {
        flex: 1;
        min-height: 44px; // 触摸目标下限
        padding: 8px 2px;
        &::before {
          // 竖向指示条 → 顶部横向指示条
          left: 50%;
          top: 0;
          transform: translateX(-50%) scaleX(0);
          width: 18px;
          height: 2px;
        }
        &.is-active::before {
          transform: translateX(-50%) scaleX(1);
        }
        .yh-rail-text {
          writing-mode: horizontal-tb;
          letter-spacing: 0.18em;
          font-size: 11.5px;
        }
      }
    }
    .yh-page {
      padding: 12px;
      &.yh-page-master,
      &.yh-page-logs,
      &.yh-page-settings {
        grid-template-columns: 1fr;
      }
      &.yh-page-master {
        padding: 12px;
        overflow-y: auto;
        display: block;
      }
      &.yh-page-logs,
      &.yh-page-settings {
        overflow-y: auto;
      }
    }
    .yh-master {
      border-right: none;
      border-bottom: 1px solid var(--yh-line);
      padding: 10px 0;
      height: auto; // block 布局下不占满, 由页容器统一滚动
    }
    // 选中指示从左竖条改为顶部横条(与底部标签栏视觉一致)
    .yh-master-item {
      border-left: none;
      border-top: 2px solid transparent;
      padding: 12px 14px;
      &.is-active {
        border-top-color: var(--yh-accent);
      }
    }
    .yh-now-columns,
    .yh-edit-grid,
    .yh-field-pair {
      grid-template-columns: 1fr;
    }
    .yh-feed-item {
      grid-template-columns: 1fr;
      gap: 5px;
    }
    .yh-feed-when {
      flex-direction: row;
      gap: 8px;
    }
    // 触屏没有 hover: 靠 hover 显形的操作按钮(移除/编辑)常显, 避免功能不可达
    @media (hover: none) {
      .yh-feed-remove,
      .yh-feed-edit {
        opacity: 0.85;
      }
    }
    .yh-footer {
      flex-wrap: wrap;
      gap: 3px 10px;
    }
    // 详情行的字段名列在超窄下折到值上方, 避免挤压
    .yh-detail-row {
      grid-template-columns: 1fr;
      gap: 3px;
    }
    // 表单行内编辑在窄屏改为纵向
    .yh-edit-row {
      grid-template-columns: 1fr 1fr;
    }
    // 触摸目标: 图标按钮与状态胶囊放大到 ≥40px 触达面积(视觉尺寸不变, 用 padding 扩)
    .yh-icon-btn {
      width: 40px;
      height: 40px;
    }
    .yh-btn {
      padding: 9px 14px; // 按钮 ≥40px 高
    }
    .yh-status {
      padding: 6px 12px;
    }
    // 品牌副标语在窄屏塞不下, 收起(名字保留)
    .yh-brand-sub {
      display: none;
    }
  }
}

/* ---- 世界 ---- */
.yh-world-sec {
  margin-bottom: 6px;
  > summary {
    display: flex;
    align-items: center;
    gap: 7px;
    cursor: pointer;
    list-style: none;
    padding: 5px 0 7px;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.22em;
    color: var(--yh-ink-dim);
    user-select: none;
    &::-webkit-details-marker {
      display: none;
    }
    em {
      font-style: normal;
      font-weight: 400;
      font-size: 11px;
      letter-spacing: 0;
      color: var(--yh-ink-faint);
    }
    .yh-world-caret {
      color: var(--yh-ink-faint);
      transition: transform 0.15s ease;
    }
    &:hover {
      color: var(--yh-accent-strong);
    }
  }
  &:not([open]) > summary .yh-world-caret {
    transform: rotate(-90deg);
  }
}
.yh-world-list {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.yh-world-grid {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
}
.yh-world-card {
  background: var(--yh-raise);
  border: 1px solid var(--yh-line);
  border-radius: 9px;
  padding: 9px 12px 10px;
}
.yh-world-card-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  strong {
    font-size: 13px;
    font-weight: 600;
    color: var(--yh-ink);
  }
}
.yh-world-delta {
  font-size: 11px;
  line-height: 1.45;
  color: var(--yh-ink-faint);
}
.yh-world-main {
  margin: 5px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--yh-ink);
}
.yh-world-fields {
  margin: 7px 0 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 10px;
  align-items: baseline;
  > div {
    display: contents;
  }
  dt {
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--yh-ink-faint);
  }
  dd {
    margin: 0;
    font-size: 12px;
    line-height: 1.55;
    color: var(--yh-ink-dim);
  }
}
.yh-maturity-酝酿 {
  color: var(--yh-ink-faint);
}
.yh-maturity-将熟 {
  border-color: var(--yh-gold);
  color: var(--yh-gold);
  background: color-mix(in srgb, var(--yh-gold) 10%, transparent);
}
.yh-maturity-已爆发 {
  border-color: var(--yh-seal);
  color: var(--yh-seal);
  background: color-mix(in srgb, var(--yh-seal) 12%, transparent);
}
.yh-metric-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.yh-metric-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.yh-metric-name {
  font-size: 12px;
  color: var(--yh-ink-dim);
}
.yh-metric-value {
  font-size: 15px;
  font-weight: 700;
  color: var(--yh-ink);
}
.yh-metric-trend {
  font-size: 11px;
  color: var(--yh-ink-faint);
}
.yh-metric-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--yh-ink-faint);
}
.yh-world-hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--yh-ink-faint);
}
.yh-world-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--yh-raise);
  border: 1px solid var(--yh-line-strong);
  border-radius: 9px;
  padding: 10px 12px 12px;
  margin-bottom: 10px;
}
.yh-world-edit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
}
.yh-world-add {
  margin-left: auto;
  padding: 2px 8px;
}
.yh-world-card-actions {
  display: flex;
  gap: 2px;
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.yh-world-card:hover .yh-world-card-actions {
  opacity: 1;
}
.yh-world-act {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--yh-ink-faint);
  cursor: pointer;
  transition:
    color 0.12s ease,
    background 0.12s ease;
  &:hover {
    color: var(--yh-ink);
    background: var(--yh-hover);
  }
}
.yh-metric-top .yh-metric-value {
  margin-left: auto;
}
.yh-metric-top .yh-world-card-actions {
  margin-left: 4px;
}
@media (hover: none) {
  .yh-world-card-actions {
    opacity: 0.85;
  }
  .yh-world-act {
    width: 28px;
    height: 28px;
  }
}
</style>
