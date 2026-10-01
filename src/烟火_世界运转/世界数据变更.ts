import type { WorldData, WorldEvent, WorldFaction } from './schema';
import { EVENT_SCALE, EVENT_SECRECY, EVENT_SPREAD, EVENT_STAGE } from './schema';
import { getSettings } from './settings';
import { clearAllData, emptyData, ENDED_EVENT_LIMIT, EVENT_LIMIT, saveData } from './state';
import { syncWorldbookEntry } from './inject';
import { toastWarning } from './toast';
import { pickEnum, 签事件id, 有世界数据 } from './世界数据';
import type { 世界条目层, 世界层定义 } from './世界字段表';
import { 取层, 字段值, 内容字段, 全部字段 } from './世界字段表';

export type { 世界条目层 };

/**
 * 「世界数据变更」: 改世界数据的唯一一道门。
 *
 * 面板以前是就地改 data.value: 删事件按对象引用找(AI 换过数据树就找不到, 静默什么也不做)、
 * 存事件用 indexOf 找不到就丢弃、势力整对象覆盖、清空之后还要重读存储去猜"清干净没有"。
 * 现在四种改法(五层条目 / 事件 / 势力 / 世界概述 / 清空)都从这里走:
 * - 门自己算新数据, 不碰 store、不读存储, 也不直接弹提示(要告诉用户的话走 环境.提醒) —— 界面只消费返回值;
 * - 上限、同名、id 签发、字段规范化与 AI 那条路用同一份(世界数据.ts);
 * - 依赖走 世界数据环境: 生产环境(建世界数据环境)连真实的 state.ts / inject.ts / settings.ts,
 *   测试里换成假的就能把每种改法各跑一遍, 不需要酒馆。
 *
 * 与 AI 那条路有意保留的两点不同(那是"防 AI 编造"的规矩, 不是数据健康的规矩):
 * - 面板手动可以给事件选任意阶段(人是作者, 不是要被防的 AI);
 * - 面板填的字段就是保存后的值(空就是空), 不做"漏带沿用旧值"那套兜底。
 */

/** 门与外界(存储/世界书/设置)之间的接缝: 生产实现见 建世界数据环境 */
export interface 世界数据环境 {
  /** 是否开启「注入世界动向到主AI」——变更后要不要重同步世界书条目, 只由这一处决定 */
  注入世界书条目: boolean;
  /** 写一份快照(界面手动编辑用: 锚在最新楼层, 不推进"已推进到哪"); 返回是否真的写进了楼层 */
  保存: (数据: WorldData) => boolean;
  /** 物理删除所有楼层的快照 + 重置元数据(记录清空层) */
  清空: () => void;
  /** 重同步世界书条目: 写入=true 表示"照这份数据写成条目", false 表示"删掉条目" */
  同步世界书: (数据: WorldData, 写入: boolean) => unknown;
  /** 有话说给用户听时走这里(生产环境接 toast); 不传就只是记日志 */
  提醒?: (文本: string) => void;
}

/** 生产环境: 连真实的 保存/清空/世界书同步, 闸门从设置取 */
export function 建世界数据环境(): 世界数据环境 {
  const settings = getSettings();
  return {
    注入世界书条目: Boolean(settings.启用运转 && settings.运转.注入世界书条目),
    保存: saveData,
    清空: clearAllData,
    同步世界书: (数据, 写入) => syncWorldbookEntry(数据, 写入, getSettings()),
    提醒: 文本 => toastWarning(文本, '烟火'),
  };
}

export interface 变更返回 {
  /** 变更后的世界(被拒绝时就是原样那一份, 界面可以放心覆盖) */
  数据: WorldData;
  /** 给用户看的一句话(成功时才有效) */
  说明: string;
  /** 有值表示这次变更被拦下了(超上限/同名/名称为空), 内容是要告诉用户的原因 */
  拒绝?: string;
}

/** 五层常驻档案: 前三个是「名称→字段」的映射, 伏笔/节令是数组 */
export type 世界条目层 = '地域' | '大势' | '指标' | '伏笔' | '节令';

/** 五层常驻档案的层名与字段清单只在 世界字段表.ts 一处(候选 4): 这里按层名取定义,
 *  上限 / 名称键 / 字段(含枚举与兜底) / 该写进条目还是数组 全从表来 */
function 层定义(层: 世界条目层): 世界层定义 {
  return 取层(层);
}

function 文本(值: unknown): string {
  return String(值 ?? '').trim();
}

