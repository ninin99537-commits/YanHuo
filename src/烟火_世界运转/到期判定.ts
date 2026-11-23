// 烟火 · 到期掷骰(v2.9.3, 设计稿模块 D 后半)
//
// 事件到了「下次判定时间」, 结果不再交给模型自己挑 —— 大模型天然偏向"无事"和"顺着剧情走"。
// 脚本在请求前用真随机掷出 推进 / 僵持 / 受挫, 模型只负责把这个结果写成这一步。
//
// 生命周期(都在 update.ts 里接线):
//   ① 请求前: 掷到期判定() —— 找出到期的事件; 基准快照里已有同一到期点的判定就沿用(不重掷), 否则新掷;
//   ② 这些事件强制进工作集, 请求里附只读的「到期判定」;
//   ③ 三次原样重试发的是同一份请求 → 结果天然一致;
//   ④ 提交时: 收尾到期判定() —— 模型展开了(演变最后一步变了 / 阶段变了 / 已结束)就清掉;
//      没展开就把判定写进事件, 下一轮沿用同一结果; 其余事件身上过期的判定一律清掉。
// 分支语义(2026-11-22 拍板): 判定只随提交的快照落盘。重 roll / 新 swipe 从上一层快照重新推进,
//   本轮新掷的会重掷; 上一层已落盘、还没展开的沿用。切回旧 swipe 恢复的是那一页快照里的。
import type { WorldData, WorldEvent, 到期判定, 判定结果 } from './schema';
import { 解析日期 } from './时间校验';

const 一日毫秒 = 86400000;

/** 三种结果的权重(百分比, 2026-11-22 拍板): 常规 40/35/25; 重大的事牵扯方多, 更容易卡住, 30/45/25 */
export const 判定权重: Readonly<Record<'常规' | '重大', Readonly<Record<判定结果, number>>>> = {
  常规: { 推进: 40, 僵持: 35, 受挫: 25 },
  重大: { 推进: 30, 僵持: 45, 受挫: 25 },
};

/** 浏览器真随机; 没有 crypto 时退回 Math.random(测试另行注入) */
export function 真随机(): number {
  const c = (globalThis as any).crypto;
  if (c?.getRandomValues) {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0] / 4294967296;
  }
  return Math.random();
}

export function 按权重取(权重: Readonly<Record<判定结果, number>>, r: number): 判定结果 {
  const 总 = 权重.推进 + 权重.僵持 + 权重.受挫;
  const 点 = Math.min(Math.max(r, 0), 0.999999) * 总;
  if (点 < 权重.推进) return '推进';
  if (点 < 权重.推进 + 权重.僵持) return '僵持';
  return '受挫';
}

function 事件键(e: WorldEvent): string {
  return e.id || e.标题;
}

/**
 * 请求前: 本轮到期的事件 → 判定。
 * 判定日 = 基准世界时间 + 本轮**至少**跨过的世界日(只掷"肯定已经到期"的, 不为可能的跨日提前掷)。
 * 基准世界时间或判定时间解析不了 → 不掷(不伪造日期)。
 */
export function 掷到期判定(data: Pick<WorldData, '事件' | '世界'>, 至少跨日: number, 随机: () => number = 真随机): Map<string, 到期判定> {
  const 结果 = new Map<string, 到期判定>();
  const 基准 = 解析日期(data.世界?.时间)?.天;
  if (基准 == null) return 结果;
  const 判定日 = 基准 + Math.max(0, 至少跨日) * 一日毫秒;
  for (const event of data.事件 ?? []) {
    const 到期 = String(event.下次判定时间 ?? '').trim();
    const 天 = 解析日期(到期)?.天;
    if (!到期 || 天 == null || 天 > 判定日) continue;
    if (event.判定 && event.判定.到期 === 到期) { 结果.set(事件键(event), event.判定); continue; }
    结果.set(事件键(event), { 到期, 结果: 按权重取(event.规模 === '重大' ? 判定权重.重大 : 判定权重.常规, 随机()) });
  }
  return 结果;
}

/** 请求体里只给模型一个结果词(不给"到期"那个脚本记账用的字段) */
export function 判定给模型(判定们: ReadonlyMap<string, 到期判定>): Record<string, 判定结果> {
  return Object.fromEntries([...判定们].map(([键, 判定]) => [键, 判定.结果]));
}

/**
 * 提交时收尾(纯函数, 返回新数据与备注; 不改入参):
 *   · 本轮判定的事件已结束, 或演变最后一步与基准不同, 或阶段变了 → 视为已展开, 清掉判定;
 *   · 还在进行中却没展开 → 把判定写进事件(下一轮沿用同一结果, 不重掷), 记一句备注;
 *   · 其余事件身上残留的判定(到期点已被改掉的)一律清掉。
 */
export function 收尾到期判定(基准: Pick<WorldData, '事件'>, 新: WorldData, 判定们: ReadonlyMap<string, 到期判定>): { 数据: WorldData; 备注: string[] } {
  const 备注: string[] = [];
  const 旧表 = new Map((基准.事件 ?? []).map(e => [事件键(e), e]));
  const 事件 = (新.事件 ?? []).map(event => {
    const 键 = 事件键(event);
    const 判定 = 判定们.get(键);
    const { 判定: _旧判定, ...干净 } = event;
    if (!判定) return 干净 as WorldEvent;
    const 旧 = 旧表.get(键);
    // "展开了" = 最后一步与基准不同(时间或变化), 或阶段变了。不比长度: 演变哪天加了条数上限,
    // 满额的事件再写一步长度不变, 比长度会让判定永远清不掉。
    const 末 = (e?: WorldEvent) => { const 步 = e?.演变?.at(-1); return 步 ? `${步.时间}\u0000${步.变化}` : ''; };
    const 展开了 = !!旧 && (末(event) !== 末(旧) || event.阶段 !== 旧.阶段);
    if (展开了) return 干净 as WorldEvent;
    备注.push(`到期判定「${event.标题}」→ ${判定.结果} 本轮未展开，下一轮沿用同一结果`);
    return { ...干净, 判定: { ...判定 } } as WorldEvent;
  });
  // 墓碑上不留判定(事情已经结束了)
  const 已结束 = (新.已结束 ?? []).map(event => {
    if (!event.判定) return event;
    const { 判定: _判定, ...干净 } = event;
    return 干净 as WorldEvent;
  });
  return { 数据: { ...新, 事件, 已结束 }, 备注 };
}
