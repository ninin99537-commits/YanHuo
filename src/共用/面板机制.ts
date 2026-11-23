// 共用 · 面板机制: iframe 尺寸 / 悬浮球拖动 / 面板拖动 / 面板阴影 / 贴球锚点 / 界面偏好持久化。
//
// 两个插件(烟火_世界运转 / 剧情导演)的窗口机制本来就是同一套: 同一颗 40×40 的 iframe、
// 同一套"球 ∪ 面板"联合矩形 + clip-path 裁剪、同一套阴影外置到酒馆页面、同一套拖动/夹取/落盘。
// 以前它是 剧情导演/面板机制.ts **fork 自** 烟火_世界运转/面板机制.ts, 两份 668/589 行各自演化,
// 结果写回纪律当场分叉: 烟火 `insertOrAssign` 整键覆盖(把别的窗口刚改的字段一起冲掉),
// 剧情导演做了"基线 + 只写改动字段"的合并。同一件事两份实现, 迟早还会再分叉一次。
//
// 现在: 几何/拖动/阴影/偏好全在这一份, 插件只提供**外观**(面板类名、阴影变量、球直径、阴影层序、
// 弹窗配色函数)与**存储接缝**(全局变量 + localStorage)。烟火独有的"推进中弹条"不在内核里 ——
// 它是建立在 贴球锚点 之上的一个下游消费者, 见 烟火_世界运转/推进弹条.ts。
//
// "跨 document 挂载"指: 面板跑在外层 iframe 里的 document, 而阴影层与弹条要挂到酒馆页面(document)上
// 才不被 iframe 的 clip-path 裁掉, 所以这里的 parentWin/parentDoc 是那一个 document。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { 建偏好会话, type 界面偏好, type 偏好存储 } from './界面偏好';
import { 取收纳坞, 取收纳坞入口 } from './收纳坞';

export type 主题模式 = 'dark' | 'light';

/** 弹窗配色(两个插件的 主题.ts 各给一份同构的值; 共用只按形状用) */
export interface 弹窗配色 {
  bg: string;
  border: string;
  text: string;
  accent: string;
  errorBg: string;
  errorBorder: string;
  errorText: string;
}

/**
 * 插件差异全部收在这里 —— 共用不认识 .yh-panel 或 .dj-panel, 也不认识任何一个 token 表。
 */
export interface 面板机制配置 {
  /** 模板里面板根的类名: 拖动时用它 closest 找面板本体('yh-panel' | 'dj-panel') */
  面板类名: string;
  /** 面板阴影的 CSS 变量名('--yh-shadow' | '--dj-shadow') */
  阴影变量: string;
  /** 悬浮球直径(px): 球宽高、锚点偏移、外层 iframe 尺寸、贴球定位都该用它 */
  球直径: number;
  /** 酒馆页面上阴影层的 z-index */
  阴影层序: number;
  /** 面板默认尺寸(窄屏另有规则, 不受这两个数影响) */
  面板宽: number;
  面板高: number;
  /** 贴球弹窗要跟着主题走: 由调用方接自己的 toast 模块 */
  提示条: {
    取配色(主题: 主题模式): 弹窗配色;
    设配色(配色: 弹窗配色): void;
    设锚点(x: number, y: number): void;
    /**
     * 面板开着时把提示条压住(关掉再补发)。不传 = 不压(老调用方行为不变)。
     * 为什么放在这里: 三个插件的面板开合都走同一个 panelOpen, 在这里接一次就不用每处再抄。
     */
    设抑制?(抑制: boolean): void;
  };
  /** 偏好存储接缝(全局变量 + localStorage) */
  存储: 偏好存储;
}

/**
 * 面板机制: 返回值里的名字与两个插件模板里用的一一对应
 * (isDragging / panelOpen / orbStyle / onOrbPointerDown …)。各插件的 悬浮球界面.vue 只调一次。
 */