/** 按字段表拼一条「名称→字段」或数组条目的最终值(名称那一条由调用方给) */
function 表条目(定义: 世界层定义, 字段: Record<string, any>, 名称?: string): Record<string, string> {
  const 条目: Record<string, string> = {};
  for (const f of 全部字段(定义)) 条目[f.键] = f.键 === 定义.名称键 && 定义.名称键 ? (名称 ?? '') : 字段值(f, 字段[f.键]);
  return 条目;
}

function 拒绝(数据: WorldData, 原因: string): 变更返回 {
  return { 数据, 说明: '', 拒绝: 原因 };
}

/** 只写"你动过的"字段: 草稿里与打开编辑时的基准相同的字段, 保留数据里当前的值。
 *  面板编辑期间 AI 可能刚好推进过——不这么写, 那次推进的这个字段会被旧草稿盖掉。 */
function 只写改动(草稿: Record<string, any>, 基准: Record<string, any> | undefined, 现值: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [键, 值] of Object.entries(草稿)) {
    const 没动 = 基准 ? JSON.stringify(基准[键] ?? '') === JSON.stringify(值 ?? '') : false;
    out[键] = 没动 && 键 in 现值 ? 现值[键] : 值;
  }
  return out;
}

/** 重同步世界书条目: 空世界 = 删条目, 有数据 = 写条目; 失败只记日志, 不冒泡给界面 */
function 同步世界书(数据: WorldData, 环境: 世界数据环境) {
  if (!环境.注入世界书条目) return;
  try {
    const 结果 = 环境.同步世界书(数据, 有世界数据(数据));
    if (结果 && typeof (结果 as Promise<unknown>).then === 'function') {
      (结果 as Promise<unknown>).catch(error => console.error('[烟火] 同步世界书条目失败:', error));
    }
  }
  catch (error) {
    console.error('[烟火] 同步世界书条目失败:', error);
  }
}

/** 每个入口的固定顺序: 落快照 → 重同步世界书 → 返回新数据与说明 */
function 落盘并同步(新数据: WorldData, 环境: 世界数据环境, 说明: string): 变更返回 {
  // 以前这里不看返回值: 楼层快照没写进去(楼层已被删除 / 锚点取不到)时, 界面照样报"已保存",
  // 用户以为存住了, 刷新之后改动消失。现在写不进去就明确说一声(改动本身仍然生效, 只是没落盘)。
  const 落上了 = 环境.保存(新数据);
  if (落上了 === false) {
    环境.提醒?.('改动已生效, 但快照没能写进楼层(楼层可能已被删除), 刷新后会丢——请先推进一次世界再改');
  }
  同步世界书(新数据, 环境);
  return { 数据: 新数据, 说明 };
}

/** 保存世界概述(时间/氛围/总览) */
export function 保存世界概述(数据: WorldData, 草稿: { 时间?: string; 氛围?: string; 总览?: string }, 环境: 世界数据环境, 基准?: { 时间?: string; 氛围?: string; 总览?: string }): 变更返回 {
  const 字段 = 只写改动(
    { 时间: 文本(草稿.时间), 氛围: 文本(草稿.氛围), 总览: 文本(草稿.总览) },
    基准 ? { 时间: 文本(基准.时间), 氛围: 文本(基准.氛围), 总览: 文本(基准.总览) } : undefined,
    数据.世界 as unknown as Record<string, any>,
  );
  const 新数据: WorldData = {
    ...数据,
    世界: { ...数据.世界, 时间: 文本(字段.时间), 氛围: 文本(字段.氛围), 总览: 文本(字段.总览) },
  };
  return 落盘并同步(新数据, 环境, '已保存世界概述, 注入内容已同步');
}

