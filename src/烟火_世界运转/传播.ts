// 烟火 · 传播时滞(v2.9.2, 设计稿模块 C)
//
// 主角只能经由传闻、公告、口信知道世界。以前事件一写进主世界书, 主 AI 就当场知道 ——
// `传播`(本地/区域/全域)只是面板徽标。这里用脚本(不调模型)算出:
//   这条事件和主角所在地是什么关系 → 按传播等级与本聊天的传讯速度要几天才传到 → 此刻传到的是哪一步。
//
// 只是**注入时的过滤**: 不改世界状态、不改事件档案、不进模型请求。
// 生效条件(任一不满足, 公开摘要就按 v2.9.1 规则注入, 一个字都不变):
//   设置「传播时滞」开着 · 本聊天选了传讯速度(不是"未选") · 主角所在已知 · 世界时间可解析。
import type { WorldData, WorldEvent, 传讯速度 } from './schema';
import { 解析日期 } from './时间校验';
import { 归到地区 } from './世界数据';

const 一日毫秒 = 86400000;

/** 跨地消息要几个世界日才传到(本地恒为 0)。"现代"全 0: 传得到就立刻知道, 但传播为本地的事仍传不出当地。
 *  键是传播等级(v2.10.0 起 天下 → 全域)。 */
export const 传讯时滞表: Readonly<Record<Exclude<传讯速度, '未选'>, { 全域: number; 区域: number }>> = {
  古代: { 全域: 7, 区域: 4 },
  近代: { 全域: 2, 区域: 1 },
  现代: { 全域: 0, 区域: 0 },
};

export type 地缘关系 = '本地' | '邻近' | '远方';
export type 传播等级 = '本地' | '区域' | '全域';

/** 这条事件是否发生在主角所在地区: 事件.地点 与地区名双向包含(都非空才判)。 */
export function 属于本地(event: Pick<WorldEvent, '地点'>, 主角所在: string): boolean {
  const 地点 = String(event.地点 ?? '').trim();
  const 所在 = String(主角所在 ?? '').trim();
  if (!地点 || !所在) return false;
  return 地点.includes(所在) || 所在.includes(地点);
}

/**
 * 地缘关系:
 *   本地 —— 事件地点归属主角所在;
 *   邻近 —— 两个地区的「外部关系」任一方提到另一方; 缺邻接信息时放宽为邻近
 *          (事件没写地点 / 主角所在不在地区档案里 / 主角所在地区的外部关系为空);
 *   远方 —— 其余。
 */
export function 判地缘(event: Pick<WorldEvent, '地点'>, data: Pick<WorldData, '地区'>, 主角所在: string): 地缘关系 {
  if (属于本地(event, 主角所在)) return '本地';
  const 地点 = String(event.地点 ?? '').trim();
  if (!地点) return '邻近';
  const 地区表 = data.地区 ?? {};
  const 事件地区 = 归到地区(地点, Object.keys(地区表));
  if (事件地区 && 事件地区 === 主角所在) return '本地';
  const 目标名 = 事件地区 ?? 地点;
  const 拆分邻近 = (值: unknown): string[] =>
    String(值 ?? '').split(/[、,，/；;\s]+/).map(s => s.trim()).filter(Boolean);
  const 所在地邻近 = 拆分邻近(地区表[主角所在]?.邻近地区);
  if (所在地邻近.includes(目标名)) return '邻近';
  if (事件地区 && 拆分邻近(地区表[事件地区]?.邻近地区).includes(主角所在)) return '邻近';
  const 所在地关系 = String(地区表[主角所在]?.外部关系 ?? '').trim();
  if (!所在地关系 && 所在地邻近.length === 0) return '邻近';
  if (所在地关系.includes(目标名)) return '邻近';
  if (事件地区 && String(地区表[事件地区]?.外部关系 ?? '').includes(主角所在)) return '邻近';
  return '远方';
}

/** 实际传播等级: 规模为"重大"时升一级(重大的事传得更远)。 */
export function 实际传播(event: Pick<WorldEvent, '传播' | '规模'>): 传播等级 {
  const 原 = (['本地', '区域', '全域'] as const).includes(event.传播 as 传播等级) ? event.传播 as 传播等级 : '本地';
  if (event.规模 !== '重大') return 原;
  return 原 === '本地' ? '区域' : '全域';
}

/** 要几个世界日传到; null = 传不到(传播为本地的事出不了当地, 区域的事到不了远方)。 */
export function 时滞天数(等级: 传播等级, 关系: 地缘关系, 速度: Exclude<传讯速度, '未选'>): number | null {
  if (关系 === '本地') return 0;
  if (等级 === '本地') return null;
  if (等级 === '区域') return 关系 === '邻近' ? 传讯时滞表[速度].区域 : null;
  return 传讯时滞表[速度].全域;
}

