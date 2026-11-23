// 共用 · 收纳坞 —— 球被收纳条收走后, 弹窗应该贴哪
// ---------------------------------------------------------------------------
// 现象: 「悬浮球收纳」这类坞把每个球收进自己的条里, 并在条上给每个球生成一个**代理图标**,
// 但它**不搬走球 iframe 本体**: 球还停在插件自己摆的位置上。于是弹窗贴着球 iframe, 就落在
// "球原来的位置", 和用户看到的收纳条对不上。
//
// 分工: **坞负责说"你的贴靠点在哪", 插件只负责消费**。
// 坞的 DOM 结构(容器 id / 图标 class / 把手 class / items 结构)是坞的私事, 插件一律不猜 ——
// 坞在自己的脚本里把接口挂在父窗口上:
//
//   window.__floatingDockNative.api = {
//     version,                          // 接口版本(坞自己用)
//     root,                             // 坞的容器 —— 插件挂 MutationObserver 盯拖动/折叠/释放
//     entryFor(键) → HTMLElement | null // 贴靠点; 折叠时交把手; 认不到回 null
//   }
//
// 键 = "iframe:<球 iframe 的 script_id>" —— 坞内部的索引键, 也是插件与图标之间唯一稳定的
// 关联: 图标的 label 会随轮次变, 顺序会因拖动重排, 都不能当键。
//
// 认不到(没装坞 / 坞没暴露 api / 没收纳 / 折叠时连把手都量不到)一律回 null,
// 调用方退回贴球本体 —— 这个模块**不改变"没收纳时"的行为**。
//
// 为什么不让坞反过来搬球 iframe: iframe 是本插件自己建的, 位置/尺寸由本插件按"球∪面板"
// 联合矩形自己算(见各插件 面板机制 applyFrame), 坞再搬一次就是两套布局打架。
// 所以搬 iframe 的活儿归插件, 坞只交出"图标在哪"。
// ---------------------------------------------------------------------------

/** 坞挂在父窗口上的接口 —— 本模块只认这个契约, 不认坞的 DOM */
interface 收纳坞接口 {
  version?: number;
  root?: HTMLElement | null;
  entryFor(键: string): HTMLElement | null;
}

/** 取坞暴露的接口; 没装坞 / 坞没暴露 → null */
function 取收纳坞接口(父文档: Document | null | undefined): 收纳坞接口 | null {
  const 全局 = (父文档?.defaultView ?? null) as unknown as { __floatingDockNative?: { api?: 收纳坞接口 } } | null;
  const 接口 = 全局?.__floatingDockNative?.api;
  return 接口 && typeof 接口.entryFor === 'function' ? 接口 : null;
}

/** 本球 iframe 在坞里的键 —— 坞内部的索引键, 也是插件认领自己贴靠点的唯一稳定关联 */
export function 球坞键(球: HTMLIFrameElement | null | undefined): string | null {
  const 球id = 球?.getAttribute('script_id');
  return 球id ? `iframe:${球id}` : null;
}

/** 取收纳坞容器(没装坞 / 坞没暴露 → null); 调用方用它挂 MutationObserver 盯拖动/折叠/释放 */
export function 取收纳坞(父文档: Document | null | undefined): HTMLElement | null {
  return 取收纳坞接口(父文档)?.root ?? null;
}

/**
 * 取"收纳坞里属于这个球 iframe 的贴靠点元素"; 没收纳 / 没装坞 / 认不出来 → null。
 * 折叠时坞只露把手, 坞会把把手交出来 —— 收纳点还在那儿。
 * 父文档与球 iframe 由调用方传入 —— 本模块不碰全局, 也便于单测注入。
 */
export function 取收纳坞入口(
  父文档: Document | null | undefined,
  球: HTMLIFrameElement | null | undefined,
): HTMLElement | null {
  const 键 = 球坞键(球);
  if (!键) return null;
  return 取收纳坞接口(父文档)?.entryFor(键) ?? null;
}
