import type { WorldData, WorldEvent, WorldFaction, WorldMetric, WorldOccasion, WorldSeed } from './schema';
import { EVENT_SCALE, EVENT_SECRECY, EVENT_SPREAD, EVENT_STAGE, SEED_MATURITY } from './schema';
import {
  ENDED_EVENT_LIMIT,
  EVENT_HISTORY_LIMIT,
  EVENT_LIMIT,
} from './state';
import { 内容字段键, 取层, 占位词, 沿用条目, 规范化条目 } from './世界字段表';
import { 校验世界时间, type 世界时间约束 } from './时间校验';

/**
 * 「世界数据规矩」: 旧世界 + AI 载荷 → 新世界 的全部领域规则。
 *
 * 以前这些规则长在 update.ts 的 validateAndNormalize 里, 只有 AI 自动推进那条路享有它们,
 * 面板手改手加时一条都不走(于是能造出 AI 路径永远造不出的数据: 超上限、标题重复、id 为空)。
 * 现在收在这里, 有两个好处:
 * - 规则是纯函数: 不碰平台、不写存储、不弹提示, 只吃"旧数据 + AI 载荷", 吐出规范化后的新数据;
 * - 上限/认领/去重/换血捞回只有这一份, 面板手改那条路以后也走同一套规矩。
 * 因此它可以在 node 里直接喂数据测, 不需要酒馆。
 *
 * 注意: 解析层(AI 脏输出 → 载荷)不在这里, 那部分仍留在 update.ts。
 */

