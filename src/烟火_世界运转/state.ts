import { klona } from 'klona';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useHost } from './host';
import { getSettings } from './settings';
import type { EventEvolution, WorldData, WorldEvent, WorldInfo, WorldFaction, WorldMetric, WorldOccasion, WorldRegion, WorldSeed, WorldTrend } from './schema';
import { EVENT_SCALE, EVENT_SECRECY, EVENT_SPREAD, EVENT_STAGE } from './schema';
import { toastError } from './toast';
import { 取层, 规范化条目 } from './世界字段表';

export const STORAGE_KEY = '烟火';
export const DATA_VERSION = 1;
/** 烟火写入角色卡主世界书的常驻条目名(用于识别、更新与排除)。
 * 注意: 数据库脚本(ACU)剧情推进会屏蔽名字含"状态/规则/变量/检定/叙事"等关键词的条目, 条目名必须避开这些词 */
export const WORLDBOOK_ENTRY_NAME = '【烟火】世界动向';
/** 悬浮球位置/主题等界面偏好(全局变量键) */
export const UI_KEY = '烟火_界面';
/** 楼层快照的默认保留份数(设置「运转.快照保留份数」可调): 写入新快照时把更早楼层的快照物理删除, 防止聊天文件随楼层无限膨胀 */
export const SNAPSHOT_LIMIT = 10;
/** 事件清单与势力清单的容量上限 */
export const EVENT_LIMIT = 30;
/** 已结束事件的保留条数(超出后丢最旧的): 注入只发未结束事件, 但面板与快照会被旧事件越拖越长 */
export const ENDED_EVENT_LIMIT = 6;
/** 五层常驻档案(地域/大势/伏笔/节令/指标)与势力的容量上限现在只在 世界字段表.ts 里写一处(候选 4),
 *  这里原样转出去给原有调用方(世界数据.ts / 世界数据变更.ts / prompts.ts / 用例都从 state 取) */
export { FACTION_LIMIT, METRIC_LIMIT, OCCASION_LIMIT, REGION_LIMIT, SEED_LIMIT, TREND_LIMIT } from './世界字段表';
/** 单个事件演变流水的保留条数(最新在后, 超出裁掉最旧的) */
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
    势力: {},
    小结: '',
    统计: { 推进次数: 0, 最后推进: 0 },
    锚点楼层: -1,
    处理到楼层: 0,
    清空层: 0,
  };
}

interface ChatMeta {
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
  if (Array.isArray(snapshot.事件)) {
    data.事件 = snapshot.事件
      .filter((item: unknown): item is WorldEvent => !!item && typeof item === 'object' && typeof (item as WorldEvent).标题 === 'string')
      // 显式重建: 旧快照的 知晓/迫近 已废弃, 不随展开带进新结构
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

/**
 * 把世界状态整体写成一份楼层快照, 存到 `anchorFloor` 楼层的楼层变量里(当前swipe页),
 * 并维护聊天变量里的快照楼层索引 + 物理清理超额的更早快照(保留份数由设置「运转.快照保留份数」控制)。
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
  let snapshotLimit = SNAPSHOT_LIMIT;
  try {
    const configured = getSettings().运转.快照保留份数;
    if (Number.isFinite(configured) && configured >= 1) snapshotLimit = Math.min(100, Math.round(configured));
  } catch {
    // 设置读取失败用默认值
  }
  while (meta.快照楼层.length > snapshotLimit) {
    const removed = meta.快照楼层.shift();
    try {
      useHost().vars.del(STORAGE_KEY, { type: 'message', message_id: removed });
    } catch {
      // 楼层可能已不存在, 忽略
    }
  }
  if (consumeClearLayer) meta.清空层 = 0;
  saveMeta(meta);
  console.info(`[烟火] 快照写入楼层 #${anchorFloor} (事件=${payload.事件.length}件, 势力=${Object.keys(payload.势力).length}个, 保留${meta.快照楼层.length}/${snapshotLimit}份, 保留楼层=[${meta.快照楼层.join(',')}])`);
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
// Pinia stores
// ---------------------------------------------------------------------------

export const useStateStore = defineStore('yanhuo-state', () => {
  const data = ref<WorldData>(loadData());
  function reload() {
    data.value = loadData();
  }
  function save() {
    saveData(data.value);
  }
  return { data, reload, save };
});

export interface DebugLog {
  time: number;
  model: string;
  replyIds: number[];
  replyPreview: string;
  addedEvents: string[];
  updatedEvents: string[];
  removedEvents: string[];
  summary: string;
  request: string;
  response: string;
  error: string;
}

export const useDebugStore = defineStore('yanhuo-debug', () => {
  const log = ref<DebugLog | null>(null);
  function record(partial: Partial<DebugLog>) {
    const base = {
      time: 0,
      model: '',
      replyIds: [] as number[],
      replyPreview: '',
      addedEvents: [] as string[],
      updatedEvents: [] as string[],
      removedEvents: [] as string[],
      summary: '',
      request: '',
      response: '',
      error: '',
    };
    log.value = { ...base, ...(log.value ?? {}), ...partial, time: partial.time ?? Date.now() };
  }
  function clear() {
    log.value = null;
  }
  return { log, record, clear };
});

/** 捕获烟火脚本自身的 console 输出, 让日志页可见(不再只进控制台) */
export const useConsoleStore = defineStore('yanhuo-console', () => {
  const lines = ref<{ time: number; type: string; text: string }[]>([]);
  function record(type: string, ...args: unknown[]) {
    const text = args
      .map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    lines.value.push({ time: Date.now(), type, text });
    if (lines.value.length > 300) lines.value = lines.value.slice(-300);
  }
  function clear() {
    lines.value = [];
  }
  return { lines, record, clear };
});

/** 给烟火脚本的 console 方法挂上记录(不改变原始输出) */
export function captureConsole() {
  try {
    const store = useConsoleStore();
    const types = ['log', 'warn', 'error', 'info'] as const;
    for (const type of types) {
      const original = console[type];
      console[type] = (...args: unknown[]) => {
        try {
          store.record(type, ...args);
        } catch {
          // 记录失败不影响原始输出
        }
        return original.apply(console, args);
      };
    }
  } catch {
    // 忽略
  }
}

/** 烟火后台任务状态与中断控制(供界面显示弹窗、取消请求) */
export const useUpdatingStore = defineStore('yanhuo-updating', () => {
  const active = ref(false);
  const message = ref('');
  const controller = ref<AbortController | null>(null);
  function start(text: string): AbortSignal {
    const abort = new AbortController();
    if (controller.value) controller.value.abort();
    controller.value = abort;
    active.value = true;
    message.value = text;
    return abort.signal;
  }
  function cancel() {
    controller.value?.abort();
  }
  function stop() {
    controller.value = null;
    active.value = false;
    message.value = '';
  }
  return { active, message, start, cancel, stop };
});

// ---------------------------------------------------------------------------
// 世界信息辅助
// ---------------------------------------------------------------------------

export function emptyWorldInfo(): WorldInfo {
  return { 时间: '', 氛围: '', 总览: '' };
}
