import type { Settings, WorldData, WorldEvent, WorldFaction, WorldMetric, WorldOccasion, WorldSeed } from './schema';
import { SEED_MATURITY, 迁移枚举值, 迁移旧键名 } from './schema';
import { EVENT_LIMIT, 内容字段键, 取层, 占位词, 沿用条目, 规范化事件字段, 规范化条目, 事件层 } from './世界字段表';
import { 校验世界时间, 解析日期, type 世界时间约束 } from './时间校验';
import { 取运转策略, type 运转密度 } from './运转策略';

export function 签事件id(): string {
  return `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
export function 有世界数据(data: WorldData): boolean {
  return Boolean(data.世界.时间 || data.世界.总览 || data.事件.length || Object.keys(data.组织).length
    || Object.keys(data.地区 ?? {}).length || Object.keys(data.形势 ?? {}).length || data.暗线?.length
    || data.日程?.length || Object.keys(data.指标 ?? {}).length);
}
/** 枚举取值: 先过旧值表(v2.10.0), 在白名单里就用, 否则用 fallback(fallback 若是旧值也一并换掉) */
export function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const 值 = String(迁移枚举值(value) ?? '').trim();
  return (allowed as readonly string[]).includes(值) ? 值 as T : 迁移枚举值(fallback) as T;
}
function 文本(value: unknown, field = '字段'): string {
  if (value != null && typeof value === 'object') throw Error(`「${field}」应为完整文本，不接受对象或数组`);
  return String(value ?? '').trim();
}
function 合并文本(value: unknown, old: string | undefined, field: string): string {
  const text = 文本(value, field);
  return !text || (field === '背景' && 占位词(text)) ? old ?? '' : text;
}
function 对象(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 默认值只用于新事件，旧事件先认领身份，再继承缺失字段；所有内容均不裁切。 */
export function normalizeEvent(raw: any, worldTime: string, old?: WorldEvent): (WorldEvent & { 变化: string }) | null {
  if (!对象(raw)) return null;
  const source: Record<string, unknown> = {};
  for (const field of 事件层.字段) {
    const names = [field.键, ...(field.别名 ?? []), ...(field.旧名 ?? [])];
    const key = names.find(name => raw[name] != null);
    let value = key === undefined ? (old as any)?.[field.键] : raw[key];
    // v2.10.0: 模型照旧习惯写的老词(大事/天下/尾声…)先换成新词, 不当成越界值退回旧值
    if (field.枚举) value = 迁移枚举值(value);
    if (old && field.枚举 && !field.枚举.includes(文本(value, field.键))) value = (old as any)[field.键];
    if (field.键 === '背景') value = 合并文本(value, old?.背景, field.键);
    source[field.键] = value;
  }
  const fields = 规范化事件字段(source, 'AI', { 世界时间: worldTime });
  if (!fields) return null;
  const optional: Record<string, string> = {};
  for (const key of ['结束原因', '等待条件', '下次判定时间']) {
    const 原始 = (raw as Record<string, unknown>)[key];
    if (原始 !== undefined && 原始 !== null) {
      // 显式空串 = 明确清空(等待条件解除/不再判定)；没带这个键才沿用旧值
      const 文本值 = 合并文本(原始, undefined, key);
      if (文本值) optional[key] = 文本值;
      continue;
    }
    if ((old as any)?.[key] != null) optional[key] = 合并文本(undefined, (old as any)[key], key);
  }
  // 结束原因只属于已结束的事态；活跃事件上留着上一轮的原因会让下一轮误读成"已经结束"
  const 阶段值 = 文本(迁移枚举值(raw.阶段)) || old?.阶段 || '进行中';
  if (optional.结束原因 && 阶段值 !== '已结束') delete optional.结束原因;
  return {
    id: 文本(raw.id ?? raw.标识 ?? old?.id),
    ...(fields as unknown as Omit<WorldEvent, 'id' | '演变'>),
    ...optional,
    演变: [],
    变化: 文本(raw.变化 ?? raw.本次变化 ?? raw.本次推进),
  };
}

/** 先保留既有实体，再准入完整新条目；旧档超容量只诊断，不静默销毁。 */
export function normalizeLayer(raw: unknown, old: Record<string, any>, limit: number, fields: string[]): Record<string, any> {
  const out: Record<string, any> = Object.fromEntries(Object.entries(old));
  if (!对象(raw)) return out;
  for (const [name, item] of Object.entries(raw)) {
    const key = 文本(name);
    if (!key || !对象(item)) continue;
    if (!(key in out) && Object.keys(out).length >= limit) continue;
    out[key] = Object.fromEntries(fields.map(field => [field, 合并文本(item[field], old[key]?.[field], field)]));
  }
  return out;
}

export interface 维护选项 {
  密度?: 运转密度;
  运转?: Partial<Settings['运转']>;
  工作事件?: readonly string[];
  /** 本轮最新一层完整正文(v2.9.1): 只在「主角所在」模型没给、上次也没有时, 用来找最后出现的地区名 */
  正文?: string;
}

/**
 * 主角此刻所在(v2.9.1)。只认脚本能核对的来源, 次序固定:
 *   ① 模型给的值正好是某个地区名 → 用它;
 *   ② 与某个地区名互相包含(都至少 2 字) → 用那个地区名(多个时取最长的);
 *   ③ 模型给了但对不上地区 → 照用(主角可能在地区档案之外, 属预期, 面板上看得见);
 *   ④ 模型没给 → 沿用上次, 但先拿当前地区名过一遍 ①② (上次照用的写法, 地区档案后来补上了也能归一);
 *   ⑤ 上次也没有 → 在最新正文里找**最后出现**的地区名(首次建档用);
 *   ⑥ 都没有 → ''(未知)。
 * ⑤ 只在 ④ 落空时才用: 正文里提到一个地名不等于人在那儿, 沿用上次比猜更稳。
 * "未知/不详/无/待定"这类占位词不是地名: 当成"没给"(落到 ④⑤), 否则它会被照用, 抬头印出"主角所在：未知",
 * 而且所有事件都判成外地、背景全丢。
 */
const 所在占位 = /^(未知|不详|不明|不清楚|不确定|无|暂无|待定|同上|同前|无变化|—+|-+)$/;

function 净所在(值: unknown): string {
  const 文 = String(值 ?? '').trim();
  return 所在占位.test(文) ? '' : 文;
}

/** ①② : 正好是地区名, 或与地区名互相包含(都 ≥2 字, 取最长, 同长按名字排, 结果不随地区插入顺序变); 对不上 → null */
export function 归到地区(值: string, 名单: readonly string[]): string | null {
  if (名单.includes(值)) return 值;
  const 包含 = 名单
    .filter(名 => Math.min(名.length, 值.length) >= 2 && (值.includes(名) || 名.includes(值)))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  return 包含[0] ?? null;
}

export function 定主角所在(给值: unknown, 旧值: string | undefined, 地区名: readonly string[], 正文 = ''): string {
  const 值 = 净所在(文本(给值, '世界.主角所在'));
  const 名单 = 地区名.map(名 => String(名 ?? '').trim()).filter(Boolean);
  if (值) return 归到地区(值, 名单) ?? 值;
  const 上次 = 净所在(旧值);
  if (上次) return 归到地区(上次, 名单) ?? 上次;
  // ⑤ 比"名字结尾位置": 「…进了临江府。」里 临江 与 临江府 起点相同, 比起点会让先遍历到的短名赢;
  // 结尾更靠后的才是正文最后提到的那个, 同结尾取更长的。
  let 最后 = '';
  let 尾 = -1;
  for (const 名 of 名单) {
    const i = 正文.lastIndexOf(名);
    if (i < 0) continue;
    const 末 = i + 名.length;
    if (末 > 尾 || (末 === 尾 && 名.length > 最后.length)) { 尾 = 末; 最后 = 名; }
  }
  return 最后;
}

/** 周期日程的下一轮日期：只处理能解析成公历的周期(每年/每季/每月/每周/每天)，
 *  古代历法保持原文不伪造日期；算出来的新日期若仍早于当前世界时间，继续往前推。 */
function 下一次日程日期(时间: string, 周期: string, 世界日: number): string | null {
  const 周期文本 = String(周期 ?? '').trim();
  const 步长 = /每年|一年/.test(周期文本) ? { 年: 1 }
    : /每季|一季|季度/.test(周期文本) ? { 月: 3 }
      : /每月|一月|月度/.test(周期文本) ? { 月: 1 }
        : /每周|一周|星期/.test(周期文本) ? { 日: 7 }
          : /每天|每日/.test(周期文本) ? { 日: 1 }
            : null;
  if (!步长) return null;
  let 日期 = 解析日期(时间);
  if (!日期) return null;
  for (let i = 0; i < 500; i++) {
    const 基准: Date = new Date(日期.天);
    if (步长.年) 基准.setUTCFullYear(基准.getUTCFullYear() + 步长.年);
    if (步长.月) 基准.setUTCMonth(基准.getUTCMonth() + 步长.月);
    if (步长.日) 基准.setUTCDate(基准.getUTCDate() + 步长.日);
    const 下一天: number = 基准.getTime();
    if (下一天 <= 世界日) { 日期 = { 年: 基准.getUTCFullYear(), 月: 基准.getUTCMonth() + 1, 日: 基准.getUTCDate(), 天: 下一天 }; continue; }
    const 原时间 = 时间;
    const 格式 = /(\d{4})年(\d{1,2})月(\d{1,2})/.test(原时间) ? '中文' : 'iso';
    const 新日期 = 基准;
    const 年月日 = 格式 === '中文'
      ? `${新日期.getUTCFullYear()}年${新日期.getUTCMonth() + 1}月${新日期.getUTCDate()}日`
      : `${新日期.getUTCFullYear()}-${String(新日期.getUTCMonth() + 1).padStart(2, '0')}-${String(新日期.getUTCDate()).padStart(2, '0')}`;
    return 原时间.replace(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]?|(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/, 年月日);
  }
  return null;
}

export function validateAndNormalize(原载荷: any, oldData: WorldData, 时间约束?: 世界时间约束, options: 维护选项 = {}): WorldData {
  if (!对象(原载荷)) throw Error('AI 返回的 JSON 顶层必须是对象');
  // v2.10.1: 模型照旧写的老层名/老字段名(地域/势力/伏笔…、前情/当权者…)先搬到新名下
  const parsed = 迁移旧键名(原载荷);
  if (!对象(parsed.世界)) throw Error('缺少「世界」对象(应包含 时间/氛围/总览)，请重新输出');
  const time = 文本(parsed.世界.时间, '世界.时间');
  if (!time) throw Error('「世界.时间」为空；没有新时间依据时原样沿用上次时间');
  if (时间约束) 校验世界时间(time, 时间约束);
  if (!Array.isArray(parsed.事件)) throw Error('「事件」必须是数组(无事件时返回 [])');
  for (const layer of ['地区', '形势', '指标', '组织']) if (parsed[layer] !== undefined && !对象(parsed[layer])) throw Error(`「${layer}」必须是对象`);
  for (const layer of ['暗线', '日程']) if (parsed[layer] !== undefined && !Array.isArray(parsed[layer])) throw Error(`「${layer}」必须是数组`);
  const notes: string[] = [];
  const policy = 取运转策略({ 世界密度: options.密度 ?? options.运转?.世界密度 ?? '正常', ...options.运转 });
  const oldEvents = oldData.事件 ?? [];
  const oldById = new Map(oldEvents.filter(e => e.id).map(e => [e.id, e]));
  const oldByTitle = new Map(oldEvents.map(e => [e.标题, e]));
  const ended = [...(oldData.已结束 ?? [])];
  const terminalIds = new Set(ended.map(e => e.id).filter(Boolean));
  const terminalTitles = new Set(ended.map(e => e.标题));
  const used = new Set<WorldEvent>();
  const updated = new Map<WorldEvent, WorldEvent>();
  const newborn: WorldEvent[] = [];
  const seenTitles = new Set<string>();
  const workIds = options.工作事件 ? new Set(options.工作事件) : null;
  for (const raw of parsed.事件) {
    if (!对象(raw)) { notes.push('跳过非对象的事件候选'); continue; }
    const title = 文本(raw.标题 ?? raw.事件);
    const rawId = 文本(raw.id ?? raw.标识);
    const old = oldById.get(rawId) ?? oldByTitle.get(title);
    if (old && used.has(old)) { notes.push(`重复认领「${old.标题}」，只接受一份完整更新`); continue; }
    if (!old && (terminalIds.has(rawId) || terminalTitles.has(title))) { notes.push(`「${title}」已经结束，未因旧回忆重开`); continue; }
    if (old && workIds && !workIds.has(old.id || old.标题)) {
      continue;
    }
    const event = normalizeEvent(raw, time, old);
    if (!event) { notes.push(`缺少事件标题，候选未入账：${JSON.stringify(raw)}`); continue; }
    if (seenTitles.has(event.标题)) { notes.push(`事件标题「${event.标题}」重复，未另开条目`); continue; }
    seenTitles.add(event.标题);
    if (!old && event.阶段 === '已结束') { notes.push(`新事件「${event.标题}」不能未经记录直接结束`); continue; }
    const { 变化, ...fields } = event;
    const change = 占位词(变化) ? '' : 变化;
    const evolution = [...(old?.演变 ?? [])];
    if (change && change !== evolution.at(-1)?.变化) evolution.push({ 时间: time, 变化: change });
    const item: WorldEvent = { ...fields, id: old?.id || 签事件id(), 演变: evolution };
    // 事件.时间 = 最近一次进展：AI 显式给了时间就用它；没给时，有实质变化才更新为本次世界时间，
    // 没有实质变化则保留旧时间，避免把静止档案伪装成"刚发生"。
    const 显式给了时间 = 文本(raw.时间) !== '';
    const 有实质变化 = !!change || (old ? item.阶段 !== old.阶段 || item.描述 !== old.描述 : true);
    if (old && !显式给了时间 && !有实质变化) item.时间 = old.时间;
    if (old && !显式给了时间 && 有实质变化) item.时间 = time;
    if (old) {
      used.add(old);
      const 阶段没依据 = item.阶段 !== old.阶段 && !(item.结束原因 || change);
      if (阶段没依据) {
        notes.push(`「${old.标题}」阶段变化没有依据，沿用原阶段`);
        item.阶段 = old.阶段;
      }
      if (item.公开性 !== old.公开性 && !(change || (item.描述 && item.描述 !== old.描述))) {
        item.公开性 = old.公开性; notes.push(`「${old.标题}」未提供曝光依据，沿用原公开性`);
      }
      if (item.阶段 === '已结束' && !item.结束原因) {
        notes.push(`「${old.标题}」已结束但缺少完整结束原因；仍按已结束入档，原因请在下一轮补全`);
      }
      // 结束本身就是"最近一次进展"(2026-11-22): 模型常把旧事件整条带回、连旧时间一起原样抄,
      // 于是一件沉寂两个月的事今天收尾, 墓碑上记的还是两个月前 —— 注入的 30 日窗口按它量, 结局就静默缺席。
      // 模型给了一个**不同于旧值**的时间才算它显式指定了结束时刻; 没给或原样抄旧值, 都记成本轮世界时间。
      if (item.阶段 === '已结束' && old.阶段 !== '已结束') {
        const 给的时间 = 文本(raw.时间);
        if (!给的时间 || 给的时间 === old.时间) item.时间 = time;
      }
      if (item.阶段 === '已结束') ended.push(item);
      else updated.set(old, item);
    } else {
      if (item.阶段 !== '已结束' && !change) {
        notes.push(`新事件「${item.标题}」没有一句本次变化：只作为档案入册，别指望下一轮还能从一句话里看出它为什么发生`);
      }
      newborn.push(item);
    }
  }
  const active = oldEvents.filter(e => !used.has(e) || updated.has(e)).map(e => updated.get(e) ?? e);
  const omitted = oldEvents.filter(e => !used.has(e));
  if (omitted.length) notes.push(`保留${omitted.length}条未被带回或未参与本轮推演的旧事件；省略不代表结束`);
  const oldDate = 解析日期(oldData.世界.时间);
  const newDate = 解析日期(time);
  const jumped = !!oldDate && !!newDate && newDate.天 > oldDate.天;
  const configured = options.密度 !== undefined || options.运转 !== undefined;
  const cap = configured ? policy.进行中上限 : EVENT_LIMIT;
  const quota = configured ? (jumped ? policy.大跳新增 : policy.每轮新增) : EVENT_LIMIT;
  let admitted = 0;
  for (const event of newborn) {
    if (admitted >= quota || active.length >= cap) { notes.push(`新候选「${event.标题}」超过本轮准入额度，未添加；旧记录完整保留`); continue; }
    active.push(event); admitted++;
  }
  if (active.length > cap) notes.push(`旧档保留${active.length}条事态，超过${cap}条准入参考；停止额外新增，不强行判结束`);

  const factions: Record<string, WorldFaction> = { ...(oldData.组织 ?? {}) };
  const factionLayer = 取层('组织');
  for (const [name, raw] of Object.entries(parsed.组织 ?? {})) {
    if (!name || !对象(raw)) continue;
    if (!(name in factions) && Object.keys(factions).length >= factionLayer.容量) { notes.push(`组织「${name}」暂无新名额，旧实体不被挤掉`); continue; }
    factions[name] = 沿用条目(factionLayer, raw, (oldData.组织?.[name] as unknown as Record<string, unknown>)) as unknown as WorldFaction;
  }
  const regions = normalizeLayer(parsed.地区, oldData.地区 ?? {}, 取层('地区').容量, 内容字段键(取层('地区')));
  const trends = normalizeLayer(parsed.形势, oldData.形势 ?? {}, 取层('形势').容量, 内容字段键(取层('形势')));
  const metricLayer = 取层('指标');
  const metrics: Record<string, WorldMetric> = {};
  const metricRaw = options.运转?.世界指标 === false ? oldData.指标 ?? {} : normalizeLayer(parsed.指标, oldData.指标 ?? {}, metricLayer.容量, 内容字段键(metricLayer));
  for (const [name, entry] of Object.entries(metricRaw)) {
    const value = 规范化条目<WorldMetric>(metricLayer, entry);
    if (oldData.指标?.[name]?.值 === value.值) value.趋势 = oldData.指标[name].趋势;
    metrics[name] = value;
  }

  const invalidSeeds = [...(oldData.已失效暗线 ?? [])];
  const seeds = [...(oldData.暗线 ?? [])];
  const oldSeeds = new Map(seeds.map(e => [e.标题, e]));
  const seedSeen = new Set<string>();
  for (const raw of parsed.暗线 ?? []) {
    if (!对象(raw)) continue;
    const name = 文本(raw.标题);
    if (!name || seedSeen.has(name) || invalidSeeds.some(e => e.标题 === name)) continue;
    seedSeen.add(name);
    const old = oldSeeds.get(name);
    const item: WorldSeed = { 标题: name, 线索: 合并文本(raw.线索, old?.线索, '线索'), 指向: 合并文本(raw.指向, old?.指向, '指向'), 成熟度: pickEnum(raw.成熟度, SEED_MATURITY, old?.成熟度 ?? '酝酿'), 背景: 合并文本(raw.背景, old?.背景, '背景') };
    const 终止原因 = 合并文本(raw.结束原因, old?.结束原因, '结束原因');
    if (终止原因) item.结束原因 = 终止原因;
    const index = seeds.findIndex(e => e.标题 === name);
    if (item.成熟度 === '已发生' || item.成熟度 === '已失效') {
      if (!old || !文本(raw.结束原因 ?? raw.变化)) { notes.push(`暗线「${name}」终止缺少依据，原线头保留`); continue; }
      if (index >= 0) seeds.splice(index, 1);
      invalidSeeds.push(item);
    } else if (index >= 0) seeds[index] = item;
    else if (seeds.length < 取层('暗线').容量) seeds.push(item);
    else notes.push(`暗线「${name}」暂无新名额，未替换旧线头`);
  }

  const expired = [...(oldData.已过期日程 ?? [])];
  let occasions = [...(oldData.日程 ?? [])];
  if (options.运转?.世界日程 !== false) {
    const rawMap = new Map<string, Record<string, any>>();
    for (const raw of parsed.日程 ?? []) if (对象(raw) && 文本(raw.名称) && !rawMap.has(文本(raw.名称))) rawMap.set(文本(raw.名称), raw);
    const oldMap = new Map(occasions.map(e => [e.名称, e]));
    for (const [name, raw] of rawMap) {
      const old = oldMap.get(name);
      const item: WorldOccasion = { 名称: name, 周期: 合并文本(raw.周期, old?.周期, '周期'), 时间: 合并文本(raw.时间, old?.时间, '时间'), 概况: 合并文本(raw.概况, old?.概况, '概况') };
      // 范围(v2.9.5)有值才写: 没给范围的日程形状与以前一致
      const 范围 = 合并文本(raw.范围, old?.范围, '范围');
      if (范围) item.范围 = 范围;
      const index = occasions.findIndex(e => e.名称 === name);
      if (index >= 0) {
        if (!item.时间 && old?.时间) item.时间 = old.时间;
        if (!item.周期 && old?.周期) item.周期 = old.周期;
        if (!item.概况 && old?.概况) item.概况 = old.概况;
        occasions[index] = item;
      }
      else if (occasions.length < 取层('日程').容量) occasions.push(item);
      else notes.push(`日程「${name}」暂无新名额，尚未来临的旧节点保持`);
    }
    occasions = occasions.filter(item => {
      const date = 解析日期(item.时间);
      if (!newDate || !date || date.天 >= newDate.天) return true;
      if (item.周期 === '一次性') {
        if (!expired.some(e => e.名称 === item.名称 && e.时间 === item.时间)) expired.push(item);
        return false;
      }
      // 周期项不能永远停在同一个旧日期：到点后按周期顺延到下一次发生时间。
      const 下一 = 下一次日程日期(item.时间, item.周期, newDate.天);
      if (下一) {
        item.时间 = 下一;
        notes.push(`日程「${item.名称}」已过，按周期「${item.周期}」顺延到下一次 ${下一}`);
      }
      else {
        notes.push(`日程「${item.名称}」已过，但周期「${item.周期}」或日期无法按公历解析，保留原写法，请人工确认`);
      }
      return true;
    });
    occasions.sort((a,b) => (解析日期(a.时间)?.天 ?? Infinity) - (解析日期(b.时间)?.天 ?? Infinity));
  }
  // 主角所在只认能核对的来源(见 定主角所在); 空就不写这个键, 旧快照/旧用例的形状不变
  const 主角所在 = 定主角所在(parsed.世界.主角所在, oldData.世界.主角所在, Object.keys(regions), options.正文);
  return {
    ...oldData,
    世界: { 时间: time, ...(主角所在 ? { 主角所在 } : {}), 氛围: 合并文本(parsed.世界.氛围, oldData.世界.氛围, '氛围'), 总览: 合并文本(parsed.世界.总览 ?? parsed.世界.大势, oldData.世界.总览, '总览') },
    地区: regions, 形势: trends, 暗线: seeds, 日程: occasions, 指标: metrics,
    事件: active, 已结束: ended, 组织: factions,
    小结: 文本(parsed.小结 ?? parsed.小小结),
    已失效暗线: invalidSeeds, 已过期日程: expired, 维护备注: notes,
  };
}

export function 事件账目(oldEvents: WorldEvent[], newEvents: WorldEvent[]) {
  const identity = (event: WorldEvent) => event.id || `标题:${event.标题}`;
  const oldMap = new Map(oldEvents.map(e => [identity(e), e]));
  const keys = new Set(newEvents.map(identity));
  const added: string[] = [], updated: string[] = [];
  for (const event of newEvents) {
    const old = oldMap.get(identity(event));
    if (!old) added.push(event.标题);
    else if (JSON.stringify(old) !== JSON.stringify(event)) updated.push(event.标题);
  }
  const removed = oldEvents.filter(e => !keys.has(identity(e))).map(e => e.标题);
  return { added, updated, removed };
}
