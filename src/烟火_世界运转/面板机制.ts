// 烟火 · 面板机制(候选 9): iframe 尺寸 / 悬浮球拖动 / 面板拖动 / 面板阴影 / 推进中弹条 / 跨 document 挂载。
//
// 这些以前全在 悬浮球界面.vue 的 <script setup> 里(约 450 行), 和六个页签的数据逻辑混在一起,
// 于是整块无法执行测试——面板机制只能靠真机验收。现在收成这一个 composable:
// 暴露出去的名字与行为一个不改(模板里的 ref 名 rootEl/panelRef/headerEl、class 名 .yh-orb/.yh-panel、
// 拖动跟手/吸附/阴影/弹条动画/跨 document 挂载的实现都照旧), 视图只消费。
// 要改拖动、吸附、贴球、阴影、弹条, 只来这个文件。
//
// "跨 document 挂载"指: 面板跑在外层 iframe 里的 document(见 悬浮球界面.ts), 而阴影层与弹条
// 要挂到酒馆页面(document)上才不被 iframe 的 clip-path 裁掉, 所以这里的 parentWin/parentDoc 是那一个 document。
import type { Ref } from 'vue';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { klona } from 'klona';
import { useHost } from './host';
import { UI_KEY } from './state';
import { setToastAnchor, setToastColors } from './toast';
import type { 主题模式 } from './主题';
import { 弹窗兜底配色, 弹窗变量, 层序, 取弹窗配色, 悬浮球直径 } from './主题';

/** 球直径只从主题 token 取一处(以前这里手抄 40, 样式表里再抄两个) */
const CLOSED_SIZE = 悬浮球直径;

export interface 面板机制依赖 {
  /** 「世界正在推进」——推进中弹条的出现/消失看它 */
  推进中: Ref<boolean>;
  /** 推进中的一句话文案(弹条上那行字) */
  推进文案: Ref<string>;
  /** 点弹条上的「中断」 */
  中断推进: () => void;
}

/**
 * 面板机制: 返回值里的名字与模板里用的一一对应(isDragging/panelOpen/orbStyle/onOrbPointerDown…)。
 * 只在 悬浮球界面.vue 的 setup 里调一次。
 */
