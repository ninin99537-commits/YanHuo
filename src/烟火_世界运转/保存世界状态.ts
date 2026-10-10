// 烟火 · 保存世界状态(候选 3) —— 世界状态怎么落盘、怎么读回、怎么迁移旧格式、怎么清空。
//
// 改造前这份"落盘契约"只存在于注释与调用点的记忆里: 调用方必须知道 payload 里没有「清空层」、
// 「处理到楼层」取自第三个参数而不是 data、写完还要自己补「锚点楼层」并同步 store(成功/失败两条
// 分支)、保留份数由内部再读一次设置决定; 重推还得记住顺序 —— 先撤销快照, 再重新读回。
// 现在这些全部收进这一层, 对外只有一处可看(门面在文件末尾):
//   读取 / 保存(界面手改) / 推进落盘(推进一轮) / 重推 / 撤销楼层 / 清空
// 于是"想看世界状态是怎么存的", 只需要看这一个文件。
//
// 这一层是纯粹的数据存取: 不碰 Vue、不碰 pinia(界面要的那份响应式副本在 state.ts 的 useStateStore),
// 平台访问全部走 useHost()(约定见 host.ts 顶部), 所以能脱离界面在 node 里单独测一遍。
import { klona } from 'klona';
import { useHost } from './host';
import type { EventEvolution, WorldData, WorldEvent, WorldFaction, WorldMetric, WorldOccasion, WorldRegion, WorldSeed, WorldTrend } from './schema';
import { EVENT_SCALE, EVENT_SECRECY, EVENT_SPREAD, EVENT_STAGE } from './schema';
import { getSettings } from './settings';
import { toastError } from './toast';
// 墓碑上限与五层容量同一处(世界字段表): 这里不引 state.ts —— 它反过来依赖本模块, 会成环
import { ENDED_EVENT_LIMIT, 取层, 规范化条目 } from './世界字段表';

export const STORAGE_KEY = '烟火';
export const DATA_VERSION = 1;
/** 楼层快照的默认保留份数(设置「运转.快照保留份数」可调): 写入新快照时把更早楼层的快照物理删除, 防止聊天文件随楼层无限膨胀 */
export const SNAPSHOT_LIMIT = 10;
/** 单个事件演变流水的保留条数(最新在后, 超出裁掉最旧的)。
 *  它管的是"读回快照时把演变裁到多长", 所以跟着快照重建规则住在这里;
 *  世界数据.ts 规范化 AI 载荷时裁的是同一个长度, 从 state.ts 原样转出去给它(state.ts 只转出, 不再自己写一份)。 */
export const EVENT_HISTORY_LIMIT = 8;

// ---------------------------------------------------------------------------
// 存储结构 (v1), 与彼方 v4.3 同款:
// - 聊天变量 `烟火` 只存轻量元数据: 哪些楼层有快照(索引) + 清空层
// - 世界状态本体(世界/事件/势力/小结/统计)整体存在**楼层变量**里, 每次推进写入本次
//   分析的最后一条楼层。快照随楼层存亡——删除楼层/重roll(新swipe页没有快照)时状态
//   自动回退到更早楼层的快照。v1.8 起楼层 hash 校验已移除(流式收尾/正则后处理会
//   让楼层内容在快照写入后再变动, hash 失配会把正常游玩误判为"被编辑")。
// ---------------------------------------------------------------------------

export function emptyData(): WorldData {
  return {
    版本: DATA_VERSION,
    世界: { 时间: '', 氛围: '', 总览: '' },
    地域: {},
    大势: {},
    伏笔: [],
    节令: [],
    指标: {},
    事件: [],
    // 墓碑桶: 只由代码维护(见 sanitizeSnapshot 的旧格式分流与 世界数据.ts 的双桶合并)
    已了结: [],
    势力: {},
    小结: '',
    统计: { 推进次数: 0, 最后推进: 0 },
    锚点楼层: -1,
    处理到楼层: 0,
    清空层: 0,
  };
}

/** 聊天变量里的轻量元数据: 快照楼层索引 + 清空层(世界状态本体不在这里) */
export interface ChatMeta {
  版本: number;
  快照楼层: number[];
  清空层: number;
}