/** 事件 id 由脚本独占签发: AI 与面板手改都不许编造(编造值不入档) */
export function 签事件id(): string {
  return `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** "这个世界到底有没有数据"的唯一判据: 面板的提示、世界书目条目的增减、启动补读都该问它 */
export function 有世界数据(数据: WorldData): boolean {
  return Boolean(
    数据.世界.时间 ||
    数据.世界.总览 ||
    数据.事件.length > 0 ||
    Object.keys(数据.势力).length > 0 ||
    Object.keys(数据.地域 ?? {}).length > 0 ||
    Object.keys(数据.大势 ?? {}).length > 0 ||
    (数据.伏笔 ?? []).length > 0 ||
    (数据.节令 ?? []).length > 0 ||
    Object.keys(数据.指标 ?? {}).length > 0,
  );
}

/** 解析 YYYY-MM-DD 形式的日期(取前 10 位的可比较形式); 非该形式返回 null */
function parseComparableDate(text: string): string | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(text ?? '').trim());
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

export function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const text = String(value ?? '').trim();
  return (allowed as readonly string[]).includes(text) ? (text as T) : fallback;
}

/** "无变化"类占位词(AI 对未变化事件可能填这些, 不应追加进演变/覆盖前情) —— 与势力清单共用同一份,
 *  写在 世界字段表.ts 里(候选 4: 字段表与两处沿用规矩不再各留一份) */

/** 单条事件的规范化结果: 变化=本次推进的实质变化(AI 报告), 合并进演变流水后即从最终数据中删除 */
type NormalizedEvent = WorldEvent & { 变化: string };

/** 单条事件的规范化: 枚举纠偏、缺字段兜底(知晓/隐秘缺省按旧数据兼容处理: 风闻/公开; 前情/演变缺省按空迁移)。
 *  内容字段不截断——字数由提示词约束+AI 滚动折叠自我控制, 代码截断会把因果链砍成半句(比超长更糟);
 *  只保留结构性键的字段上限(id 防对账错乱、标题防面板爆版, 它们是格式键不是内容) */
export function normalizeEvent(raw: any, worldTime: string): NormalizedEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const 标题 = String(raw.标题 ?? raw['事件'] ?? '').trim().slice(0, 60);
  if (!标题) return null;
  return {
    id: String(raw.id ?? raw['标识'] ?? '').trim().slice(0, 32),
    标题,
    描述: String(raw.描述 ?? raw['经过'] ?? raw['详情'] ?? raw['概述'] ?? '').trim() || '（无描述）',
    地点: String(raw.地点 ?? raw['位置'] ?? '').trim(),
    时间: String(raw.时间 ?? '').trim().slice(0, 40) || worldTime,
    规模: pickEnum(raw.规模, EVENT_SCALE, '要事'),
    传播: pickEnum(raw.传播 ?? raw['传播范围'], EVENT_SPREAD, '本埠'),
    渠道: String(raw.渠道 ?? '').trim(),
    势力: String(raw.势力 ?? '').trim(),
    阶段: pickEnum(raw.阶段, EVENT_STAGE, '进行'),
    隐秘: pickEnum(raw.隐秘 ?? raw['秘密'], EVENT_SECRECY, '公开'),
    代表人物: String(raw.代表人物 ?? raw['人物'] ?? raw['当事人物'] ?? '').trim(),
    前情: String(raw.前情 ?? raw['来龙去脉'] ?? raw['背景'] ?? '').trim(),
    演变: [],
    变化: String(raw.变化 ?? raw['本次变化'] ?? raw['本次推进'] ?? '').trim(),
  };
}

/** 规范化「名称 → 字符串字段」的常驻层(地域/大势/指标): 字段缺失沿用旧值, 未带回的旧条目捞回 */
export function normalizeLayer(raw: unknown, old: Record<string, any>, limit: number, fields: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {};
  for (const [name, item] of Object.entries(src)) {
    if (Object.keys(out).length >= limit) break;
    const key = String(name).trim().slice(0, 30);
    if (!key || !item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry: Record<string, string> = {};
    for (const field of fields) {
      entry[field] = String((item as any)[field] ?? '').trim() || String(old[key]?.[field] ?? '').trim();
    }
    out[key] = entry;
  }
  // 增量维护: AI 漏带的旧条目捞回(与事件/势力同款), 防止一次疏忽清掉整条档案
  for (const [name, entry] of Object.entries(old)) {
    if (out[name]) continue;
    if (Object.keys(out).length >= limit) break;
    out[name] = entry;
  }
  return out;
}

/**
 * 校验并规范化 AI 输出的世界推进 JSON: 结构性错误(缺世界/缺时间/事件势力类型不对)抛错重试;
 * 单条事件的字段缺失只警告并用默认值兜底。
 */
export function validateAndNormalize(parsed: any, oldData: WorldData, 时间约束?: 世界时间约束): WorldData {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Error('AI 返回的 JSON 结构不符合预期(顶层不是对象)');
  }
  const world = parsed['世界'];
  if (!world || typeof world !== 'object' || Array.isArray(world)) {
    throw Error('缺少「世界」对象(应包含 时间/氛围/总览), 请重新输出');
  }
  const 时间 = String(world['时间'] ?? '').trim();
  if (!时间) {
    throw Error('「世界.时间」为空——必须推进当前时间(正文没有时间线索时按上次世界时间合理顺延), 请重新输出');
  }
  if (时间约束) 校验世界时间(时间, 时间约束);
  if (!Array.isArray(parsed['事件'])) {
    throw Error('「事件」必须是数组(没有事件时返回空数组 []), 请重新输出');
  }
  if (parsed['势力'] !== undefined && (typeof parsed['势力'] !== 'object' || parsed['势力'] === null || Array.isArray(parsed['势力']))) {
    throw Error('「势力」必须是对象(没有势力时返回空对象 {}), 请重新输出');
  }
  // 两个桶: `活跃` = 此刻在酝酿/进行/尾声的(进 `事件`), `本轮了结` = AI 这一轮收尾的(进 `已了结`)。
  // 墓碑桶归**代码**维护: AI 看不见也不带回, 它唯一的"了结"动作就是把某条的 阶段 改成 已结束。
  const 活跃: WorldEvent[] = [];
  const 本轮了结: WorldEvent[] = [];
  const oldEvents = oldData.事件 ?? [];
  // 对账钥匙: 先按 id(脚本签发的唯一标识, AI 改标题也不丢), 再按标题兜底; 一条旧事件只能被认领一次。
  // AI 不可信之处逐一兜住: 改名(id 救)、漏带 id(标题救)、id 被占用/被顶(继续尝试标题)、
  // 复读同一条(去重)、给新事件编造 id(一律脚本重签, 编造值不入档)
  const oldById = new Map(oldEvents.filter(event => event.id).map(event => [event.id, event]));
  const oldByTitle = new Map(oldEvents.map(event => [event.标题, event]));
  const usedOld = new Set<WorldEvent>();
  const seenKeys = new Set<string>();
  const newEventId = 签事件id;
  for (const raw of parsed['事件']) {
    const event = normalizeEvent(raw, 时间);
    if (!event) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        console.warn(`[烟火] 事件缺少「标题」, 已跳过: ${JSON.stringify(raw).slice(0, 120)}`);
      }
      continue;
    }
    // AI 复读同一条(同 id 同标题)只保留第一份, 防止重复认领与重复入账
    const dupKey = `${event.id}‖${event.标题}`;
    if (seenKeys.has(dupKey)) {
      console.warn(`[烟火] 事件「${event.标题}」重复输出, 已去重`);
      continue;
    }
    seenKeys.add(dupKey);
    let old: WorldEvent | null = null;
    const byId = event.id ? (oldById.get(event.id) ?? null) : null;
    const byTitle = oldByTitle.get(event.标题) ?? null;
    if (byId && !usedOld.has(byId)) old = byId;
    else if (byTitle && !usedOld.has(byTitle)) old = byTitle;
    if (old) usedOld.add(old);
    // 全新事件(对不上任何既有事件)不得直接以"已结束"生成——没有过程的事是凭空编造, 直接丢弃并告警;
    // 靠 id 认领回的改名事件不受此限(它有历史, 了结合法)
    if (event.阶段 === '已结束' && !old) {
      console.warn(`[烟火] 新事件「${event.标题}」直接以"已结束"生成, 已丢弃(新事件只能是 酝酿/进行)`);
      continue;
    }
    const { 变化: 本次变化, ...rest } = event;
    // 变化: AI 填"无变化/暂无"类占位词不算实质变化, 不追加进演变
    const 变化Text = 占位词(本次变化) ? '' : 本次变化;
    // 前情: AI 填占位词或漏带时沿用旧前情, 防止好总结被"无/同上"覆盖
    const 前情Text = rest.前情 && !占位词(rest.前情) ? rest.前情 : (old?.前情 ?? '');
    const 演变 = [...(old?.演变 ?? [])];
    const lastStep = 演变.length > 0 ? 演变[演变.length - 1] : undefined;
    if (变化Text && 变化Text !== lastStep?.变化) {
      演变.push({ 时间, 变化: 变化Text });
      if (演变.length > EVENT_HISTORY_LIMIT) 演变.splice(0, 演变.length - EVENT_HISTORY_LIMIT);
    }
    // id 由脚本独占签发: 认领到旧事件沿用其 id(旧快照迁移的空 id 也重签), 全新事件一律新签
    const 条目: WorldEvent = { ...rest, id: old && old.id ? old.id : newEventId(), 前情: 前情Text, 演变 };
    if (条目.阶段 === '已结束') 本轮了结.push(条目);
    else 活跃.push(条目);
  }
  // 清单换血守卫: AI 忽略"原样带回"指令把旧事件大量丢掉时(未认领旧事件占多数), 把旧事件自动捞回
  // (原样, 不算新增)——AI 无权让进行中的事凭空消失, 只有 AI 明确带回"已结束"的才算真正了结。
  // `事件` 里本来就没有墓碑(旧墓碑住在 `已了结`), 所以捞回范围天然只有 酝酿/进行/尾声。
  const claimed = new Set([...活跃, ...本轮了结].map(e => e.id));
  const dropped = oldEvents.filter(e => e.id && !claimed.has(e.id));
  if (dropped.length > 0 && oldEvents.length > 0) {
    const dropRatio = dropped.length / oldEvents.length;
    if (dropRatio >= 0.5) {
      console.warn(`[烟火] 事件清单换血: ${dropped.length}/${oldEvents.length} 件未结束事件未被带回(${dropped.map(e => e.标题).join('、')}), 已自动捞回——提示词要求原样维护清单, 请检查模型是否遵守`);
    }
    活跃.push(...dropped);
  }
  // 墓碑桶 = 旧墓碑在前 + 本轮了结在后(清单按时间从早到晚), 只留最近 ENDED_EVENT_LIMIT 条:
  // "保留已了结的事"是存储, 不是判断——它从这里起完全归代码, AI 不再逐字带回
  const 墓碑候选 = [...(oldData.已了结 ?? []), ...本轮了结];
  const 已了结 = 墓碑候选.slice(-ENDED_EVENT_LIMIT);
  if (墓碑候选.length > 已了结.length) {
    console.info(`[烟火] 已了结的事超过 ${ENDED_EVENT_LIMIT} 条, 自动清理最旧的 ${墓碑候选.length - 已了结.length} 条`);
  }
  // `事件` 的条数上限只夹活跃桶(墓碑按 ENDED_EVENT_LIMIT 单独夹)
  if (活跃.length > EVENT_LIMIT) {
    // 清单按时间从早到晚排列, 超限时保留最新的
    活跃.splice(0, 活跃.length - EVENT_LIMIT);
  }
  const factions: Record<string, WorldFaction> = {};
  const rawFactions = parsed['势力'] && typeof parsed['势力'] === 'object' ? parsed['势力'] : {};
  const oldFactions = oldData.势力 ?? {};
  const 势力层 = 取层('势力');
  // 明显不是势力的名字(人物组合/小商贩)直接过滤: 提示词已禁止, 这里兜底
  const NOT_FACTION_RE = /(姐妹|姐妹俩|兄弟俩|兄妹|姐弟|夫妻|母女|父子|一家人|一家[三四五口]|煎饼|小摊|早点摊|小吃|奶茶店|小卖部|便利店|水果店|大排档)/;
  // 覆盖式防丢: AI 只看得到本次喂给它的旧势力内容, 但字段是覆盖写——AI 漏带某字段时
  // 沿用旧值而非清空, 防止"势力范围/前情"这类慢变字段被一次疏忽清掉; 字段清单与别名(势力范围←领地/
  // 根据地/据点, 头面人物←首领/掌门/代言人)全在 世界字段表.ts, 前情写占位词时也沿用旧值。
  // 内容字段不截断——字数由提示词约束, 代码截断会把内容砍成半句(比超长更糟)
  for (const [name, raw] of Object.entries(rawFactions)) {
    if (Object.keys(factions).length >= 势力层.容量) break;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const factionName = String(name).trim().slice(0, 30);
    if (!factionName) continue;
    if (NOT_FACTION_RE.test(factionName)) {
      console.warn(`[烟火] 「${factionName}」不是势力(人物组合或小商贩), 已跳过`);
      continue;
    }
    factions[factionName] = 沿用条目<WorldFaction>(
      势力层,
      raw as Record<string, unknown>,
      oldFactions[factionName] as unknown as Record<string, unknown> | undefined,
    );
  }
  // 势力换血守卫(与事件同款): AI 未带回的既有势力自动捞回——势力被AI大量丢掉通常是清单
  // 换血的连带伤害, 真正不想要的势力走面板手动移除。超限时 AI 没带的新势力不会捞(下轮正常丢)。
  for (const [name, faction] of Object.entries(oldFactions)) {
    if (factions[name]) continue;
    if (Object.keys(factions).length >= 势力层.容量) break;
    if (Object.keys(oldFactions).length > 0 && Object.keys(factions).length === 0) {
      console.warn('[烟火] 势力清单被整体清空, 已自动捞回既有势力——真正要删的势力请在面板手动移除');
    }
    factions[name] = faction;
  }
  // 五层常驻档案: 地域/大势/指标用通用「名称→字符串字段」规范化(字段清单与上限都从字段表取);
  // 伏笔/节令为数组, 各有自己的成熟度/过期与沿用规矩, 单独处理
  const 地域层 = 取层('地域');
  const 大势层 = 取层('大势');
  const 指标层 = 取层('指标');
  const 指标Raw = normalizeLayer(parsed['指标'], oldData.指标 ?? {}, 指标层.容量, 内容字段键(指标层));
  const 指标: Record<string, WorldMetric> = {};
  for (const [name, entry] of Object.entries(指标Raw)) {
    指标[name] = 规范化条目<WorldMetric>(指标层, entry);
  }
  const 伏笔层 = 取层('伏笔');
  const 伏笔: WorldSeed[] = [];
  if (Array.isArray(parsed['伏笔'])) {
    for (const raw of parsed['伏笔']) {
      if (伏笔.length >= 伏笔层.容量) break;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const 标题 = String(raw.标题 ?? '').trim().slice(0, 40);
      if (!标题) continue;
      const oldSeed = (oldData.伏笔 ?? []).find(seed => seed.标题 === 标题);
      伏笔.push({
        标题,
        埋设: String(raw.埋设 ?? '').trim() || oldSeed?.埋设 || '',
        指向: String(raw.指向 ?? '').trim() || oldSeed?.指向 || '',
        成熟度: pickEnum(raw.成熟度, SEED_MATURITY, '酝酿'),
        前情: String(raw.前情 ?? '').trim() || oldSeed?.前情 || '',
      });
    }
  }
  for (const seed of oldData.伏笔 ?? []) {
    if (伏笔.length >= 伏笔层.容量) break;
    // 已爆发的伏笔会被兑现成事件并从清单删除, 不要捞回(否则和 AI 的删除打架)
    if (seed.成熟度 === '已爆发') continue;
    if (!伏笔.some(item => item.标题 === seed.标题)) 伏笔.push(seed);
  }
  const 世界日期 = parseComparableDate(时间);
  const 节令已过期 = (occ: WorldOccasion) => {
    if (!世界日期) return false;
    const 日期 = parseComparableDate(occ.时间);
    return !!日期 && 日期 < 世界日期;
  };
  // 先全量收集(不在这里截断), 再按时间从近到远排序后截断:
  // 保证"还没到、就快到"的节令不会被这轮新增的节令挤掉
  const 节令层 = 取层('节令');
  const 节令候选: WorldOccasion[] = [];
  if (Array.isArray(parsed['节令'])) {
    for (const raw of parsed['节令']) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const 名称 = String(raw.名称 ?? '').trim().slice(0, 40);
      if (!名称) continue;
      const entry: WorldOccasion = {
        名称,
        周期: String(raw.周期 ?? '').trim(),
        时间: String(raw.时间 ?? '').trim(),
        概况: String(raw.概况 ?? '').trim(),
      };
      // 过期项丢弃(仅在世界时间与节令时间都是 YYYY-MM-DD 可比形式时生效)
      if (节令已过期(entry)) continue;
      if (!节令候选.some(item => item.名称 === entry.名称)) 节令候选.push(entry);
    }
  }
  // 漏带捞回: 补回 AI 漏写的旧节令(仅在没过期、且世界时间可比时), 防止一次疏忽清掉尚未到来的节令
  if (世界日期) {
    for (const occ of oldData.节令 ?? []) {
      if (节令已过期(occ)) continue;
      if (!节令候选.some(item => item.名称 === occ.名称)) 节令候选.push(occ);
    }
  }
  const 节令 = 节令候选
    .map((occ, index) => ({ occ, index, date: parseComparableDate(occ.时间) }))
    .sort((a, b) => {
      if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      if (a.date) return -1;
      if (b.date) return 1;
      return a.index - b.index;
    })
    .map(item => item.occ)
    .slice(0, 节令层.容量);
  return {
    ...oldData,
    世界: {
      时间,
      // 氛围/总览: AI 漏带字段时沿用旧值, 防止一次疏忽清空(覆盖式写入的常规兜底, 与势力字段同款)
      氛围: String(world['氛围'] ?? '').trim() || oldData.世界.氛围 || '',
      // 旧字段「大势」兜底迁移为「总览」
      总览: String(world['总览'] ?? world['大势'] ?? '').trim() || oldData.世界.总览 || '',
    },
    地域: normalizeLayer(parsed['地域'], oldData.地域 ?? {}, 地域层.容量, 内容字段键(地域层)),
    大势: normalizeLayer(parsed['大势'], oldData.大势 ?? {}, 大势层.容量, 内容字段键(大势层)),
    伏笔,
    节令,
    指标,
    事件: 活跃,
    已了结,
    势力: factions,
    小结: String(parsed['小结'] ?? parsed['小小结'] ?? '').trim(),
  };
}

/** 新旧事件清单的账目(供日志页展示): 一律按 id 认, 不按标题。
 *  按标题认的话, AI 给事件改个名字, 日志就会说"移除了旧名字、新增了新名字", 与事实正好相反。
 *  老快照里没有 id 的事件退回按标题认, 免得整条清单都被当成新增。 */
export function 事件账目(oldEvents: WorldEvent[], newEvents: WorldEvent[]) {
  const 认 = (event: WorldEvent) => event.id || `标题:${event.标题}`;
  const 旧表 = new Map(oldEvents.map(event => [认(event), event]));
  const 新键 = new Set(newEvents.map(认));
  const added: string[] = [];
  const updated: string[] = [];
  for (const event of newEvents) {
    const 旧 = 旧表.get(认(event));
    if (!旧) {
      added.push(event.标题);
    }
    else if (旧.描述 !== event.描述 || 旧.阶段 !== event.阶段 || 旧.隐秘 !== event.隐秘) {
      updated.push(event.标题);
    }
  }
  const removed = oldEvents.filter(event => !新键.has(认(event))).map(event => event.标题);
  return { added, updated, removed };
}
