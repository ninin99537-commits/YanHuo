// 烟火 · 悬浮球旁弹窗: 贴球出现, 错误加重。
//
// 渲染机制(DOM 结构 / 堆叠 / 贴球定位 / 计时退场 / 面板开着时压住)与彼方、剧情导演同源, 在 共用/提示条.ts;
// 本文件只剩烟火自己的几件事: 主题.ts 给的配色变量名与兜底色、球半径与兜底位置、外观、四个出口的名字。
//
// v2.9.7 起外观跟面板「简报」走: 兜底色 = 主题.ts 的深色那一套(以前是另抄的一批字面量), 左边色带只用两种颜色
// —— 成功 = 强调色(钴蓝)、错误 = 红; 普通消息是描边灰, 警告是正文色(中性但更重)。错误仍整块换成红底,
// 但不再晃动、也不用大叹号: 四档同一颗小圆点, 只靠颜色和底色区分(安静是常态, 错误要醒目而不是吓人)。
//
// 跨 document: 提示条画在酒馆父页面上, 元素按 `yh-` 前缀取名, 与彼方的 `bf-` 互不冲突。
import { 建提示条 } from '../共用/提示条';
import type { ToastType, 提示条配色 } from '../共用/提示条';
import { 层序, 弹窗兜底配色, 弹窗变量, 悬浮球直径, 深色 } from './主题';

export type { ToastType };

/** 面板配色(可选给, 没给的项用兜底色) */
export type ToastColors = 提示条配色;

/** 面板配色还没送到弹窗时的兜底 = 深色主题(与面板、推进弹条同源) */
const 兜底色 = 弹窗兜底配色;

/** 一个配色键的 CSS 表达式: var(变量名, 兜底色) —— 色带跟着面板主题走, 白天也对 */
const 色 = (键: keyof typeof 弹窗变量) => `var(${弹窗变量[键]},${兜底色[键]})`;

const 提示条 = 建提示条({
  前缀: 'yh',
  配色变量: 弹窗变量,
  配色兜底: 兜底色,
  严重度色: {
    success: 色('accent'),
    info: 色('border'),
    warning: 色('text'),
    error: 色('errorBorder'),
  },
  // 锚点 x,y 是球心: 贴球定位按直径的一半让开(球心 → 球边)
  球半径: 悬浮球直径 / 2,
  // 兜底位置 = 面板机制给球定的默认落点(右下角)
  兜底锚点: (视口宽, 视口高) => ({ x: 视口宽 - 60, y: 视口高 - 130 }),
  堆栈层序: 层序.提示条堆栈,
  外观: {
    圆角: 11,
    阴影: '0 12px 30px rgba(0,0,0,.28)',
    边线宽: 3,
    内边距: '10px 14px 10px 12px',
    字体: 深色.sans,
    错误整块换色: true,
    错误大标记: false,
    入场动画: 'yhToastIn .22s ease-out',
    错误动画: 'yhToastIn .22s ease-out',
  },
});

export const showToast = 提示条.showToast;
export const toastSuccess = 提示条.toastSuccess;
export const toastInfo = 提示条.toastInfo;
export const toastWarning = 提示条.toastWarning;
export const toastError = 提示条.toastError;
export const setToastColors = 提示条.setToastColors;
export const setToastAnchor = 提示条.setToastAnchor;
export const setToastSuppressed = 提示条.setToastSuppressed;
