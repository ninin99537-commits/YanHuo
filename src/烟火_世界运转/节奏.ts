// 烟火 · 节奏事实(v2.9.3, 设计稿模块 D 前半)
//
// 密集档"连续好几轮无事"在 CHANGELOG 里出现过三次, 每次都是往提示词里加砝码。
// 这里换一种做法: 把"距上次重大事件 / 距上次新增公共事态 多少世界日"当成**事实**放进请求,
// 不规定产量、不设配额, 由模型自己判断 —— 与「零新增合法」并存。
//
// 时间来源:
//   · 统计.上次重大事件时间 / 上次新增时间: 提交快照时由 维护节奏() 写;
//   · 缺失(旧快照/新开局)时反推一次 —— 重大事件 = 事件 + 已结束 里规模为重大的最晚「时间」;
//     新增 = 各事件第一步演变的时间里最晚的那个(新事件入账时必带一句变化, 第一步演变就记在入账那一刻)。
import type { WorldData, WorldEvent } from './schema';
import { 解析日期 } from './时间校验';

const 一日毫秒 = 86400000;

function 最晚(时间们: readonly (string | undefined)[]): string {
  let 结果 = '';
  let 天 = -Infinity;
  for (const 时间 of 时间们) {
    const d = 解析日期(时间)?.天;
    if (d != null && d > 天) { 天 = d; 结果 = String(时间); }
  }
  return 结果;
}

function 全部事件(data: Pick<WorldData, '事件' | '已结束'>): WorldEvent[] {
  return [...(data.事件 ?? []), ...(data.已结束 ?? [])];
}

/** 当前的两个节奏时间: 统计里有就用, 没有就反推 */
export function 取节奏(data: Pick<WorldData, '事件' | '已结束' | '统计'>): { 上次重大事件时间: string; 上次新增时间: string } {
  const 事件们 = 全部事件(data);
  return {
    上次重大事件时间: data.统计?.上次重大事件时间 || 最晚(事件们.filter(e => e.规模 === '重大').map(e => e.时间)),
    上次新增时间: data.统计?.上次新增时间 || 最晚(事件们.map(e => e.演变?.[0]?.时间)),
  };
}

function 距离(时间: string, 今: number | undefined): string {
  if (!时间) return '尚无记录';
  const 天 = 解析日期(时间)?.天;
  if (天 == null || 今 == null) return '无法换算';
  const 差 = Math.max(0, Math.round((今 - 天) / 一日毫秒));
  return 差 === 0 ? '当日' : `约${差}世界日`;
}

/** 请求里那一行(不含标签); 首次建档(世界时间为空)返回 '' —— 那时没有"上次"可言, 整行不出 */
export function 节奏事实文本(data: Pick<WorldData, '事件' | '已结束' | '统计' | '世界'>): string {
  if (!data.世界?.时间) return '';
  const 今 = 解析日期(data.世界.时间)?.天;
  const { 上次重大事件时间, 上次新增时间 } = 取节奏(data);
  return `截至上次推进的世界时间，距上次重大事件：${距离(上次重大事件时间, 今)}；距上次新增公共事态：${距离(上次新增时间, 今)}。这只是事实，不是额度，也不要求本次必须生事。`;
}

/**
 * 提交时维护(纯函数): 返回新统计里这两项的值(空串 = 不写这个键)。
 *   · 本轮有新增事件 → 上次新增时间 = 新世界时间;
 *   · 本轮有重大事件新出现或换了阶段(含转为已结束), 或有暗线变成已发生 → 上次重大事件时间 = 新世界时间;
 *   · 否则沿用旧值(旧快照没有时按旧数据反推)。
 */
export function 维护节奏(旧: WorldData, 新: WorldData, 新增条数: number): { 上次重大事件时间: string; 上次新增时间: string } {
  const 旧值 = 取节奏(旧);
  const 新时间 = 新.世界?.时间 ?? '';
  const 旧阶段 = new Map(全部事件(旧).map(e => [e.id || e.标题, e.阶段]));
  const 重大动了 = 全部事件(新).some(e => {
    if (e.规模 !== '重大') return false;
    const 原 = 旧阶段.get(e.id || e.标题);
    return 原 === undefined || 原 !== e.阶段;
  });
  const 旧已发生 = new Set((旧.已失效暗线 ?? []).filter(s => s.成熟度 === '已发生').map(s => s.标题));
  const 暗线已发生 = (新.已失效暗线 ?? []).some(s => s.成熟度 === '已发生' && !旧已发生.has(s.标题));
  return {
    上次重大事件时间: (重大动了 || 暗线已发生) && 新时间 ? 新时间 : 旧值.上次重大事件时间,
    上次新增时间: 新增条数 > 0 && 新时间 ? 新时间 : 旧值.上次新增时间,
  };
}
