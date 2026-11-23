// 共用 · 贴球提示条: 把「提示条怎么画」收在一处(彼方 / 烟火 / 剧情导演 三家同源)。
//
// 三个插件原来各有一份 toast.ts, 逐字重复同一套 DOM 生命周期: 建 style / stack / anchor 三个父页面元素、
// 贴球定位(左侧优先, 空间不足弹到右方, 越界收进视口)、纵向堆叠、点击或超时退场、把配色变量下发给容器。
// 差异只有**项目自己的几件事**, 所以它们不进这里, 而是从 配置 传进来:
//   前缀 / 配色变量名与兜底色 / 严重度色 / 球半径与兜底锚点 —— 外加剧情导演独有的提示档闸门(放行)。
//
// 用法: 每个项目在自己的 toast.ts 里 建提示条(配置), 把出口原样转出去; 项目其余代码照旧 import 自己的 toast。
// 这个 module 只碰 DOM, 不碰酒馆助手全局 —— tests/platform-usage.mjs 对 src/共用 的要求是「一处都不许有」。
//
// 跨 document 约定(三家一致, 行为不变): 提示条画在**酒馆父页面**上。脚本与悬浮球界面跑在 iframe 里,
// 这里用 window.parent.document 拿父文档; 取不到(顶层窗口 / 跨域)时**静默不显示**, 不退回画在自己文档里。
// 父页面上的元素按 前缀 取名(`<前缀>-toast-style` / `-stack` / `-anchor`), 三个插件各占一套, 互不干扰。

export type ToastType = 'success' | 'info' | 'warning' | 'error';

/** 提示条配色: 7 项都可选, 只下发给了的那几项(键与各项目 theme.ts 的 弹窗配色 一致) */
export interface 提示条配色 {
  bg?: string;
  border?: string;
  text?: string;
  accent?: string;
  errorBg?: string;
  errorBorder?: string;
  errorText?: string;
}

export type 配色键 = keyof 提示条配色;

/**
 * 外观: 只影响"长什么样", 不影响定位 / 堆叠 / 计时 / 层级。
 * 每一项都有缺省值(= 重构前的样子), 所以不传 外观 的项目行为逐字不变。
 */
export interface 提示条外观 {
  /** 圆角(px), 默认 12 */
  圆角?: number;
  /** 阴影, 默认 '0 8px 24px rgba(0,0,0,.45)' */
  阴影?: string;
  /** 左边线宽度(px), 默认 3 */
  边线宽?: number;
  /** 内边距, 默认 '9px 14px' */
  内边距?: string;
  /** 字体简写, 默认 '12px/1.6 "Segoe UI","Microsoft YaHei",sans-serif' */
  字体?: string;
  /** 错误档是否整块换 errorBg/errorText 底色, 默认 true(彼方关掉: 只换左边线, 形状不变) */
  错误整块换色?: boolean;
  /** 错误档是否用大圆叹号标记, 默认 true; false = 四档同一颗圆点(只有颜色不同) */
  错误大标记?: boolean;
  /** 入场动画, 默认 '<前缀>ToastIn .3s cubic-bezier(.34,1.56,.64,1)' */
  入场动画?: string;
  /** 错误档动画(缺省 = 入场动画 + 晃动) */
  错误动画?: string;
  /** 退场动画, 默认 '<前缀>ToastOut .2s ease forwards' */
  退场动画?: string;
}


export interface 提示条配置 {
  /** 元素 id 与 CSS 动画名的前缀: 'bf' / 'yh' / 'dj' */
  前缀: string;
  /** 7 项配色对应的 CSS 变量名(取各项目 theme.ts 的 弹窗变量) */
  配色变量: Record<配色键, string>;
  /** 变量还没被 setToastColors 设上时的兜底色(逐项目保留各自现值) */
  配色兜底: Record<配色键, string>;
  /** 左边框的严重度色。error 这一项是**左边框**用的颜色; 标记点(圆点/叹号)的 error 一律走 配色变量.errorBorder */
  严重度色: Record<ToastType, string>;
  /** 球的半径(锚点 x,y 是球心): 贴球定位按它让开, 即 悬浮球直径/2 */
  球半径: number;
  /** 读不到锚点时的兜底球心(右下角) */
  兜底锚点: (视口宽: number, 视口高: number) => { x: number; y: number };
  /** 提示条堆栈的 z-index(默认 2147482998) */
  堆栈层序?: number;
  /** 这一档要不要出声(剧情导演的四档闸门); 不传 = 全部放行 */
  放行?: (type: ToastType) => boolean;
  /** 外观覆盖(不传 = 逐字保持重构前样式) */
  外观?: 提示条外观;
}