function emptyMeta(): ChatMeta {
  return { 版本: DATA_VERSION, 快照楼层: [], 清空层: 0 };
}

function saveMeta(meta: ChatMeta) {
  try {
    // 整体赋值该键(避免 insertOrAssign 深合并残留旧字段), 其他聊天变量键不动
    useHost().vars.update(variables => {
      variables[STORAGE_KEY] = klona(meta);
      return variables;
    }, { type: 'chat' });
  } catch (error) {
    console.error('[烟火] 保存元数据失败:', error);
    toastError(`烟火: 保存元数据失败 ${error instanceof Error ? error.message : String(error)}`, '烟火');
  }
}

function loadMeta(): ChatMeta {
  let raw = null;
  try {
    raw = useHost().vars.get({ type: 'chat' })?.[STORAGE_KEY] ?? null;
  } catch {
    return emptyMeta();
  }
  if (!raw || typeof raw !== 'object') return emptyMeta();
  // 结构异常的兜底(快照楼层不是数组): 救回清空层, 索引按空处理
  if (!Array.isArray(raw.快照楼层)) {
    return {
      版本: DATA_VERSION,
      快照楼层: [],
      清空层: typeof raw.清空层 === 'number' ? raw.清空层 : 0,
    };
  }
  return {
    版本: DATA_VERSION,
    快照楼层: raw.快照楼层.filter(floor => typeof floor === 'number' && Number.isFinite(floor)),
    清空层: typeof raw.清空层 === 'number' ? raw.清空层 : 0,
  };
}

/** 重建一条事件(旧快照的 知晓/迫近 已废弃, 不随展开带进新结构) */
function 重建事件(列表: unknown[]): WorldEvent[] {
  return 列表
    .filter((item: unknown): item is WorldEvent => !!item && typeof item === 'object' && typeof (item as WorldEvent).标题 === 'string')
    .map(event => ({
      id: String(event.id ?? ''),
      标题: String(event.标题 ?? '').slice(0, 60),
      描述: String(event.描述 ?? ''),
      地点: String(event.地点 ?? ''),
      时间: String(event.时间 ?? ''),
      规模: EVENT_SCALE.includes(event.规模) ? event.规模 : '要事',
      传播: EVENT_SPREAD.includes(event.传播) ? event.传播 : '本埠',
      渠道: String(event.渠道 ?? ''),
      势力: String(event.势力 ?? ''),
      阶段: EVENT_STAGE.includes(event.阶段) ? event.阶段 : '进行',
      隐秘: EVENT_SECRECY.includes(event.隐秘) ? event.隐秘 : '公开',
      代表人物: String(event.代表人物 ?? ''),
      前情: String(event.前情 ?? ''),
      演变: Array.isArray(event.演变)
        ? event.演变
            .filter((step): step is EventEvolution => !!step && typeof step === 'object' && typeof step.变化 === 'string')
            .map(step => ({ 时间: String(step.时间 ?? ''), 变化: String(step.变化) }))
            .slice(-EVENT_HISTORY_LIMIT)
        : [],
    }));
}