export function 使用面板机制(依赖: 面板机制依赖) {
  // ---------------------------------------------------------------------------
  // 界面偏好(悬浮球位置/面板位置/主题)存全局变量
  // ---------------------------------------------------------------------------

  interface UiPrefs {
    x: number;
    y: number;
    主题: 主题模式;
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

  const theme = ref<主题模式>(readUiPrefs()?.主题 ?? 'dark');
  /** 把面板主题色同步给贴球弹窗与更新弹条(浅色/深色跟随面板): 配色来自 主题.ts, 这里不再手抄色值 */
  function applyToastTheme() {
    const 配色 = 取弹窗配色(theme.value);
    setToastColors(配色);
    // 更新弹条不在弹窗容器里, 单独补主题变量
    if (pillEl.value) {
      pillEl.value.style.setProperty(弹窗变量.bg, 配色.bg);
      pillEl.value.style.setProperty(弹窗变量.border, 配色.border);
      pillEl.value.style.setProperty(弹窗变量.text, 配色.text);
      pillEl.value.style.setProperty(弹窗变量.accent, 配色.accent);
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

  /**
   * 球 iframe 的**真实**视口矩形 —— 贴球定位(更新弹条/toast)的唯一锚点来源。
   *
   * 为什么不能只用 anchorX/anchorY: 那是本插件自己的逻辑球位, 而**收纳类插件(悬浮球收纳等)
   * 是直接改 iframe 本体的 style.left/top**, 且不发任何事件 —— 收纳之后逻辑锚点与真实位置脱节,
   * 弹窗会弹到"球原本应该在"的地方。iframe 的真实矩形天然跟着收纳走。
   */
  const 球矩形 = ref<{ x: number; y: number; w: number; h: number; cx: number; cy: number } | null>(null);

  /** 重新量球; 返回"是否变了"(没变就不惊动下游重排) */
  function 量球(): boolean {
    const el = frame.value;
    if (!el || !el.isConnected) {
      球矩形.value = null;
      return false;
    }
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) {
      球矩形.value = null;
      return false;
    }
    const 旧 = 球矩形.value;
    if (旧 && Math.abs(旧.x - r.left) < 0.5 && Math.abs(旧.y - r.top) < 0.5 && Math.abs(旧.w - r.width) < 0.5 && Math.abs(旧.h - r.height) < 0.5) return false;
    球矩形.value = { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    return true;
  }

  /** 矩形盯守的两个通道: 属性观察器(瞬时命中) + 慢轮询(兜底) —— 收纳类插件不发任何事件 */
  let 量球定时器: number | null = null;
  let 量球观察器: MutationObserver | null = null;

  const panelOpen = ref(false);
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
    el.style.cssText = `position:fixed;left:0;top:0;display:none;pointer-events:none;background:transparent;z-index:${层序.面板阴影};`;
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

  /** 贴球定位的统一取点: **真实矩形优先**, 退回逻辑锚点; 半径一并给出(收纳缩放也跟得上) */
  function 球锚点(): { x: number; y: number; r: number } {
    const 实 = 球矩形.value;
    if (实) return { x: 实.cx, y: 实.cy, r: Math.max(实.w, 实.h) / 2 };
    return { x: anchorX.value, y: anchorY.value, r: CLOSED_SIZE / 2 };
  }
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
    // **真实矩形优先**: 收纳类插件直接搬 iframe 本体, 逻辑球位会脱节(见 球矩形)。
    // 半径一并从真实矩形取, 于是收纳若同时缩放了球, 贴球间距也跟着变。
    const 实 = 球矩形.value;
    const 心x = 实 ? 实.cx : anchorX.value;
    const 心y = 实 ? 实.cy : anchorY.value;
    const 半径 = 实 ? Math.max(实.w, 实.h) / 2 : CLOSED_SIZE / 2;
    let left = 心x - 半径 - w - 10;
    if (left < 8) left = 心x + 半径 + 10;
    left = clamp(left, 8, Math.max(8, vw - w - 8));
    const top = clamp(心y - h / 2, 8, Math.max(8, vh - h - 8));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function ensureUpdatePill() {
    const parentDoc = parentWin.value?.document;
    if (!parentDoc || pillEl.value) return;
    const el = parentDoc.createElement('div');
    el.style.cssText =
      'position:fixed;top:0;left:0;display:flex;align-items:center;gap:9px;padding:7px 9px 7px 15px;border-radius:999px;' +
      `background:var(--yh-toast-bg,${弹窗兜底配色.bg});border:1px solid var(--yh-toast-border,${弹窗兜底配色.border});color:var(--yh-toast-text,${弹窗兜底配色.text});` +
      `font:12px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);z-index:${层序.更新弹条};cursor:pointer;white-space:nowrap;transform-origin:left center;animation:yhPillIn .32s cubic-bezier(.34,1.56,.64,1);`;
    const keyframes = parentDoc.createElement('style');
    keyframes.textContent =
      '@keyframes yhPillBreath{0%,100%{opacity:.35}50%{opacity:1}}@keyframes yhPillIn{from{opacity:0;transform:translateX(14px) scale(.9)}to{opacity:1;transform:none}}';
    const dot = parentDoc.createElement('span');
    dot.style.cssText = `width:7px;height:7px;border-radius:50%;background:var(--yh-toast-accent,${弹窗兜底配色.accent});animation:yhPillBreath 1.4s ease-in-out infinite;flex:none;`;
    const text = parentDoc.createElement('span');
    text.textContent = 依赖.推进文案.value || '世界运转中…';
    const btn = parentDoc.createElement('button');
    btn.textContent = '中断';
    btn.style.cssText = `padding:3px 11px;border-radius:999px;border:1px solid var(--yh-toast-accent,${弹窗兜底配色.accent});background:transparent;color:var(--yh-toast-accent,${弹窗兜底配色.accent});cursor:pointer;font:12px "Segoe UI","Microsoft YaHei",sans-serif;`;
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      依赖.中断推进();
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

  watch([依赖.推进中, panelOpen], ([active, open]) => {
    if (active && !open) ensureUpdatePill();
    else removeUpdatePill();
  });
  watch(依赖.推进文案, msg => {
    if (pillEl.value) pillEl.value.children[2].textContent = msg || '世界运转中…';
  });
  // 拖动球时弹条与弹窗跟随(自己挪球: rAF 后真实矩形已跟上, 取真实值; 收纳挪球走 量球 的盯守通道)
  watch([anchorX, anchorY], () => {
    requestAnimationFrame(() => {
      量球();
      if (pillEl.value) positionUpdatePill();
      const 锚 = 球锚点();
      setToastAnchor(锚.x, 锚.y);
    });
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
  // 生命周期: 恢复偏好 → 定默认锚点 → 挂阴影层 → 应用 iframe 尺寸
  // (顺序与以前在 <script setup> 里逐条写下来时一致)
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
    量球();
    setToastAnchor(球锚点().x, 球锚点().y);
    // 收纳类插件直接搬 iframe 本体(改内联 left/top)且不发任何事件 —— 只能自己盯住真实矩形。
    // 双通道: MutationObserver 抓属性改动(命中即瞬时), 慢轮询只作兜底。
    const 跟球 = () => {
      if (!量球()) return;
      if (pillEl.value) positionUpdatePill();
      const 锚 = 球锚点();
      setToastAnchor(锚.x, 锚.y);
    };
    if (!量球观察器 && typeof MutationObserver !== 'undefined') {
      量球观察器 = new MutationObserver(跟球);
      const 球元素 = frame.value;
      if (球元素) 量球观察器.observe(球元素, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    if (量球定时器 === null) 量球定时器 = window.setInterval(跟球, 2000);
    parentWin.value?.addEventListener('resize', onViewportResize);
  });
  onUnmounted(() => {
    parentWin.value?.removeEventListener('resize', onViewportResize);
    if (量球定时器 !== null) window.clearInterval(量球定时器);
    量球定时器 = null;
    量球观察器?.disconnect();
    量球观察器 = null;
    removePanelShadow();
  });

  return {
    /** 模板 ref: 根元素(取 ownerDocument 定位它所在的 document) */
    rootEl,
    /** 模板 ref: 面板根 / 头部(拖动抓手) */
    panelRef,
    headerEl,
    /** 面板所在 iframe 的父窗口(酒馆页面), 弹窗与剪贴板要用 */
    parentWin,
    /** 主题(深色/白天), 模板绑在 .yh-root 的 data-theme 上; 换主题由模板写 theme.value */
    theme,
    panelOpen,
    isDragging,
    isPanelDragging,
    orbStyle,
    panelStyleRef,
    /** 悬浮球拖动 */
    onOrbPointerDown,
    onOrbClick,
    /** 面板拖动 / 收起 */
    onPanelPointerDown,
    closePanel,
  };
}