const 公告渠道 = /告示|榜文|布告|公告|邸报|官报|通报|公文|报道|新闻|快讯|通告/;

export interface 所闻 {
  /** 至少有一步已经传到 */
  到达: boolean;
  /** 传到的就是最近一次进展(可以照常写"当前") */
  最新: boolean;
  关系: 地缘关系;
  /** 公告(官方/公开渠道, 且没有辗转) / 传言 */
  公告: boolean;
  /** 未到达时的原因: 传不到(超出传播范围) / 在途(还在传讯路上) */
  原因?: '传不到' | '在途';
  /** 仅 原因 === '在途' 时有值: 预计还需几个世界日传到主角所在地 */
  预计剩余天数?: number;
  /** 只在 最新=false 时有: 所在地听到的那一步 */
  听到时间?: string;
  听到变化?: string;
  /** 听到的那一步距今几个世界日 */
  距今天数?: number;
}

export interface 传播上下文 {
  data: Pick<WorldData, '地区'>;
  主角所在: string;
  /** 当前世界时间 解析日期().天 */
  今: number;
  速度: Exclude<传讯速度, '未选'>;
}

/**
 * 这条事件此刻在主角所在地"听到了什么"。
 * 候选时刻 = 每一步 演变.时间 + 事件.时间(最近一次进展); 取「时刻 + 时滞 ≤ 今」里最晚的那一步。
 * 某一步时间解析不了 → 视为与最近进展同时; 事件.时间解析不了 → 视为已传到最新(没有时差可算, 不瞎猜)。
 */
export function 推算所闻(event: WorldEvent, 上下文: 传播上下文): 所闻 {
  const 关系 = 判地缘(event, 上下文.data, 上下文.主角所在);
  const 时滞 = 时滞天数(实际传播(event), 关系, 上下文.速度);
  const 公告 = 公告渠道.test(String(event.渠道 ?? ''));
  if (时滞 == null) return { 到达: false, 最新: false, 关系, 公告, 原因: '传不到' };
  const 辗转 = 关系 !== '本地' && 时滞 > 0;
  const 最近天 = 解析日期(event.时间)?.天;
  if (最近天 == null) return { 到达: true, 最新: true, 关系, 公告: 公告 && !辗转 };

  const 时刻 = [
    ...(event.演变 ?? []).map(步 => ({ 天: 解析日期(步.时间)?.天 ?? 最近天, 时间: 步.时间 || event.时间, 变化: 步.变化 })),
    { 天: 最近天, 时间: event.时间, 变化: '' },
  ];
  const 最晚 = Math.max(...时刻.map(刻 => 刻.天));
  const 已到 = 时刻.filter(刻 => (上下文.今 - 刻.天) / 一日毫秒 >= 时滞);
  if (!已到.length) {
    const 最早 = Math.min(...时刻.map(刻 => 刻.天));
    const 已过 = (上下文.今 - 最早) / 一日毫秒;
    const 预计剩余天数 = Math.max(1, Math.ceil(时滞 - 已过));
    return { 到达: false, 最新: false, 关系, 公告, 原因: '在途', 预计剩余天数 };
  }
  const 听到 = 已到.reduce((甲, 乙) => (乙.天 > 甲.天 ? 乙 : 甲));
  if (听到.天 >= 最晚) return { 到达: true, 最新: true, 关系, 公告: 公告 && !辗转 };
  return {
    到达: true, 最新: false, 关系, 公告: 公告 && !辗转,
    听到时间: 听到.时间,
    // 不回退到 event.描述: 那是远方**此刻**的状况, 正是这里承诺不写的东西。
    // 旧快照里 变化 为空串的演变步会活下来(重建事件 只要求是字符串); 空就不写「当地所闻」那一行, 标题与时间仍在。
    听到变化: 听到.变化,
    距今天数: Math.round((上下文.今 - 听到.天) / 一日毫秒),
  };
}

export interface 传播判定 {
  生效: boolean;
  /** 开关开着却没生效时的原因(只进日志, 不进请求体也不进注入); 开关关着为 '' */
  说明: string;
  上下文?: 传播上下文;
}

/** 传播时滞这一轮生不生效; 不生效时说明为什么。 */
export function 判传播(开关: boolean, 速度: 传讯速度 | undefined, 主角所在: string, 今: number | undefined, data: Pick<WorldData, '地区'>): 传播判定 {
  if (!开关) return { 生效: false, 说明: '' };
  const 缺: string[] = [];
  if (!速度 || 速度 === '未选') 缺.push('传讯速度未选');
  if (!主角所在) 缺.push('主角所在未知');
  if (今 == null) 缺.push('世界时间无法换算成公历');
  if (缺.length) return { 生效: false, 说明: `${缺.join(' / ')}，传播时滞未生效` };
  return { 生效: true, 说明: '', 上下文: { data, 主角所在, 今: 今!, 速度: 速度 as Exclude<传讯速度, '未选'> } };
}