/** 把一份楼层快照(可能是旧格式)按当前结构重建: 旧字段名迁移、废弃字段丢弃、缺字段补缺省 */
function sanitizeSnapshot(snapshot: Record<string, any>): WorldData {
  const data = emptyData();
  if (snapshot.世界 && typeof snapshot.世界 === 'object') {
    data.世界 = {
      时间: String(snapshot.世界.时间 ?? ''),
      氛围: String(snapshot.世界.氛围 ?? ''),
      // 旧快照的「大势」(一句话) 迁移为「总览」
      总览: String(snapshot.世界.总览 ?? snapshot.世界.大势 ?? ''),
    };
  }
  {
    const 活跃 = Array.isArray(snapshot.事件) ? 重建事件(snapshot.事件) : [];
    const 新墓碑 = Array.isArray(snapshot.已了结) ? 重建事件(snapshot.已了结) : [];
    // 旧格式迁移: 旧快照的墓碑混在「事件」里, 这里分流出去(不然它们下一轮会被当成活跃事件发给 AI);
    // 新格式的「事件」里没有墓碑, 第二个 filter 自然为空, 不会重复
    data.事件 = 活跃.filter(event => event.阶段 !== '已结束');
    data.已了结 = [...新墓碑, ...活跃.filter(event => event.阶段 === '已结束')].slice(-ENDED_EVENT_LIMIT);
  }
  // 势力与五层档案: 字段清单 / 缺省 / 旧字段名迁移 一律照 世界字段表.ts(候选 4 起不在这里手抄字段名)
  if (snapshot.势力 && typeof snapshot.势力 === 'object' && !Array.isArray(snapshot.势力)) {
    for (const [name, faction] of Object.entries(snapshot.势力) as [string, Record<string, unknown>][]) {
      // 旧快照迁移: v1.7 前的势力缺 前情/领地/对外关系, 缺省补空串(领地 → 势力范围); 「对主角态度」已废弃, 丢弃
      if (faction && typeof faction === 'object') data.势力[name] = 规范化条目<WorldFaction>(取层('势力'), faction);
    }
  }
  if (snapshot.地域 && typeof snapshot.地域 === 'object' && !Array.isArray(snapshot.地域)) {
    for (const [name, region] of Object.entries(snapshot.地域) as [string, Record<string, unknown>][]) {
      if (region && typeof region === 'object') data.地域[name] = 规范化条目<WorldRegion>(取层('地域'), region);
    }
  }
  if (snapshot.大势 && typeof snapshot.大势 === 'object' && !Array.isArray(snapshot.大势)) {
    for (const [name, trend] of Object.entries(snapshot.大势) as [string, Record<string, unknown>][]) {
      if (trend && typeof trend === 'object') data.大势[name] = 规范化条目<WorldTrend>(取层('大势'), trend);
    }
  }
  if (Array.isArray(snapshot.伏笔)) {
    data.伏笔 = snapshot.伏笔
      .filter((item: unknown) => !!item && typeof item === 'object')
      .map((seed: Record<string, unknown>) => 规范化条目<WorldSeed>(取层('伏笔'), seed));
  }
  if (Array.isArray(snapshot.节令)) {
    data.节令 = snapshot.节令
      .filter((item: unknown) => !!item && typeof item === 'object')
      .map((occasion: Record<string, unknown>) => 规范化条目<WorldOccasion>(取层('节令'), occasion));
  }
  if (snapshot.指标 && typeof snapshot.指标 === 'object' && !Array.isArray(snapshot.指标)) {
    for (const [name, metric] of Object.entries(snapshot.指标) as [string, Record<string, unknown>][]) {
      if (metric && typeof metric === 'object') data.指标[name] = 规范化条目<WorldMetric>(取层('指标'), metric);
    }
  }
  data.小结 = String(snapshot.小结 ?? '');
  if (snapshot.统计 && typeof snapshot.统计 === 'object') {
    data.统计 = { 推进次数: Number(snapshot.统计.推进次数 ?? 0) || 0, 最后推进: Number(snapshot.统计.最后推进 ?? 0) || 0 };
  }
  return data;
}

/**
 * 读取烟火当前世界状态: 从最新快照楼层往前找第一份**有效**快照。
 * - 楼层不存在(被删) → 快照随之消亡, 从索引清理, 继续往前;
 * - 楼层变量里没有快照(如重roll产生的新swipe页) → 继续往前;
 * - 楼层内容hash与快照记录不一致(楼层被编辑) → 该快照作废, 继续往前;
 * 命中或扫尽后返回状态; 一个快照都没有时返回空状态(清空层仍生效)。
 */