/** 保存五层里的一条(地域/大势/指标/伏笔/节令): 原名='' 表示新增, 否则是按原名改(含改名) */
export function 保存世界条目(
  数据: WorldData,
  层: 世界条目层,
  原名: string,
  草稿: Record<string, string>,
  环境: 世界数据环境,
  基准?: Record<string, string>,
): 变更返回 {
  const 定义 = 层定义(层);
  const 键 = 定义.名称键;
  const 旧名 = 文本(原名);
  const 名字 = 文本(草稿[键]);
  if (!名字) return 拒绝(数据, `${键}不能为空`);
  const 上限 = 定义.容量;

  if (定义.形态 === '映射') {
    const 表 = { ...((数据[层] ?? {}) as Record<string, Record<string, string>>) };
    const 目标名 = 名字.slice(0, 30);
    if (目标名 !== 旧名 && 表[目标名]) return 拒绝(数据, `「${目标名}」已经存在, 请换个名字`);
    const 旧条目 = (旧名 ? 表[旧名] : undefined) ?? {};
    if (!旧名 && Object.keys(表).length >= 上限) return 拒绝(数据, `${层}最多 ${上限} 条, 请先删掉一条再添加`);
    const 字段 = 只写改动(草稿, 基准, 旧条目);
    // 枚举字段(指标的「趋势」)按表纠偏, 其余去首尾空白——与 AI 那条路同一把尺
    const 新条目: Record<string, string> = {};
    for (const f of 内容字段(定义)) 新条目[f.键] = 字段值(f, 字段[f.键]);
    if (旧名 && 旧名 !== 目标名) delete 表[旧名];
    表[目标名] = 新条目;
    return 落盘并同步({ ...数据, [层]: 表 } as WorldData, 环境, `已保存${层}「${目标名}」, 注入内容已同步`);
  }

  const 列表 = [...((数据[层] ?? []) as any[])];
  const 位置 = 旧名 ? 列表.findIndex(条目 => 条目[键] === 旧名) : -1;
  const 目标名 = 名字.slice(0, 40);
  if (列表.some((条目, i) => 条目[键] === 目标名 && i !== 位置)) return 拒绝(数据, `「${目标名}」已经存在, 请换个名字`);
  if (位置 < 0 && 列表.length >= 上限) return 拒绝(数据, `${层}最多 ${上限} 条, 请先删掉一条再添加`);
  const 字段 = 只写改动(草稿, 基准, 位置 >= 0 ? 列表[位置] : {});
  const 条目 = 表条目(定义, 字段, 目标名);
  if (位置 >= 0) 列表[位置] = 条目;
  else 列表.push(条目);
  return 落盘并同步({ ...数据, [层]: 列表 } as WorldData, 环境, `已保存${层}「${目标名}」, 注入内容已同步`);
}

/** 移除五层里的一条(按名字找, 不按对象引用) */
export function 移除世界条目(数据: WorldData, 层: 世界条目层, 名: string, 环境: 世界数据环境): 变更返回 {
  const 目标 = 文本(名);
  const 定义 = 层定义(层);
  if (定义.形态 === '映射') {
    const 表 = { ...((数据[层] ?? {}) as Record<string, unknown>) };
    delete 表[目标];
    return 落盘并同步({ ...数据, [层]: 表 } as WorldData, 环境, `已移除${层}「${目标}」, 注入内容已同步`);
  }
  const 键 = 定义.名称键;
  const 列表 = ((数据[层] ?? []) as any[]).filter(条目 => 条目[键] !== 目标);
  return 落盘并同步({ ...数据, [层]: 列表 } as WorldData, 环境, `已移除${层}「${目标}」, 注入内容已同步`);
}

/** 保存一条事件: 草稿.id 能对上既有事件就是改它(id 沿用, 改名也不丢历史), 对不上就当新增并签发 id */
export function 保存事件(数据: WorldData, 草稿: WorldEvent, 环境: 世界数据环境, 基准?: WorldEvent): 变更返回 {
  const 标题 = 文本(草稿.标题).slice(0, 60);
  if (!标题) return 拒绝(数据, '事件标题不能为空');
  const 列表 = [...(数据.事件 ?? [])];
  const id = 文本(草稿.id);
  const 位置 = id ? 列表.findIndex(条目 => 条目.id === id) : -1;
  if (列表.some((条目, i) => 条目.标题 === 标题 && i !== 位置)) return 拒绝(数据, `已有同名事件「${标题}」, 请改个标题`);
  if (位置 < 0 && 列表.length >= EVENT_LIMIT) return 拒绝(数据, `事件最多 ${EVENT_LIMIT} 条, 请先删掉一条再添加`);
  const 现值 = (位置 >= 0 ? 列表[位置] : {}) as unknown as Record<string, any>;
  const 字段 = 只写改动(草稿 as unknown as Record<string, any>, 基准 as unknown as Record<string, any> | undefined, 现值);
  const 条目: WorldEvent = {
    // id 由脚本独占签发: 认领回的一条沿用旧 id, 新的一条新签(草稿里带什么 id 都不作数)
    id: 位置 >= 0 ? 列表[位置].id : 签事件id(),
    标题,
    描述: 文本(字段.描述) || '（无描述）',
    地点: 文本(字段.地点),
    时间: 文本(字段.时间).slice(0, 40) || 数据.世界.时间,
    规模: pickEnum(字段.规模, EVENT_SCALE, '要事'),
    传播: pickEnum(字段.传播, EVENT_SPREAD, '本埠'),
    渠道: 文本(字段.渠道),
    势力: 文本(字段.势力),
    阶段: pickEnum(字段.阶段, EVENT_STAGE, '进行'),
    隐秘: pickEnum(字段.隐秘, EVENT_SECRECY, '公开'),
    代表人物: 文本(字段.代表人物),
    前情: 文本(字段.前情),
    演变: 位置 >= 0 ? [...(列表[位置].演变 ?? [])] : [],
  };
  if (位置 >= 0) 列表[位置] = 条目;
  else 列表.push(条目);
  // 已结束只许留这么多条: 手改与 AI 推进同一把尺(否则面板堆起来的旧事下轮被清, 用户会莫名其妙)
  if (条目.阶段 === '已结束' && 列表.filter(条目 => 条目.阶段 === '已结束').length > ENDED_EVENT_LIMIT) {
    return 拒绝(数据, `已结束的事件最多 ${ENDED_EVENT_LIMIT} 条, 请先删掉一条再了结`);
  }
  return 落盘并同步({ ...数据, 事件: 列表 }, 环境, '已保存事件修改, 注入内容已同步');
}

