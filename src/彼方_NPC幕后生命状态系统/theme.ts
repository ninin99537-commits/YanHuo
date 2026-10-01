// 彼方面板配色的唯一来源。
//
// 深色 / 白天两套 token 的值只写在这个文件里:
//   - 面板的 CSS 自定义属性由 主题样式文本() 生成, 模块加载时注入当前文档;
//   - 跨 document 的弹窗(提示条)配色由 取弹窗配色() 生成, 按 弹窗变量 里的变量名设置到容器上。
// 以前这两边各写一份(CSS 里一套、toastVars 手抄一套、两边还各带一套回退色), 改一个颜色要记得改三处,
// 漏了就变成"弹窗和面板不是一个主题"。现在要加/改 token, 只动这里一处。
export type 主题模式 = 'dark' | 'light';

/**
 * 悬浮球直径(px)。球的宽高、锚点偏移(±直径/2)、提示条贴球定位都该用这一个数。
 * 以前 toast.ts 写 28、视图写 20——彼方自己的提示比自己的球宽 8px(2026-09 复核发现的缺陷)。
 * 注意: .bf-orb 的 CSS 宽高写不出变量引用, 那份仍靠 tests/theme.test.ts 断言与这里一致。
 */
export const 悬浮球直径 = 40;

/** 面板 token: 键 → 值; CSS 变量名 = `--bf-` + 驼峰转短横线(如 accentStrong → --bf-accent-strong) */
export const 深色 = {
  bg: '#0c1120',
  bg2: '#121a2e',
  card: '#172039',
  hover: '#1f2a4a',
  accent: '#f0b45a',
  accentStrong: '#c98a2e',
  accentSoft: 'rgba(240, 180, 90, 0.14)',
  accentText: '#f7cf8a',
  success: '#7fb08a',
  warning: '#d4a94e',
  danger: '#cc7a5e',
  text: '#e8edf5',
  dim: '#9aa8c0',
  faint: '#5c6a85',
  border: 'rgba(232, 237, 245, 0.1)',
  borderStrong: 'rgba(232, 237, 245, 0.2)',
  shadow: '0 24px 80px rgba(4, 8, 20, 0.75)',
  orbBg: 'rgba(18, 26, 46, 0.92)',
  orbRing: 'rgba(247, 207, 138, 0.32)',
  orbRingStrong: 'rgba(247, 207, 138, 0.55)',
  orbComp: 'rgba(240, 180, 90, 0.55)',
  code: '#0a0e1a',
  radiusSm: '8px',
  radius: '12px',
  radiusLg: '16px',
};
export type 主题Token = keyof typeof 深色;

/** 白天模式: 键必须和 深色 完全一致(这里的类型会强制, 少一个就编译不过) */
export const 白天: Record<主题Token, string> = {
  bg: '#f4f6fa',
  bg2: '#e9edf4',
  card: '#ffffff',
  hover: '#dfe5ee',
  accent: '#b0762a',
  accentStrong: '#92591a',
  accentSoft: 'rgba(176, 118, 42, 0.12)',
  accentText: '#8a5518',
  success: '#4d7a56',
  warning: '#9c7a1e',
  danger: '#b25f43',
  text: '#2b3340',
  dim: '#67738a',
  faint: '#a0abc0',
  border: 'rgba(43, 51, 64, 0.1)',
  borderStrong: 'rgba(43, 51, 64, 0.18)',
  shadow: '0 24px 80px rgba(43, 51, 64, 0.18)',
  orbBg: 'rgba(255, 255, 255, 0.94)',
  orbRing: 'rgba(146, 89, 26, 0.35)',
  orbRingStrong: 'rgba(146, 89, 26, 0.6)',
  orbComp: 'rgba(146, 89, 26, 0.5)',
  code: '#f8fafc',
  radiusSm: '8px',
  radius: '12px',
  radiusLg: '16px',
};

export const 主题表: Record<主题模式, Record<主题Token, string>> = { dark: 深色, light: 白天 };

/** 弹窗配色: 传给另一个 document 的 7 个值 */
export interface 弹窗配色 {
  bg: string;
  border: string;
  text: string;
  accent: string;
  errorBg: string;
  errorBorder: string;
  errorText: string;
}

/** 弹窗配色的键 → 传过去用的 CSS 变量名(设在弹窗容器上, 弹窗自己的样式里读) */
export const 弹窗变量: Record<keyof 弹窗配色, string> = {
  bg: '--bf-toast-bg',
  border: '--bf-toast-border',
  text: '--bf-toast-text',
  accent: '--bf-toast-accent',
  errorBg: '--bf-toast-error-bg',
  errorBorder: '--bf-toast-error-border',
  errorText: '--bf-toast-error-text',
};

/** 只有弹窗需要的两个底色(面板里用不到, 所以不进 token 表) */
const 弹窗专有: Record<主题模式, { errorBg: string; errorText: string }> = {
  dark: { errorBg: '#2a1715', errorText: '#ffe3de' },
  light: { errorBg: '#fdf0ec', errorText: '#7c3a28' },
};

/** 按当前主题给出弹窗配色: 5 个取自面板 token, 2 个是弹窗专有底色 */
export function 取弹窗配色(mode: 主题模式): 弹窗配色 {
  const token = 主题表[mode] ?? 深色;
  const 专有 = 弹窗专有[mode] ?? 弹窗专有.dark;
  return {
    bg: token.card,
    border: token.borderStrong,
    text: token.text,
    accent: token.accent,
    errorBg: 专有.errorBg,
    errorBorder: token.danger,
    errorText: 专有.errorText,
  };
}

/** 面板配色还没送到弹窗时的兜底(深色主题), 面板与弹窗两边都用它, 避免各写一串手抄颜色 */
export const 弹窗兜底配色 = 取弹窗配色('dark');

/** token 名(驼峰) → CSS 变量名 */
function 变量名(token: string): string {
  return `--bf-${token.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`;
}

/** 某个主题的全部 CSS 变量 */
export function 取主题变量(mode: 主题模式): Record<string, string> {
  const 结果: Record<string, string> = {};
  for (const [token, value] of Object.entries(主题表[mode]))
    结果[变量名(token)] = value;
  return 结果;
}

/** 生成主题 CSS 文本: 深色挂 .bf-root, 白天用 .bf-root[data-theme='light'] 覆盖 */
export function 主题样式文本(): string {
  const 一段 = (选择器: string, mode: 主题模式) => {
    const 声明 = Object.entries(取主题变量(mode)).map(([name, value]) => `  ${name}: ${value};`).join('\n');
    return `${选择器} {\n${声明}\n}`;
  };
  return `${一段('.bf-root', 'dark')}\n\n${一段(".bf-root[data-theme='light']", 'light')}\n`;
}

const 样式ID = 'bf-theme-vars';
/**
 * 把主题变量注入当前文档(模块加载时执行一次, 早于组件挂载)。
 * 脚本本身就跑在悬浮球那个 iframe 里, 所以这里的 document 就是面板所在的文档。
 * node 里(跑用例时)没有 document, 直接跳过。
 */
function 注入主题样式(): void {
  if (typeof document === 'undefined' || document.getElementById(样式ID))
    return;
  const style = document.createElement('style');
  style.id = 样式ID;
  style.textContent = 主题样式文本();
  (document.head ?? document.documentElement).appendChild(style);
}
注入主题样式();