export function 使用面板机制(配置: 面板机制配置) {
  const CLOSED_SIZE = 配置.球直径;
  const 偏好 = 建偏好会话(配置.存储);

  // ---------------------------------------------------------------------------
  // 主题 + 提示条配色
  // ---------------------------------------------------------------------------

  const theme = ref<主题模式>(偏好.读()?.主题 ?? 'dark');

  /** 把面板主题色同步给贴球弹窗/弹条(配色由调用方的 主题.ts 给, 这里不手抄任何色值) */
  function applyToastTheme() {
    配置.提示条.设配色(配置.提示条.取配色(theme.value));
  }

  // ---------------------------------------------------------------------------
  // iframe 尺寸、悬浮球拖动、面板拖动
  // ---------------------------------------------------------------------------

  const rootEl = ref<HTMLElement | null>(null);
  const frameWin = computed<Window | null>(() => rootEl.value?.ownerDocument?.defaultView ?? null);
  const frame = computed<HTMLIFrameElement | null>(() => (frameWin.value?.frameElement as HTMLIFrameElement | null) ?? null);
  const parentWin = computed<Window | null>(() => frameWin.value?.parent ?? null);

  /**
   * 球 iframe 的**真实**视口矩形 —— 贴球定位(弹窗/弹条/toast)的唯一锚点来源。
   *
   * 为什么不能只用 anchorX/anchorY: 那是本插件自己的逻辑球位, 而**收纳类插件(悬浮球收纳等)
   * 是直接改 iframe 本体的 style.left/top**, 且不发任何事件 —— 收纳之后逻辑锚点与真实位置脱节,
   * 弹窗会弹到"球原本应该在"的地方。iframe 的真实矩形天然跟着收纳走。
   * 量不到(未挂载/被隐藏/零尺寸)时回 null, 调用方各自退回逻辑锚点。
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
  /** 2026-11-13 P1-7: 我们把 resize 监听挂到了哪个窗口 —— 卸载时用它摘，不依赖 ref 还活着 */
  let 挂了resize的窗口: Window | null = null;
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
    el.style.cssText = `position:fixed;left:0;top:0;display:none;pointer-events:none;background:transparent;z-index:${配置.阴影层序};`;
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
      shadow.style.boxShadow = style.getPropertyValue(配置.阴影变量).trim() || 'none';
    }
    if (fade) shadow.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'cubic-bezier(0.2, 0.9, 0.25, 1)' });
  }

  const viewportW = (): number => parentWin.value?.innerWidth ?? window.innerWidth;
  const viewportH = (): number => parentWin.value?.innerHeight ?? window.innerHeight;

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  const anchorX = ref<number>(-100);
  const anchorY = ref<number>(-100);

  /**
   * 贴球定位的统一取点, 三档优先级:
   *   ① **被收纳坞收走** → 贴坞里属于本球的那个代理图标。收纳后坞把球**藏起来**(visibility:hidden)
   *      却**没搬走球 iframe**, 所以贴 iframe 会落在"球原来的位置" —— 就是用户看到的现象。
   *      图标 28×28 比球 40×40 小, 半径随图标走, 贴球间距自然跟着缩。
   *   ② 球 iframe 的**真实矩形** → 本插件自己挪球时用它;
   *   ③ 逻辑锚点兜底(还没上屏 / 量不到)。
   */
  function 球锚点(): { x: number; y: number; r: number } {
    const 入口 = 取收纳坞入口(parentWin.value?.document, frame.value);
    if (入口) {
      const r = 入口.getBoundingClientRect();
      if (r.width || r.height) return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: Math.max(r.width, r.height) / 2 };
    }
    const 实 = 球矩形.value;
    if (实) return { x: 实.cx, y: 实.cy, r: Math.max(实.w, 实.h) / 2 };
    return { x: anchorX.value, y: anchorY.value, r: CLOSED_SIZE / 2 };
  }

  /** 贴球锚点的**响应式快照**: 弹条等下游 watch 它, 免得各自去调非响应式的 球锚点() */
  const 贴球锚点 = ref<{ x: number; y: number; r: number }>({ x: -100, y: -100, r: CLOSED_SIZE / 2 });

  /** 坞被拖动/折叠/换锚点时不改变球 iframe, 所以"盯坞"与"盯球"是两条独立通道 */
  let 坞观察器: MutationObserver | null = null;
  function 盯住收纳坞(): void {
    if (坞观察器 || typeof MutationObserver === 'undefined') return;
    const 坞 = 取收纳坞(parentWin.value?.document);
    if (!坞) return;
    坞观察器 = new MutationObserver(() => 同步贴球锚点());
    坞观察器.observe(坞, { attributes: true, attributeFilter: ['style', 'class'], childList: true, subtree: true });
  }

  /**
   * 同步"贴球锚点"到 toast 与下游(弹条/气泡)。
   * **不能只在球动了时才同步**: 坞拖动/折叠/释放时球 iframe 一动不动, 锚点却变了 —— 所以按锚点值判重。
   */
  function 同步贴球锚点(强制 = false): void {
    盯住收纳坞();
    同步球指针();
    量球();
    const 锚 = 球锚点();
    const 旧 = 贴球锚点.value;
    if (!强制 && Math.abs(旧.x - 锚.x) < 0.5 && Math.abs(旧.y - 锚.y) < 0.5 && Math.abs(旧.r - 锚.r) < 0.5) return;
    贴球锚点.value = 锚;
    配置.提示条.设锚点(锚.x, 锚.y);
  }

  /** 面板位置(null=默认居中); 面板宽高由 CSS 决定 */
  const panelPos = ref<{ x: number; y: number } | null>(null);
  /** 挂载完成前 iframe 还没有布局, 视口尺寸不可信, 不计算默认锚点也不保存偏好 */
  let mountedDone = false;

  /**
   * 视口是否"量得出来"。iframe 刚挂载/被隐藏时 innerWidth/innerHeight 会是 0 或极小值，
   * 那一刻算出来的"右下角"其实是 (40,40) 这种毒值 —— 真机事故: 它被写进存储后
   * `anchor=20>0` 让后面的守卫永远不触发, 球永久停在 (2,2)。
   * ⇒ **视口不可用时只当帧渲染，绝不落盘**。
   */
  function 视口可用(vw = viewportW(), vh = viewportH()): boolean {
    return vw >= 200 && vh >= 200;
  }

  /**
   * 球位净化(导出以便单测): 只接受"球完整落在视口内"的坐标。
   * 下界用 **CLOSED_SIZE** 而不是半个球 —— 与拖动夹取同口径,
   * 于是 {x:20,y:20} 这类历史毒值一律判无效 → 走默认右下角(读取时净化)。
   */
  function 球位有效(x: unknown, y: unknown, vw: number, vh: number): boolean {
    const 半 = CLOSED_SIZE / 2;
    return (
      typeof x === 'number' && typeof y === 'number' &&
      Number.isFinite(x) && Number.isFinite(y) &&
      x >= CLOSED_SIZE && y >= CLOSED_SIZE &&
      x <= vw - 半 && y <= vh - 半
    );
  }

  /** 球的默认位置: 右下角附近(与面板展开方向一致)。视口不可用时**不改 anchor**(只让当帧夹取兜底)。 */
  function 兜底球心(): void {
    if (!视口可用()) return;
    const vw = viewportW();
    const vh = viewportH();
    if (!球位有效(anchorX.value, anchorY.value, vw, vh)) {
      anchorX.value = Math.max(CLOSED_SIZE, vw - 60);
      anchorY.value = Math.max(CLOSED_SIZE, vh - 130);
    }
  }

  /** 面板尺寸(视口够小时收缩), 由 JS 按父窗口算好以内联样式固定, 避免面板依赖 iframe 视口 */
  const panelW = ref(配置.面板宽);
  const panelH = ref(配置.面板高);
  /** 是否窄屏(手机/窄窗口): 触发"面板近乎全屏 + 底部标签栏"的手机布局 */
  const isNarrow = ref(false);
  function computePanelSize() {
    isNarrow.value = viewportW() < 700;
    if (isNarrow.value) {
      // 窄屏: 面板铺满视口(只留安全边距), 高度给到可用高度的 94%——手机上小窗没有意义,
      // 全屏才能容纳内容; 边距从 24px 收到 8px
      panelW.value = Math.max(240, viewportW() - 8);
      panelH.value = Math.max(300, Math.round(viewportH() * 0.94));
    } else {
      panelW.value = Math.min(配置.面板宽, viewportW() - 24);
      panelH.value = Math.min(配置.面板高, viewportH() - 24);
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

  /**
   * 收纳坞把球**藏起来**却**没搬走球 iframe**, 那个 40×40 就悬在原地白吃点击。
   * 收纳中且面板没开 → 关掉自己 iframe 的指针事件; 面板一开 / 球被释放 → 立刻还回来。
   * 只碰本插件自己建的 iframe, 不去动坞。
   * (坞转发点击用的是 dispatchEvent, 不走命中测试, 所以关掉指针事件不影响坞点开面板)
   */
  function 同步球指针(): void {
    const target = frame.value;
    if (!target) return;
    const 被收纳 = !!取收纳坞入口(parentWin.value?.document, target);
    target.style.pointerEvents = 被收纳 && !panelOpen.value ? 'none' : 'auto';
  }

  function applyFrame() {
    const target = frame.value;
    if (!target) return;
    同步球指针();
    兜底球心();
    if (!panelOpen.value) {
      // 关闭: iframe 缩到球的大小跟随锚点, 不遮挡酒馆其他区域。
      // iframe 元素本身也裁成圆形——否则四个透明方角会把底下(可能是浅色的)楼层界面露出来,
      // 看起来就像球自带一个方形背景
      const left = clamp(anchorX.value - CLOSED_SIZE / 2, 2, Math.max(2, viewportW() - CLOSED_SIZE - 2));
      const top = clamp(anchorY.value - CLOSED_SIZE / 2, 2, Math.max(2, viewportH() - CLOSED_SIZE - 2));
      target.style.width = `${CLOSED_SIZE}px`;
      target.style.height = `${CLOSED_SIZE}px`;
      target.style.left = `${left}px`;
      target.style.top = `${top}px`;
      target.style.borderRadius = '50%';
      target.style.clipPath = 'none';
      frameOrigin.value = { x: left, y: top };
      syncPanelShadow();
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
    // 下界必须与 球位有效() 同口径(CLOSED_SIZE, 不是半个球): 夹到 20 这种值会被判毒值,
    // 紧接着 兜底球心 把球弹到右下角 —— 窗口一缩小球就"跳"走。
    anchorX.value = clamp(anchorX.value, CLOSED_SIZE, Math.max(CLOSED_SIZE, viewportW() - CLOSED_SIZE / 2));
    anchorY.value = clamp(anchorY.value, CLOSED_SIZE, Math.max(CLOSED_SIZE, viewportH() - CLOSED_SIZE / 2));
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

  function persistPrefs() {
    // 没量出视口 / 球位不合法(历史毒值) 时**不落盘** —— 否则会把当帧的兜底结果永久写进去
    if (!mountedDone || !视口可用() || !球位有效(anchorX.value, anchorY.value, viewportW(), viewportH())) return;
    // 跳过 null 字段: 面板没被拖过时**不写** 面板x/面板y,
    // 免得用 null 覆盖存储里那份有效坐标(写回是按字段差异合并的, 缺键=不改)。
    const 要存: 界面偏好 = { x: anchorX.value, y: anchorY.value, 主题: theme.value };
    if (panelPos.value) {
      要存.面板x = panelPos.value.x;
      要存.面板y = panelPos.value.y;
    }
    偏好.写(要存);
  }

  watch([panelOpen, anchorX, anchorY, panelPos], applyFrame);
  // 面板开着时压住**本插件自己的**提示条(它会被面板盖住/挡住操作), 关掉再补发。
  watch(panelOpen, 开 => 配置.提示条.设抑制?.(开));
  // iframe 一动(拖动/展开)就立刻重量真实矩形 —— 否则弹条/气泡要等下一次轮询才知道球挪了
  watch([panelOpen, anchorX, anchorY, panelPos], () => requestAnimationFrame(() => 同步贴球锚点(true)));
  // 拖动中不落盘: 拖球时 anchorX/anchorY 每帧都变, 而 偏好.写 会**读一次全局变量再写一次**
  // (跨插件宿主调用) —— 按帧来就是每帧一次平台往返。松手时由 onOrbUp / 面板拖动的 onUp 各写一次。
  watch([anchorX, anchorY], () => {
    if (isDragging.value || isPanelDragging.value) return;
    persistPrefs();
  });
  watch(theme, () => {
    persistPrefs();
    // 主题切换会改变阴影变量, 重算面板阴影层; 弹窗配色也跟随
    if (panelOpen.value) syncPanelShadow();
    applyToastTheme();
  });

  /** 球在 iframe 内的位置: 关闭时填满小 iframe, 打开时按锚点相对 iframe 原点定位 */
  const orbStyle = computed(() => {
    兜底球心();
    return panelOpen.value
      ? {
          left: `${clamp(anchorX.value - CLOSED_SIZE / 2, 0, Math.max(0, viewportW() - CLOSED_SIZE)) - frameOrigin.value.x}px`,
          top: `${clamp(anchorY.value - CLOSED_SIZE / 2, 0, Math.max(0, viewportH() - CLOSED_SIZE)) - frameOrigin.value.y}px`,
        }
      : { left: '0px', top: '0px' };
  });

  let startX = 0;
  let startY = 0;
  let startAnchorX = 0;
  let startAnchorY = 0;
  let moved = false;

  function parentClient(e: PointerEvent): { x: number; y: number } {
    const rect = frame.value?.getBoundingClientRect();
    if (e.view === frameWin.value && rect) return { x: rect.left + e.clientX, y: rect.top + e.clientY };
    return { x: e.clientX, y: e.clientY };
  }

  // ---- 悬浮球拖动 ----

  function onOrbPointerDown(e: PointerEvent) {
    // 只认主键(鼠标右键/中键不拖); 触摸的 button 恒为 0
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    isDragging.value = true;
    moved = false;
    // 起点与移动必须走**同一个**坐标换算。以前这里是手写的 `rect.left + e.clientX`,
    // 而 onOrbMove 走 parentClient(): 移动端一旦两边对"事件来自哪个窗口"的判断不一致,
    // 差出来的就是一整个 iframe 原点 —— 球会整块跳走, 然后偏着跟手指跑。
    const start = parentClient(e);
    startX = start.x;
    startY = start.y;
    startAnchorX = anchorX.value;
    startAnchorY = anchorY.value;
    // 触摸: 把后续 pointer 事件锁到球上 —— 手指移出 40×40 的 iframe 也不会丢事件
    try {
      (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
    } catch {
      // 宿主不支持/指针已失效: 双窗监听仍是兜底, 不因为这一句崩掉拖动
    }
    frameWin.value?.addEventListener('pointermove', onOrbMove);
    frameWin.value?.addEventListener('pointerup', onOrbUp);
    frameWin.value?.addEventListener('pointercancel', onOrbUp);
    parentWin.value?.addEventListener('pointermove', onOrbMove);
    parentWin.value?.addEventListener('pointerup', onOrbUp);
    parentWin.value?.addEventListener('pointercancel', onOrbUp);
  }

  function onOrbMove(e: PointerEvent) {
    const point = parentClient(e);
    if (Math.abs(point.x - startX) + Math.abs(point.y - startY) > 4) moved = true;
    // 下界与 球位有效() 同口径(CLOSED_SIZE 而不是半个球): 拖到的位置必须能通过读取时的净化
    anchorX.value = clamp(startAnchorX + (point.x - startX), CLOSED_SIZE, viewportW() - CLOSED_SIZE / 2);
    anchorY.value = clamp(startAnchorY + (point.y - startY), CLOSED_SIZE, viewportH() - CLOSED_SIZE / 2);
  }

  function onOrbUp() {
    isDragging.value = false;
    frameWin.value?.removeEventListener('pointermove', onOrbMove);
    frameWin.value?.removeEventListener('pointerup', onOrbUp);
    frameWin.value?.removeEventListener('pointercancel', onOrbUp);
    parentWin.value?.removeEventListener('pointermove', onOrbMove);
    parentWin.value?.removeEventListener('pointerup', onOrbUp);
    parentWin.value?.removeEventListener('pointercancel', onOrbUp);
    // 拖动期间不落盘(见下面 watch 的说明), 松手时补这一次
    persistPrefs();
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

  // ---- 面板拖动(按住头部空白处) ----

  const headerEl = ref<HTMLElement | null>(null);

  function onPanelPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    isPanelDragging.value = true;
    // 全程用视口坐标计算, iframe 跟随移动不影响手感。
    // 注意: iframe 内元素的 getBoundingClientRect 是 iframe 局部坐标, 要加上 iframe 原点才是视口坐标
    const panelEl = headerEl.value?.closest(`.${配置.面板类名}`) as HTMLElement | null;
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
      frameWin.value?.removeEventListener('pointercancel', onUp);
      parentWin.value?.removeEventListener('pointermove', onMove);
      parentWin.value?.removeEventListener('pointerup', onUp);
      parentWin.value?.removeEventListener('pointercancel', onUp);
      persistPrefs();
    };
    // 触摸: 锁到面板头部 —— 手指移出 iframe 也不会丢事件; pointercancel 必须收尾,
    // 否则移动端浏览器把手势判成滚动之后, isPanelDragging 会一直卡在 true。
    try {
      (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
    } catch {
      // 宿主不支持: 双窗监听兜底
    }
    frameWin.value?.addEventListener('pointermove', onMove);
    frameWin.value?.addEventListener('pointerup', onUp);
    frameWin.value?.addEventListener('pointercancel', onUp);
    parentWin.value?.addEventListener('pointermove', onMove);
    parentWin.value?.addEventListener('pointerup', onUp);
    parentWin.value?.addEventListener('pointercancel', onUp);
  }

  // ---------------------------------------------------------------------------
  // 生命周期: 恢复偏好 → 定默认锚点 → 上屏 → 装饰(阴影/配色)
  // 顺序有意如此: 球的位置先做完, 装饰任何一步抛错都不该把球留在原点
  // ---------------------------------------------------------------------------

  onMounted(() => {
    const saved = 偏好.读();
    const vw = viewportW();
    const vh = viewportH();
    // 读取时净化: 任何来源(localStorage / 全局变量)的旧值都要过 球位有效(),
    // 否则像 {x:20,y:20} 这种"早期兜底算出的毒值"会一直被当成合法值(真机事故)。
    const 存过坏值 = !!saved && (saved.x !== undefined || saved.y !== undefined) && !球位有效(saved.x, saved.y, vw, vh);
    if (saved && 球位有效(saved.x, saved.y, vw, vh)) {
      anchorX.value = saved.x as number;
      anchorY.value = saved.y as number;
    }
    if (saved && typeof saved.面板x === 'number' && typeof saved.面板y === 'number') panelPos.value = { x: saved.面板x, y: saved.面板y };
    兜底球心();
    if (存过坏值) {
      console.warn('[面板机制] 球位置不在视口内(历史毒值), 已纠正为右下角:', saved?.x, saved?.y);
      persistPrefs(); // 把纠正后的值写回, 免得刷新一次又读到旧毒值
    }
    mountedDone = true;
    // 先把"球的位置"这件事做完(兜底 + 上屏 + 锚点), 再做装饰性的阴影/配色:
    // 后者任何一步抛错都不该把球留在原点、也不该让气泡失去坐标。
    兜底球心();
    applyFrame();
    同步贴球锚点(true);
    // 收纳类插件直接搬 iframe 本体(改内联 left/top)、且不发任何事件 —— 只能自己盯住真实矩形。
    // 双通道: MutationObserver 抓属性改动(命中即瞬时), 慢轮询只作兜底。
    // **不用快轮询**: getBoundingClientRect 在脏布局上会触发整页回流, 为一次搬迁一直按秒级跑不划算。
    if (!量球观察器 && typeof MutationObserver !== 'undefined') {
      量球观察器 = new MutationObserver(() => 同步贴球锚点());
      const 球元素 = frame.value;
      if (球元素) 量球观察器.observe(球元素, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    if (量球定时器 === null) 量球定时器 = window.setInterval(() => 同步贴球锚点(), 2000);
    try {
      ensurePanelShadow();
    } catch (error) {
      console.warn('[面板机制] 面板阴影初始化失败:', error);
    }
    try {
      applyToastTheme();
    } catch (error) {
      console.warn('[面板机制] 提示条配色初始化失败:', error);
    }
    // 2026-11-13 P1-7: 挂的时候**存下来**，摘的时候用这个变量。
    // 以前 onUnmounted 里读 parentWin.value（computed 依赖模板 ref），Vue 卸载时可能先置空 ref
    // 再 flush um → remove 静默不执行 → 监听器永久留在父窗口（换 panel 实例就多一份）。
    挂了resize的窗口 = parentWin.value ?? null;
    挂了resize的窗口?.addEventListener('resize', onViewportResize);
  });

  onUnmounted(() => {
    挂了resize的窗口?.removeEventListener('resize', onViewportResize);
    挂了resize的窗口 = null;
    if (量球定时器 !== null) window.clearInterval(量球定时器);
    量球定时器 = null;
    量球观察器?.disconnect();
    量球观察器 = null;
    坞观察器?.disconnect();
    坞观察器 = null;
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
    /** 主题(深色/白天), 模板绑在根元素的 data-theme 上; 换主题由模板写 theme.value */
    theme,
    panelOpen,
    isDragging,
    isPanelDragging,
    orbStyle,
    panelStyleRef,
    /** 球的实时中心(父页面视口坐标) */
    球心坐标: computed(() => {
      兜底球心();
      return { x: anchorX.value, y: anchorY.value };
    }),
    /** 贴球锚点的响应式快照(被收纳时=坞图标, 否则=球) —— 弹条/气泡 watch 它跟随 */
    贴球锚点,
    /** 供下游(弹条/气泡)自己定位用的视口与夹取 */
    viewportW,
    viewportH,
    clamp,
    /** 悬浮球拖动 */
    onOrbPointerDown,
    onOrbClick,
    /** 面板拖动 / 收起 */
    onPanelPointerDown,
    closePanel,
  };
}
