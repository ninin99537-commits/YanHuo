// 烟火 · 配色 / 几何 / 层序的唯一来源(候选 9)。
//
// 以前这三样各在手抄: 球直径 40 写三处(视图里的 const、.yh-orb 的 CSS、外层 iframe 的尺寸),
// z-index 层序写四处(酒馆页面上的阴影层/弹条、iframe 内面板根、外层 iframe), 面板配色更多——
// 样式表里一套、同步给贴球弹窗的 JS 里又手抄一套回退色、更新弹条的内联样式里第三套。
// 漏一处的后果都只在真机上看得见: 改了球直径而弹条还按旧半径贴球、或者面板换了白天而弹窗还是深色。
//
// 现在值只写在这个文件里:
//   - 面板的 CSS 变量由 取根变量() 生成, 视图把它绑在 .yh-root 的内联样式上(全项目唯一的映射点);
//   - 跨 document 的弹窗/弹条配色由 取弹窗配色() 生成, 键 → CSS 变量名见 弹窗变量;
//   - 球直径由 悬浮球直径 一处给出, 样式表里的球宽高读 --yh-orb-size;
//   - z-index 由 层序 一处给出, 样式表里读 --yh-z-*。
// 样式表写不出 import, 所以它只写 var(...); 值对不上就会被 tests/yanhuo-theme.test.ts 当场抓住。
export type 主题模式 = 'dark' | 'light';

/**
 * 悬浮球直径(px)。球的宽高(--yh-orb-size)、锚点偏移(±直径/2)、外层 iframe 的尺寸、
 * 弹条贴球定位都该用这一个数。
 * 注意: .yh-orb 的 CSS 宽高写不出变量引用前的那个数字, 那份靠用例断言与这里一致。
 */
export const 悬浮球直径 = 40;

/**
 * z-index 层序(值直接进样式; 同值的两个不会互相压, 因为分处两个 document/层叠上下文)。
 *   - 面板阴影 / 提示条堆栈 / 更新弹条: 酒馆页面上的三个浮层, 依次抬高;
 *   - 球 iframe 与面板根: 同值, 面板在 iframe 内;
 *   - 球 / 面板: iframe 内那两个, 由 CSS 变量传下去。
 */
export const 层序 = {
  /** 酒馆页面上与面板同位的纯阴影层(iframe 内的阴影会被 clip-path 裁出硬边) */
  面板阴影: 2147482997,
  /** 贴球弹窗容器(toast.ts 里的弹窗堆栈, 本次未改那个文件) */
  提示条堆栈: 2147482998,
  /** 推进中弹条 */
  更新弹条: 2147482999,
  /** 悬浮球所在的 iframe(悬浮球界面.ts) */
  球iframe: 2147483000,
  /** 面板根 .yh-root(iframe 内) */
  面板根: 2147483000,
  /** iframe 内: 球浮在面板之上 */
  球: 4,
  /** iframe 内: 面板 */
  面板: 3,
} as const;

/** 只给样式表用的三个层序: 键 → CSS 变量名(其余三个由 JS 直接取值用) */
export const 层序变量: Record<'面板根' | '球' | '面板', string> = {
  面板根: '--yh-z-root',
  球: '--yh-z-orb',
  面板: '--yh-z-panel',
};

/** 面板 token: 键 → 值; CSS 变量名 = `--yh-` + 驼峰转短横线(accentSoft → --yh-accent-soft)
 *
 *  v2.9.7「简报」配色: 石墨底 + 钴蓝(accent, 唯一的强调色) + 红(seal, 只给重大事件、错误、危险操作), 其余全是中性灰。
 *  字体也在这里(sans / mono): 面板、提示条、推进弹条三处同一套, 不再各写一串 font-family。 */
export const 深色 = {
  accent: '#f08a4b',
  accentBright: '#f7a26b',
  accentSoft: 'rgba(240, 138, 75, 0.14)',
  accentLine: 'rgba(240, 138, 75, 0.42)',
  onAccent: '#1d0e05',
  seal: '#e85d56',
  sealSoft: 'rgba(232, 93, 86, 0.14)',
  sealLine: 'rgba(232, 93, 86, 0.38)',
  jade: '#5fb89c',
  jadeSoft: 'rgba(95, 184, 156, 0.14)',
  ink: '#f0ece4',
  inkDim: '#aba79f',
  inkFaint: '#706d68',
  bg: '#0f1116',
  panel: '#14171e',
  panelTop: '#181b23',
  raise: '#1b1f28',
  hover: '#232833',
  field: '#0e1015',
  line: 'rgba(240, 232, 218, 0.085)',
  lineStrong: 'rgba(240, 232, 218, 0.16)',
  innerGlow: 'rgba(255, 244, 228, 0.06)',
  knob: '#fffaf4',
  shadow:
    '0 28px 72px rgba(0, 0, 0, 0.62), 0 6px 20px rgba(0, 0, 0, 0.38), 0 0 0 1px rgba(255, 240, 220, 0.06)',
  orbBg: 'radial-gradient(circle at 32% 28%, #242834, #14171f 78%)',
  orbShadow: 'inset 0 1px 0 rgba(255, 244, 228, 0.14)',
  serif: "'Source Han Serif SC', 'Noto Serif SC', 'STZhongsong', 'Songti SC', Georgia, serif",
  sans: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', 'Noto Sans SC', system-ui, -apple-system, sans-serif",
  mono: "ui-monospace, 'Cascadia Mono', 'JetBrains Mono', 'SF Mono', Consolas, monospace",
};
export type 主题Token = keyof typeof 深色;

