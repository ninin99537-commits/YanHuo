// 共用 · 界面偏好: 悬浮球位置 / 面板位置 / 主题
//
// 为什么单独一个 module: 这套读写纪律(P1 事故后立的)是
//   ① 全局变量优先、localStorage 兜底(页面刷新时全局变量可能还没从服务器加载完);
//   ② 写回**只写相对基线改动过的字段**(`insertOrAssign` 是整键替换, 直接写会冲掉别的窗口刚改的字段);
//   ③ 从没成功读到过(基线为空)就**不写全局**(否则会拿内存里的默认值覆盖掉用户的真实坐标)。
// 它原先长在 剧情导演/面板机制.ts 的闭包里, 与 iframe 几何/拖动/阴影混在一个 589 行的 composable,
// 没有 DOM 就测不到 —— 而这三条恰恰都是"没有安全网就会静默覆盖用户数据"的那种。
//
// 烟火 那一份是同一套东西的**退化版**(整键 insertOrAssign): 于是两个窗口同时开着时,
// 谁的偏好后落盘就把另一边的字段一起冲掉。收进 共用 之后两个插件只有这一份实现,
// 这类分叉不可能再发生第二次(两个插件的 面板机制 已合并为 共用/面板机制.ts)。
//
// 主题类型在这里只取字面量联合: 两个插件的 主题.ts 各有自己的 主题模式/配色表,
// 但"存进偏好里的主题"永远是 'dark' | 'light' 这两个字面量, 不需要共用去认识它们的 token 表。
import { klona } from 'klona';

/** 偏好里记的主题: 与两个插件的 主题模式 同构, 但共用不依赖任何一方的 主题.ts */
export type 偏好主题 = 'dark' | 'light';

/** 界面偏好的形状(存在全局变量与 localStorage 里的就是它) */
export interface 界面偏好 {
  x: number;
  y: number;
  主题: 偏好主题;
  面板x?: number | null;
  面板y?: number | null;
}

/**
 * 存储接缝: 生产实现是"全局变量 + localStorage 双写", 用例里是一份内存表。
 * 读全局返回 unknown —— 存储里那份可能是旧版本或被手改过的脏数据, 由本 module 判定。
 */
export interface 偏好存储 {
  读全局(): unknown;
  写全局(值: 界面偏好): void;
  读本地(): string | null;
  写本地(文本: string): void;
}

export interface 偏好会话 {
  读(): 界面偏好 | null;
  写(偏好: 界面偏好): void;
}

/** 认得出是偏好: 至少 x 是个数字(与旧实现的判据一致, 其余字段按缺省处理) */
function 像偏好(值: unknown): 值 is 界面偏好 {
  return !!值 && typeof 值 === 'object' && !Array.isArray(值) && typeof (值 as 界面偏好).x === 'number';
}

export function 建偏好会话(存储: 偏好存储): 偏好会话 {
  /** 最近一次成功读到的偏好(写回基线): 只写**改动过的字段**, 防陈旧副本把别人改的字段冲掉 */
  let 基线: 界面偏好 | null = null;

  function 读(): 界面偏好 | null {
    try {
      const 全局 = 存储.读全局();
      if (像偏好(全局)) {
        基线 = klona(全局);
        return 全局;
      }
    } catch {
      // 读失败退回本地, 不把失败当"没有值"
    }
    try {
      const 文本 = 存储.读本地();
      if (文本) {
        const 本地 = JSON.parse(文本);
        if (像偏好(本地)) {
          if (!基线) 基线 = klona(本地);
          return 本地;
        }
      }
    } catch {
      // 本地缓存损坏 → 当没读过(不写全局)
    }
    return null;
  }

  function 写(偏好: 界面偏好): void {
    try {
      // 基线为空 = 从没成功读到过 → 绝不写全局(否则默认值会盖掉用户的真实坐标)
      if (基线) {
        const 变化: Record<string, any> = {};
        let 有变化 = false;
        for (const [键, 值] of Object.entries(偏好)) {
          if ((基线 as Record<string, any>)[键] !== 值) {
            变化[键] = 值;
            有变化 = true;
          }
        }
        if (有变化) {
          // 合并进**存储里当前那份**, 而不是拿内存里的整份覆盖: 别的窗口可能刚改过别的字段
          const 存储里那份 = 存储.读全局();
          const 是对象 = !!存储里那份 && typeof 存储里那份 === 'object' && !Array.isArray(存储里那份);
          // 显式标成 界面偏好: 两个分支的形状本来就都是"一份偏好", 只是存储里那份的类型是 unknown,
          // 展开后 TS 只能推出索引签名(缺 x/y/主题 这三个必填字段), 于是传给 写全局 时报 TS2345。
          // 这里不改变值 —— 有旧值就以旧值为底叠上改动, 没有就用内存里的整份。
          const 合并: 界面偏好 = 是对象
            ? { ...klona(存储里那份) as 界面偏好, ...变化 }
            : { ...klona(偏好) };
          存储.写全局(合并);
          基线 = { ...(基线 as Record<string, any>), ...变化 } as 界面偏好;
        }
      }
    } catch {
      // 忽略: 偏好存不住只是下次位置回到默认, 不该打断使用
    }
    try {
      // 本地永远写(它是本机自己的缓存, 不涉及跨窗口覆盖)
      存储.写本地(JSON.stringify(偏好));
    } catch {
      // 忽略
    }
  }

  return { 读, 写 };
}