export function loadData(): WorldData {
  try {
    const meta = loadMeta();
    const floors = [...meta.快照楼层].sort((a, b) => a - b);
    // 聊天尚未加载完时(拿不到有效末层)不清理索引也不误判快照丢失, 先按空状态展示,
    // 等聊天就绪后的补读/事件刷新再载入真实数据
    let lastId = -1;
    try {
      lastId = useHost().chat.lastMessageId();
    } catch {
      lastId = -1;
    }
    console.info(`[烟火] loadData: 快照楼层=[${floors.join(',')}] lastId=${lastId}`);
    // 拿不到末层 = 聊天尚未打开/加载: 不清理索引, 按空状态展示, 等补读或事件刷新
    if (floors.length > 0 && lastId < 0) {
      return { ...emptyData(), 清空层: meta.清空层 };
    }
    const missingFloors: number[] = [];
    let result: WorldData | null = null;
    for (let i = floors.length - 1; i >= 0; i--) {
      const floorId = floors[i];
      // 楼层号超过当前末层 = 楼层真的被删除了, 快照随之消亡, 从索引清理
      if (floorId > lastId) {
        missingFloors.push(floorId);
        continue;
      }
      let message = null;
      try {
        message = useHost().chat.messages(floorId)[0] ?? null;
      } catch {
        message = null;
      }
      if (!message) {
        // 楼层在末层之内却读不到内容: 多半是聊天仍在加载中, 跳过该层且**绝不清理索引**,
        // 等聊天就绪后的补读/事件刷新自然读回 (此前在这里误删索引, 导致世界状态"消失")
        continue;
      }
      let snapshot = null;
      try {
        snapshot = useHost().vars.get({ type: 'message', message_id: floorId })?.[STORAGE_KEY] ?? null;
      } catch {
        snapshot = null;
      }
      if (!snapshot || typeof snapshot !== 'object' || snapshot.楼层 !== floorId) {
        console.info(`[烟火] loadData: 楼层 #${floorId} 无快照或楼层号不符`);
        continue;
      }
      // 楼层hash校验已移除(与彼方 v4.6 同步): 主AI楼层在烟火快照写入后仍会变动(流式收尾/
      // 正则脚本后处理/世界书格式追加等), hash失配会把"正常游玩"误判为"楼层被编辑"导致
      // 每轮回退空状态。快照有效性只按"楼层存在+快照键匹配"判定, 内容变了用户可手动重推。
      result = { ...sanitizeSnapshot(snapshot), 锚点楼层: floorId, 处理到楼层: Number(snapshot.处理到楼层 ?? 0) || 0, 清空层: meta.清空层 };
      break;
    }
    if (missingFloors.length > 0) {
      meta.快照楼层 = meta.快照楼层.filter(floor => !missingFloors.includes(floor));
      saveMeta(meta);
    }
    return result ?? { ...emptyData(), 清空层: meta.清空层 };
  } catch (error) {
    console.warn('[烟火] 读取世界状态失败, 使用空状态:', error);
    return emptyData();
  }
}

/** 构造楼层快照数据(楼层不存在时返回 null); v1.8 起楼层 hash 校验已移除, 不再写入 */
function buildSnapshotPayload(data: WorldData, anchorFloor: number, processedFloor: number) {
  let message = null;
  try {
    message = useHost().chat.messages(anchorFloor)[0] ?? null;
  } catch {
    message = null;
  }
  if (!message) return null;
  return {
    版本: DATA_VERSION,
    楼层: anchorFloor,
    处理到楼层: processedFloor,
    世界: klona(data.世界),
    地域: klona(data.地域 ?? {}),
    大势: klona(data.大势 ?? {}),
    伏笔: klona(data.伏笔 ?? []),
    节令: klona(data.节令 ?? []),
    指标: klona(data.指标 ?? {}),
    事件: klona(data.事件),
    已了结: klona(data.已了结 ?? []),
    势力: klona(data.势力),
    小结: data.小结 ?? '',
    统计: { 推进次数: data.统计?.推进次数 ?? 0, 最后推进: data.统计?.最后推进 ?? 0 },
  };
}

/** 把快照整体写入楼层变量(当前swipe页): 整体赋值该键避免深合并残留, 同楼层其他键(其他脚本的变量)不动 */
function writeFloorVariables(payload: Record<string, any>) {
  useHost().vars.update(variables => {
    variables[STORAGE_KEY] = payload;
    return variables;
  }, { type: 'message', message_id: payload.楼层 });
}

/** 本次写入允许保留的份数: 由设置「运转.快照保留份数」决定(1–100), 读不到设置就用默认值 */
function snapshotLimit(): number {
  let limit = SNAPSHOT_LIMIT;
  try {
    const configured = getSettings().运转.快照保留份数;
    if (Number.isFinite(configured) && configured >= 1) limit = Math.min(100, Math.round(configured));
  } catch {
    // 设置读取失败用默认值
  }
  return limit;
}

