// 共用 · 收纳坞 —— 球被收纳条收走后, 弹窗应该贴哪
// ---------------------------------------------------------------------------
// 现象: 「悬浮球收纳」这类坞把每个球收进自己的条里, 并在条上给每个球生成一个**代理图标**
// (.fd-entry) —— 但它**不搬走球 iframe 本体**: 球还停在插件自己摆的位置上。
// 于是弹窗贴着球 iframe, 就落在"球原来的位置", 和用户看到的收纳条对不上。
//
// 坞把来源记在 __floatingDockNative.items 里, docKey === "iframe:<script_id>", 正好是球 iframe
// 的 script_id —— 这是插件认领自己那个图标的**唯一稳定关联**:
//   · label 是插件自己的动态文案(导演那条会随轮次变), 不能当键;
//   · 图标顺序会因拖动重排, 不能当键。
// 认领到就贴图标, **半径也随图标走**(图标 28×28 比球 40×40 小, 贴球间距自然跟着缩)。
//
// 认不到(没装坞 / 没被收纳 / 坞折叠 / 结构变了)一律回 null, 调用方退回贴球本体 ——
// 这个模块**不改变"没收纳时"的行为**。
// ---------------------------------------------------------------------------

/** 坞清单里的一项(只声明我们用到的字段) */
export interface 收纳坞项 {
  docKey?: string;
  label?: string;
}

/** 坞清单可能是数组, 也可能是以 id 为键的对象; 统一成数组 */
export function 规整坞清单(清单: unknown): 收纳坞项[] {
  if (Array.isArray(清单)) return 清单 as 收纳坞项[];
  if (清单 && typeof 清单 === 'object') return Object.values(清单 as Record<string, 收纳坞项>);
  return [];
}

/** 从坞清单里认领属于某个球 iframe 的那一项(附序号, 供 label 认不到时按渲染顺序兜底) */
export function 匹配坞项(清单: unknown, 球id: string | null | undefined): { 项: 收纳坞项; 序号: number } | null {
  if (!球id) return null;
  const 目标 = `iframe:${球id}`;
  const 列 = 规整坞清单(清单);
  for (let i = 0; i < 列.length; i++) {
    if (列[i]?.docKey === 目标) return { 项: 列[i], 序号: i };
  }
  return null;
}

/** 坞容器 id 与图标选择器 —— 只认这一家(认不到就退回贴球, 不猜) */
const 坞容器ID = 'floating-dock-native';
const 坞图标选择器 = '.fd-entry';
/** 坞折叠后露出的把手(展开时它是 0×0) */
const 坞把手选择器 = '.fd-peek';
/** 坞在它自己藏起来的节点上打的标记 —— 也可用它直接判断"我是不是被收纳了" */
export const 坞隐藏标记 = 'data-floating-dock-hidden';

/** 取收纳坞容器(没装坞 → null) */
export function 取收纳坞(父文档: Document | null | undefined): HTMLElement | null {
  return (父文档?.getElementById(坞容器ID) as HTMLElement | null) ?? null;
}

function 有尺寸(el: Element | null | undefined): el is HTMLElement {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

/**
 * 取"收纳坞里属于这个球 iframe 的代理图标"; 没收纳 / 没装坞 / 认不出来 → null。
 * 父文档与球 iframe 由调用方传入 —— 本模块不碰全局, 也便于单测注入。
 */
export function 取收纳坞入口(
  父文档: Document | null | undefined,
  球: HTMLIFrameElement | null | undefined,
): HTMLElement | null {
  if (!父文档 || !球) return null;
  const 坞 = 取收纳坞(父文档);
  if (!坞) return null;
  const 球id = 球.getAttribute('script_id');
  const 清单 = (父文档.defaultView as unknown as { __floatingDockNative?: { items?: unknown } } | null)
    ?.__floatingDockNative?.items;
  const 命中 = 匹配坞项(清单, 球id);
  if (!命中) return null;
  const 图标列 = Array.from(坞.querySelectorAll(坞图标选择器));
  const 目标 = `iframe:${球id}`;
  // 认领顺序: ①坞把 docKey 写在图标上(坞侧加一行 item.entry.dataset.fdDocKey = docKey 即可) → 精确;
  //           ②按 label(图标的 title/aria-label 就是坞项的 label); ③按序号(清单顺序 = 渲染顺序)
  const 精确 = 图标列.find(el => el.getAttribute('data-fd-doc-key') === 目标);
  const 按label = 命中.项.label
    ? 图标列.find(el => el.getAttribute('title') === 命中.项.label || el.getAttribute('aria-label') === 命中.项.label)
    : undefined;
  const 图标 = 精确 ?? 按label ?? 图标列[命中.序号];
  if (有尺寸(图标)) return 图标;
  // 坞折叠时图标全藏起来, 只剩把手: 贴把手(收纳点还在那儿)
  const 把手 = 坞.querySelector(坞把手选择器);
  return 有尺寸(把手) ? 把手 : null;
}