/** 建提示条 的出口: 四个提示出口 + 配色下发 + 锚点下发 + 面板开合闸门 */
export interface 提示条出口 {
  showToast: (type: ToastType, message: string, title?: string) => void;
  toastSuccess: (message: string, title?: string) => void;
  toastInfo: (message: string, title?: string) => void;
  toastWarning: (message: string, title?: string) => void;
  toastError: (message: string, title?: string) => void;
  setToastColors: (colors: 提示条配色) => void;
  setToastAnchor: (x: number, y: number) => void;
  /**
   * 面板开着的时候**先压住**提示条(2026-11-07, 用户要求):
   * 面板一开就遮住球和弹窗的位置, 此刻弹条既看不清也挡操作; 关掉面板再按原顺序放出来。
   * 压住 ≠ 丢掉: 攒着(有上限), 关面板时补发, 免得"失败提示"被面板吃掉。
   */
  setToastSuppressed: (suppressed: boolean) => void;
}

/** 停留时长: 错误最长(给人读完), 警告次之 */
const 停留时长: Record<ToastType, number> = { success: 3400, info: 3400, warning: 5200, error: 8000 };

const 默认堆栈层序 = 2147482998;

/** 取酒馆父文档: 顶层窗口或跨域时 null(调用方据此静默不显示) */
function 取父文档(): Document | null {
  try {
    return window.parent !== window ? window.parent.document : null;
  } catch {
    return null;
  }
}