/** 移除一条事件: 按 id 找(不按对象引用——AI 换过数据树之后引用就失效了) */
export function 移除事件(数据: WorldData, id: string, 环境: 世界数据环境): 变更返回 {
  const 目标 = 文本(id);
  const 列表 = 数据.事件 ?? [];
  const 目标事件 = 列表.find(条目 => 条目.id === 目标);
  if (!目标事件) return { 数据, 说明: '这条事件已经不在清单里了' };
  const 新数据: WorldData = { ...数据, 事件: 列表.filter(条目 => 条目.id !== 目标) };
  return 落盘并同步(新数据, 环境, `已移除事件「${目标事件.标题}」, 注入内容已同步`);
}

/** 保存一条势力(按名字找; 只写用户改过的字段, 不整对象覆盖) */
export function 保存势力(数据: WorldData, 原名: string, 草稿: WorldFaction, 环境: 世界数据环境, 基准?: WorldFaction): 变更返回 {
  const 名 = 文本(原名);
  const 旧条目 = 数据.势力?.[名];
  if (!名 || !旧条目) return 拒绝(数据, '这条势力已经不在清单里了');
  const 字段 = 只写改动(草稿 as unknown as Record<string, any>, 基准 as unknown as Record<string, any> | undefined, 旧条目 as unknown as Record<string, any>);
  // 势力字段清单(含「前情」这类滚动字段)只在 世界字段表.ts: 这里按表拼条目, 不整对象覆盖
  const 条目 = 表条目(取层('势力'), 字段) as unknown as WorldFaction;
  return 落盘并同步({ ...数据, 势力: { ...数据.势力, [名]: 条目 } }, 环境, '已保存势力修改, 注入内容已同步');
}

/** 添加一条势力(面板目前没有这条路, 留着给"手动建势力"用; 上限与 AI 那条路同一把尺) */
export function 添加势力(数据: WorldData, 名: string, 草稿: WorldFaction, 环境: 世界数据环境): 变更返回 {
  const 势力层 = 取层('势力');
  const 目标名 = 文本(名).slice(0, 30);
  if (!目标名) return 拒绝(数据, '势力名不能为空');
  if (数据.势力?.[目标名]) return 拒绝(数据, `「${目标名}」已经存在, 请换个名字`);
  if (Object.keys(数据.势力 ?? {}).length >= 势力层.容量) return 拒绝(数据, `势力最多 ${势力层.容量} 条, 请先删掉一条再添加`);
  const 条目 = 表条目(势力层, 草稿 as unknown as Record<string, any>) as unknown as WorldFaction;
  return 落盘并同步({ ...数据, 势力: { ...数据.势力, [目标名]: 条目 } }, 环境, `已添加势力「${目标名}」, 注入内容已同步`);
}

/** 移除一条势力 */
export function 移除势力(数据: WorldData, 名: string, 环境: 世界数据环境): 变更返回 {
  const 目标 = 文本(名);
  const 势力 = { ...(数据.势力 ?? {}) };
  if (!势力[目标]) return { 数据, 说明: '这条势力已经不在清单里了' };
  delete 势力[目标];
  return 落盘并同步({ ...数据, 势力 }, 环境, `已移除势力「${目标}」, 注入内容已同步`);
}

/** 清空全部: 物理删快照 + 重置元数据 + 删掉世界书条目(不写快照), 返回空数据 */
export function 清空世界(环境: 世界数据环境): 变更返回 {
  环境.清空();
  const 空数据 = emptyData();
  同步世界书(空数据, 环境);
  return { 数据: 空数据, 说明: '世界已归零: 快照清空, 世界书条目已删除, 之后只推进新楼层' };
}