/**
 * 把世界状态整体写成一份楼层快照, 存到 `anchorFloor` 楼层的楼层变量里(当前swipe页),
 * 并维护聊天变量里的快照楼层索引 + 物理清理超额的更早快照(保留份数由设置「运转.快照保留份数」控制)。
 *
 * 这是最底层的写入口, 调用方通常不必直接用: 界面手改走 saveData, 推进一轮走 保存推进结果
 * (那里替你交代了「处理到楼层」与「清空层」)。
 *
 * @param data 要持久化的世界状态
 * @param anchorFloor 快照锚定的楼层号(快照随该楼层存亡)
 * @param processedFloor 「已推进到哪条楼层」(写进 payload, 读回时还给上层的进度)
 * @param consumeClearLayer 成功写入后是否把「清空层」清零(推进成功后清零 = 清空层只在清空后的首次推进生效)
 * @param metaInput 调用方已持有的元数据; 不传则内部读取
 */
export function writeStateSnapshot(data: WorldData, anchorFloor: number, processedFloor: number, consumeClearLayer: boolean, metaInput: ChatMeta | null = null): boolean {
  const meta = metaInput ?? loadMeta();
  const payload = buildSnapshotPayload(data, anchorFloor, processedFloor);
  if (!payload) {
    console.warn(`[烟火] 楼层 #${anchorFloor} 不存在, 无法保存快照`);
    return false;
  }
  try {
    writeFloorVariables(payload);
  } catch (error) {
    console.error(`[烟火] 写入楼层快照失败(楼层 #${anchorFloor}):`, error);
    return false;
  }
  // 维护索引(同层重推时去重替换)并物理清理超额快照(保留份数由设置「运转.快照保留份数」控制, 默认 SNAPSHOT_LIMIT)
  meta.快照楼层 = meta.快照楼层.filter(floor => floor !== anchorFloor);
  meta.快照楼层.push(anchorFloor);
  meta.快照楼层.sort((a, b) => a - b);
  const limit = snapshotLimit();
  while (meta.快照楼层.length > limit) {
    const removed = meta.快照楼层.shift();
    try {
      useHost().vars.del(STORAGE_KEY, { type: 'message', message_id: removed });
    } catch {
      // 楼层可能已不存在, 忽略
    }
  }
  if (consumeClearLayer) meta.清空层 = 0;
  saveMeta(meta);
  console.info(`[烟火] 快照写入楼层 #${anchorFloor} (事件=${payload.事件.length}件, 势力=${Object.keys(payload.势力).length}个, 保留${meta.快照楼层.length}/${limit}份, 保留楼层=[${meta.快照楼层.join(',')}])`);
  return true;
}

/** 保存当前世界状态(界面手动编辑用): 以最新楼层为锚点写入快照, 不改变「已推进到哪」的进度。
 *  返回是否真的写进了楼层——写不进去(楼层已被删除、锚点取不到)时界面要如实说, 不能报"已保存"。 */
export function saveData(data: WorldData): boolean {
  try {
    const anchor = useHost().chat.lastMessageId();
    return writeStateSnapshot(data, anchor, typeof data.处理到楼层 === 'number' ? data.处理到楼层 : 0, false);
  } catch (error) {
    console.error('[烟火] 保存世界状态失败:', error);
    toastError(`烟火: 保存失败 ${error instanceof Error ? error.message : String(error)}`, '烟火');
    return false;
  }
}

/**
 * 一轮推进跑完之后的落盘。推进与"界面手改"的差别都收在这里:
 * - 锚点 = 本次分析的最后一条回复楼层, 且**「处理到楼层」取自锚点**(推进的语义就是"这一轮分析到这条回复为止"),
 *   不像 saveData 那样沿用 data 里的进度;
 * - 落盘成功才消费「清空层」(清空只在清空后的第一次推进生效), 并把内存那一份的「锚点楼层」补齐。
 *
 * 返回的「数据」就是该放进内存/界面的那一份 —— 调用方不必再管成功/失败两条分支怎么拼。
 */