export function 建提示条(配置: 提示条配置): 提示条出口 {
  const { 前缀, 配色变量, 配色兜底, 严重度色, 球半径, 兜底锚点, 放行 } = 配置;
  const 堆栈层序 = 配置.堆栈层序 ?? 默认堆栈层序;
  const 外观 = 配置.外观 ?? {};
  const 圆角 = 外观.圆角 ?? 12;
  const 阴影 = 外观.阴影 ?? '0 8px 24px rgba(0,0,0,.45)';
  const 边线宽 = 外观.边线宽 ?? 3;
  const 内边距 = 外观.内边距 ?? '9px 14px';
  const 字体 = 外观.字体 ?? '"Segoe UI","Microsoft YaHei",sans-serif';
  const 错误整块换色 = 外观.错误整块换色 !== false;
  const 错误大标记 = 外观.错误大标记 !== false;

  /** 面板开着时压住提示条; 攒下来的按原顺序在关面板时补发(上限防止攒一整局) */
  let 抑制 = false;
  const 暂存: { type: ToastType; message: string; title?: string }[] = [];
  const 暂存上限 = 6;

  const 样式ID = `${前缀}-toast-style`;
  const 堆栈ID = `${前缀}-toast-stack`;
  const 锚点ID = `${前缀}-toast-anchor`;
  const 入场动画 = 外观.入场动画 ?? `${前缀}ToastIn .3s cubic-bezier(.34,1.56,.64,1)`;
  const 错误动画 = 外观.错误动画 ?? `${入场动画},${前缀}ToastShake .45s ease .32s`;
  const 退场动画 = 外观.退场动画 ?? `${前缀}ToastOut .2s ease forwards`;

  /** 取一个配色的 CSS 表达式: var(变量名, 兜底色) */
  const 取色 = (键: 配色键) => `var(${配色变量[键]},${配色兜底[键]})`;

  const 基础样式 =
    `display:flex;align-items:flex-start;gap:9px;padding:${内边距};border-radius:${圆角}px;background:${取色('bg')};` +
    `border:1px solid ${取色('border')};color:${取色('text')};font:12px/1.6 ${字体};` +
    `box-shadow:${阴影};pointer-events:auto;cursor:pointer;max-width:100%;` +
    'max-height:50vh;overflow:auto;white-space:pre-wrap;word-break:break-word;' +
    `animation:${入场动画};`;

  /** 错误弹窗加重: 红底红边 + 晃动(弹出动画结束后接一段抖动) */
  const 错误样式 = 错误整块换色
    ? `background:${取色('errorBg')};border:1px solid ${取色('errorBorder')};color:${取色('errorText')};` +
      'box-shadow:0 8px 28px rgba(224,87,74,.3);' +
      `animation:${错误动画};`
    : `animation:${错误动画};`;

  const 类型样式: Record<ToastType, string> = {
    success: `border-left:${边线宽}px solid ${严重度色.success};`,
    info: `border-left:${边线宽}px solid ${严重度色.info};`,
    warning: `border-left:${边线宽}px solid ${严重度色.warning};`,
    error: 错误样式 + `border-left:${边线宽}px solid ${严重度色.error};`,
  };

  const 关键帧 = [
    `@keyframes ${前缀}ToastIn{from{opacity:0;transform:translateX(12px) scale(.92)}to{opacity:1;transform:none}}`,
    `@keyframes ${前缀}ToastOut{to{opacity:0;transform:translateX(12px) scale(.96)}}`,
    `@keyframes ${前缀}ToastShake{0%,100%{transform:none}20%{transform:translateX(-6px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}`,
    `@media (prefers-reduced-motion: reduce){#${堆栈ID} > *{animation-duration:.01ms !important;}}`,
  ].join('');

  function 确保样式(doc: Document) {
    if (doc.getElementById(样式ID)) return;
    const style = doc.createElement('style');
    style.id = 样式ID;
    style.textContent = 关键帧;
    doc.head.appendChild(style);
  }

  /** 弹窗容器(两个 iframe 上下文按 id 共享同一个), 贴着球定位, 内部纵向堆叠 */
  function 确保堆栈(doc: Document): HTMLElement {
    let stack = doc.getElementById(堆栈ID);
    if (!stack) {
      stack = doc.createElement('div');
      stack.id = 堆栈ID;
      stack.style.cssText =
        'position:fixed;left:0;top:0;display:flex;flex-direction:column;gap:8px;align-items:flex-end;' +
        `z-index:${堆栈层序};pointer-events:none;max-width:min(380px,70vw);`;
      doc.body.appendChild(stack);
    }
    绑父窗口resize(doc);
    // 这个 dataset 标记**只是镜像**(给现有断言与人工排查看), 去重判据是上面的 已绑窗口。
    // 它挂在 stack 元素上, 而 stack 会被卸载方整块删掉 —— 所以绝不能拿它当去重依据(那正是 B33)。
    if (已绑窗口) stack.dataset.resizeBound = '1';
    return stack;
  }

  /** B33: 父窗口 resize 只绑一次, 且**绑在记住的那个窗口上**。
   *  原来靠 `stack.dataset.resizeBound` 去重 —— 但 stack 元素会被卸载方整块删掉
   *  (悬浮球界面.ts 的 pagehide 删 `<前缀>-toast-stack`), 标记随之消失, 下次再弹就**又绑一条**,
   *  于是每重载一次多一个匿名监听(旧的还活着, 指向已删的 stack)。
   *  现在用闭包变量记住"绑过哪个窗口 + 哪个函数", 同一窗口不重复绑, 换窗口先摘旧的。
   *  行为不变: 仍然只做 重定位(doc), 仍在父窗口上, 仍然不碰任何提示条语义。 */
  let 已绑窗口: Window | null = null;
  const 已绑处理函数 = () => {
    const 窗口 = 已绑窗口;
    const 文档 = 窗口?.document;
    if (文档) 重定位(文档);
  };
  function 绑父窗口resize(doc: Document) {
    const win = doc.defaultView;
    if (!win) return;
    if (已绑窗口 === win) return; // 同一窗口只绑一次
    if (已绑窗口) 已绑窗口.removeEventListener('resize', 已绑处理函数);
    已绑窗口 = win;
    win.addEventListener('resize', 已绑处理函数);
  }

  /** 读取球心(由悬浮球界面写入锚点元素); 缺省回退到兜底位置 */
  function 读锚点(doc: Document): { x: number; y: number } {
    const marker = doc.getElementById(锚点ID);
    if (marker) {
      const x = Number(marker.getAttribute('data-x'));
      const y = Number(marker.getAttribute('data-y'));
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }
    const win = doc.defaultView;
    return 兜底锚点(win?.innerWidth ?? 1080, win?.innerHeight ?? 720);
  }

  /** 容器整体贴球定位: 左侧优先, 空间不足弹到右方; 垂直居中对齐球, 越界时收进视口 */
  function 重定位(doc: Document) {
    const stack = doc.getElementById(堆栈ID);
    const win = doc.defaultView;
    if (!stack || stack.children.length === 0 || !win) return;
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const { x, y } = 读锚点(doc);
    const w = stack.offsetWidth;
    const h = stack.offsetHeight;
    const 球左 = x - 球半径;
    const 球右 = x + 球半径;
    let left = 球左 - 10 - w;
    if (left < 8) left = 球右 + 10;
    left = Math.min(Math.max(left, 8), Math.max(8, vw - w - 8));
    const top = Math.min(Math.max(y - h / 2, 8), Math.max(8, vh - h - 8));
    stack.style.left = `${Math.round(left)}px`;
    stack.style.top = `${Math.round(top)}px`;
  }

  /** 严重度标记: 错误用红底叹号, 其余用同色圆点(外观关掉大标记时四档同形, 只有颜色不同) */
  function 造标记(doc: Document, type: ToastType): HTMLElement {
    const mark = doc.createElement('span');
    if (type === 'error' && 错误大标记) {
      mark.style.cssText =
        `width:16px;height:16px;border-radius:50%;background:${取色('errorBorder')};color:#fff;flex:none;margin-top:2px;` +
        'font:bold 11px/16px "Segoe UI","Microsoft YaHei",sans-serif;text-align:center;';
      mark.textContent = '!';
    } else {
      mark.style.cssText = `width:7px;height:7px;border-radius:50%;background:${严重度色[type]};flex:none;margin-top:7px;`;
    }
    return mark;
  }

  /** 撤掉屏幕上现有的所有条(不留退场动画: 面板要开了, 越干脆越好) */
  function 撤掉屏幕上的条() {
    const doc = 取父文档();
    const stack = doc?.getElementById(`${前缀}-toast-stack`);
    if (!stack) return;
    for (const el of [...stack.children] as HTMLElement[]) el.remove();
  }

  function 退场(el: HTMLElement, timer: ReturnType<typeof setTimeout>) {    if (el.dataset.dismissed) return;
    el.dataset.dismissed = '1';
    clearTimeout(timer);
    const doc = el.ownerDocument;
    el.style.animation = 退场动画;
    setTimeout(() => {
      el.remove();
      重定位(doc);
    }, 210);
  }

  function showToast(type: ToastType, message: string, title?: string): void {
    if (放行 && !放行(type)) return; // 闸门(剧情导演的四档)就设在这个出口, 调用点不必各自判断
    // 自己的面板开着: 压住而不是丢掉 —— 关面板时 setToastSuppressed(false) 按顺序补发。
    // 注意: **只看自己那一家**。别人的面板开着不关我们的事(三家是独立脚本, 各有各的提示条)。
    if (抑制) {
      暂存.push({ type, message, title });
      if (暂存.length > 暂存上限) 暂存.shift();
      return;
    }
    const doc = 取父文档();
    if (!doc) return;
    确保样式(doc);
    const stack = 确保堆栈(doc);
    const el = doc.createElement('div');
    el.style.cssText = 基础样式 + 类型样式[type];
    el.append(造标记(doc, type));
    const body = doc.createElement('span');
    if (title) {
      const label = doc.createElement('b');
      label.style.cssText = 'font-weight:600;margin-right:6px;';
      label.textContent = title;
      body.append(label);
    }
    body.append(doc.createTextNode(message));
    el.append(body);
    el.addEventListener('click', () => 退场(el, timer));
    stack.appendChild(el);
    const timer = setTimeout(() => 退场(el, timer), 停留时长[type]);
    重定位(doc);
  }

  /** 悬浮球界面把面板主题色写给弹窗容器(两个 iframe 上下文经 DOM 共享), 浅色/深色跟随面板 */
  function setToastColors(colors: 提示条配色): void {
    const doc = 取父文档();
    if (!doc) return;
    const stack = 确保堆栈(doc);
    for (const [键, 变量] of Object.entries(配色变量) as [配色键, string][]) {
      const value = colors[键];
      if (value) stack.style.setProperty(变量, value);
    }
  }

  /** 悬浮球界面在球移动/初始化时调用, 让弹窗跟随球的位置 */  function setToastAnchor(x: number, y: number): void {
    const doc = 取父文档();
    if (!doc) return;
    let marker = doc.getElementById(锚点ID);
    if (!marker) {
      marker = doc.createElement('div');
      marker.id = 锚点ID;
      marker.style.cssText = 'display:none;';
      doc.body.appendChild(marker);
    }
    marker.setAttribute('data-x', String(Math.round(x)));
    marker.setAttribute('data-y', String(Math.round(y)));
    重定位(doc);
  }

  /**
   * 面板开合闸门: 开着 → 攒着; 关掉 → 按原顺序补发(补发时仍过一遍档位闸门,
   * 因为这段时间里用户可能把提示条调成「关闭」了)。
   */
  function setToastSuppressed(suppressed: boolean): void {
    const 之前 = 抑制;
    抑制 = !!suppressed;
    if (抑制) {
      // 面板刚打开: 屏幕上还挂着的条**立刻撤掉** —— 它贴在球边, 而球就在面板旁边,
      // 不撤的话就是"面板开着、左边还挂一条"(用户 2026-11-07 报告的就是这一种)。
      撤掉屏幕上的条();
      return;
    }
    if (!之前) return;
    const 待发 = 暂存.splice(0, 暂存.length);
    for (const 条 of 待发) showToast(条.type, 条.message, 条.title);
  }

  return {
    showToast,
    toastSuccess: (message, title) => showToast('success', message, title),
    toastInfo: (message, title) => showToast('info', message, title),
    toastWarning: (message, title) => showToast('warning', message, title),
    toastError: (message, title) => showToast('error', message, title),
    setToastColors,
    setToastAnchor,
    setToastSuppressed,
  };
}