/** 白天模式: 键必须和 深色 完全一致(这里的类型会强制, 少一个就编译不过) */
export const 白天: Record<主题Token, string> = {
  accent: '#c85a26',
  accentBright: '#b44c1c',
  accentSoft: 'rgba(200, 90, 38, 0.11)',
  accentLine: 'rgba(200, 90, 38, 0.38)',
  onAccent: '#fffaf5',
  seal: '#c93b34',
  sealSoft: 'rgba(201, 59, 52, 0.1)',
  sealLine: 'rgba(201, 59, 52, 0.35)',
  jade: '#287a64',
  jadeSoft: 'rgba(40, 122, 100, 0.11)',
  ink: '#1f1c18',
  inkDim: '#5c564e',
  inkFaint: '#8f887e',
  bg: '#f3f0e9',
  panel: '#fbfaf6',
  panelTop: '#f6f3ec',
  raise: '#f2eee6',
  hover: '#eae4d9',
  field: '#ffffff',
  line: 'rgba(36, 30, 22, 0.09)',
  lineStrong: 'rgba(36, 30, 22, 0.17)',
  innerGlow: 'rgba(255, 255, 255, 0.85)',
  knob: '#ffffff',
  shadow:
    '0 24px 64px rgba(32, 24, 14, 0.16), 0 4px 16px rgba(32, 24, 14, 0.08), 0 0 0 1px rgba(36, 30, 22, 0.06)',
  orbBg: 'radial-gradient(circle at 32% 28%, #ffffff, #f2ede4 80%)',
  orbShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.9)',
  serif: 深色.serif,
  sans: 深色.sans,
  mono: 深色.mono,
};

export const 主题表: Record<主题模式, Record<主题Token, string>> = { dark: 深色, light: 白天 };

/** 贴球弹窗 / 更新弹条的配色: 传给另一个 document 的 7 个值 */
export interface 弹窗配色 {
  bg: string;
  border: string;
  text: string;
  accent: string;
  errorBg: string;
  errorBorder: string;
  errorText: string;
}

/** 弹窗配色的键 → 传过去用的 CSS 变量名(设在容器上, 弹窗自己的样式里读) */
export const 弹窗变量: Record<keyof 弹窗配色, string> = {
  bg: '--yh-toast-bg',
  border: '--yh-toast-border',
  text: '--yh-toast-text',
  accent: '--yh-toast-accent',
  errorBg: '--yh-toast-error-bg',
  errorBorder: '--yh-toast-error-border',
  errorText: '--yh-toast-error-text',
};

/** 只有弹窗需要的两个底色(面板里用不到, 所以不进 token 表) */
const 弹窗专有: Record<主题模式, { errorBg: string; errorText: string }> = {
  dark: { errorBg: '#2a1413', errorText: '#ffe3de' },
  light: { errorBg: '#fbe9e7', errorText: '#8c3125' },
};

/** 按当前主题给出弹窗配色: 5 个取自面板 token, 2 个是弹窗专有底色 */
export function 取弹窗配色(mode: 主题模式): 弹窗配色 {
  const token = 主题表[mode] ?? 深色;
  const 专有 = 弹窗专有[mode] ?? 弹窗专有.dark;
  return {
    bg: token.panel,
    border: token.lineStrong,
    text: token.ink,
    // v2.9.7: 弹窗/弹条的强调色跟面板一样是钴蓝(以前取朱砂); 错误仍是红(errorBorder = seal)
    accent: token.accent,
    errorBg: 专有.errorBg,
    errorBorder: token.seal,
    errorText: 专有.errorText,
  };
}

/** 弹条自己那份内联样式里的兜底(深色主题): 面板配色还没送到时的第一帧, 别在这儿再手抄一串颜色 */
export const 弹窗兜底配色 = 取弹窗配色('dark');

/** token 名(驼峰) → CSS 变量名 */
function 变量名(token: string): string {
  return `--yh-${token.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`;
}

/** 某个主题的全部配色 CSS 变量 */
export function 取主题变量(mode: 主题模式): Record<string, string> {
  const 结果: Record<string, string> = {};
  for (const [token, value] of Object.entries(主题表[mode]))
    结果[变量名(token)] = value;
  return 结果;
}

/**
 * 绑在 .yh-root 上的全部 CSS 变量 = 配色 + 球直径 + 层序。
 * 视图侧只绑这一处(悬浮球界面.vue 的 根样式), 样式表里一律 var(...) 引用:
 * 这就是"TS 的值 → CSS 的变量"之间唯一的那一个映射点。
 */
export function 取根变量(mode: 主题模式): Record<string, string> {
  return {
    ...取主题变量(mode),
    '--yh-orb-size': `${悬浮球直径}px`,
    [层序变量.面板根]: String(层序.面板根),
    [层序变量.球]: String(层序.球),
    [层序变量.面板]: String(层序.面板),
  };
}