export function 保存推进结果(data: WorldData, 锚点楼层: number): 存档结果 {
  data.处理到楼层 = 锚点楼层;
  data.清空层 = 0;
  const 落盘 = writeStateSnapshot(data, 锚点楼层, 锚点楼层, true);
  return {
    落盘,
    锚点楼层: 落盘 ? 锚点楼层 : -1,
    数据: 落盘 ? { ...data, 锚点楼层 } : data,
    说明: 落盘
      ? `世界状态已存进楼层 #${锚点楼层}`
      : `楼层 #${锚点楼层} 写不进去, 快照没落盘`,
  };
}

/** 撤销指定楼层的快照(手动「重新推进」用): 从索引移除并物理删除, 状态自动回落到更早楼层 */
export function discardSnapshotAt(floorId: number): boolean {
  const meta = loadMeta();
  if (!meta.快照楼层.includes(floorId)) return false;
  meta.快照楼层 = meta.快照楼层.filter(floor => floor !== floorId);
  saveMeta(meta);
  try {
    useHost().vars.del(STORAGE_KEY, { type: 'message', message_id: floorId });
  } catch {
    // 楼层可能已不存在, 忽略
  }
  console.info(`[烟火] 已撤销楼层 #${floorId} 的快照`);
  return true;
}

/**
 * 重推的前半步: 撤销锚点楼层的快照, 再把状态重新读回来(于是自动回落到更早楼层的快照)。
 * 「先撤销、再读回」这个顺序以前是调用方必须记住的知识, 现在收在这里, 顺序不会再被写反。
 */
export function 撤销快照并重读(floorId: number): WorldData {
  discardSnapshotAt(floorId);
  return loadData();
}

/** 清空全部烟火数据: 物理删除所有楼层的快照 + 重置元数据, 并记录当前楼层为「清空层」 */
export function clearAllData(): number {
  const meta = loadMeta();
  for (const floorId of meta.快照楼层) {
    try {
      useHost().vars.del(STORAGE_KEY, { type: 'message', message_id: floorId });
    } catch {
      // 楼层可能已不存在, 忽略
    }
  }
  const fresh = emptyMeta();
  try {
    fresh.清空层 = useHost().chat.lastMessageId();
  } catch {
    // 读取失败时保持 0, 退化为全量分析
  }
  saveMeta(fresh);
  return fresh.清空层;
}

// ---------------------------------------------------------------------------
// 接口: 门面
// ---------------------------------------------------------------------------

/**
 * 一次落盘的结果: 界面 / 内存 / 元数据三处要一致, 所以连"该放进内存的那一份"一起交回。
 * 失败时也要如实交回(界面据此说"没能写进楼层"), 不能只回一个布尔。
 */
export interface 存档结果 {
  /** 是否真的写进了楼层(写不进去时界面要如实说, 不能报"已保存") */
  落盘: boolean;
  /** 落盘成功时的快照锚点楼层; 失败为 -1 */
  锚点楼层: number;
  /** 该放进内存/界面的那一份(落盘成功时已补上「锚点楼层」; 失败时就是传进来那一份) */
  数据: WorldData;
  /** 一句话说明这次落到了哪里(供界面提醒与日志用) */
  说明: string;
}

/**
 * 世界状态存档: 这一层对外的一处可看之处。
 * 想看"世界状态是怎么存、怎么读回来的", 看这一个对象就够了; 单个函数也照旧导出,
 * 因为既有调用方与用例是直接 import 它们的(state.ts 原样转出去)。
 */
export const 世界状态存档 = {
  /** 读回当前世界状态(从最新快照往前找第一份有效的) */
  读取: loadData,
  /** 界面手改后的保存: 以最新楼层为锚点, 不动「已推进到哪」 */
  保存: saveData,
  /** 推进一轮之后的落盘: 锚点 = 本次分析的最后一条楼层, 成功消费清空层 */
  推进落盘: 保存推进结果,
  /** 重推: 撤销锚点快照并重新读回(顺序收在里面) */
  重推: 撤销快照并重读,
  /** 撤销指定楼层的快照 */
  撤销楼层: discardSnapshotAt,
  /** 清空全部数据, 返回新的「清空层」 */
  清空: clearAllData,
};
