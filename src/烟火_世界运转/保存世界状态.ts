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
import { 判定结果表, 是传讯速度, 迁移旧键名, type 传讯速度 } from './schema';
import { getSettings } from './settings';
import { toastError } from './toast';
// 墓碑上限与五层容量同一处(世界字段表): 这里不引 state.ts —— 它反过来依赖本模块, 会成环
import { 取层, 规范化事件字段, 规范化条目 } from './世界字段表';
// 楼层快照的索引/有效性/护栏已抽到共用层（2026-11-20 C1）。
// ⚠ **只接了读路径**：写入路径有"提交号 + 前一快照 + 失败回滚"那套协议，内核没有。
import { 取最新有效 } from '../共用/楼层快照';
import type { 快照存储 } from '../共用/楼层快照';

export const STORAGE_KEY = '烟火';
export const DATA_VERSION = 2;
/** 楼层快照的默认保留份数(设置「运转.快照保留份数」可调): 写入新快照时把更早楼层的快照物理删除, 防止聊天文件随楼层无限膨胀 */
export const SNAPSHOT_LIMIT = 10;

// ---------------------------------------------------------------------------
// 归档池(v2.9.6): 墓碑 / 失效暗线 / 过期日程 只存一份
// ---------------------------------------------------------------------------
//
// 以前每份楼层快照都带着全部归档, 归档只增不减, × 快照保留份数(默认 10) —— 300 轮约 2MB 存在聊天文件里。
// 现在归档内容放进聊天变量 `烟火_归档` 的池子(按内容指纹存), 快照只记引用清单(`已结束引用` 等)。
//   · 删楼回退照旧: "那一刻哪些事算已结束"由那份快照的引用清单决定, 不由池子决定;
//   · 池子只增不删(切回旧 swipe 页时那一页的快照引用什么, 从当前页看不到, 删了可能删掉它要的);
//     代价是被回退/重 roll 掉的归档会作为孤儿留在池里, 通常很少。清空世界时整池删除;
//   · 写入顺序: 先池 → 再楼层快照 → 最后索引。任一步失败最多在池里留孤儿, 不会出现"快照引用了池里没有的东西";
//   · 万一引用找不到(手动删过聊天变量之类), 那一条丢弃并在控制台报一句, 不让整份快照读失败;
//   · 旧快照里直接内嵌的归档数组照常读; 之后写的新快照才改用引用。
export const ARCHIVE_KEY = '烟火_归档';
type 归档池 = Record<string, unknown>;

/** 稳定序列化: 键排序, 同内容不同键序得到同一串 */
function 稳定串(值: unknown): string {
  if (Array.isArray(值)) return `[${值.map(稳定串).join(',')}]`;
  if (值 && typeof 值 === 'object') {
    return `{${Object.keys(值).sort().map(键 => `${JSON.stringify(键)}:${稳定串((值 as Record<string, unknown>)[键])}`).join(',')}}`;
  }
  return JSON.stringify(值 ?? null);
}

/** 64 位内容指纹(两路 32 位 FNV 式散列); 撞了由 入池 加后缀区分, 正确性不靠它不撞 */
function 指纹(文本: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < 文本.length; i++) {
    const c = 文本.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 = (h2 ^ (h2 >>> 15)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** 把一组归档放进池: 返回引用清单与本次要新写进池的条目(已有同内容的不重写) */
export function 入池(前缀: string, 条目们: readonly unknown[], 池: 归档池): { 引用: string[]; 新增: 归档池 } {
  const 引用: string[] = [];
  const 新增: 归档池 = {};
  for (const 条目 of 条目们) {
    const 串 = 稳定串(条目);
    const 根 = `${前缀}${指纹(串)}`;
    let 键 = 根;
    for (let n = 2; ; n++) {
      const 已有 = 键 in 新增 ? 新增[键] : 池[键];
      if (已有 === undefined || 稳定串(已有) === 串) break;
      键 = `${根}-${n}`;
    }
    if (池[键] === undefined && 新增[键] === undefined) 新增[键] = klona(条目);
    引用.push(键);
  }
  return { 引用, 新增 };
}

export function 读归档池(): 归档池 {
  try {
    const 池 = useHost().vars.get({ type: 'chat' })?.[ARCHIVE_KEY]?.条目;
    return 池 && typeof 池 === 'object' && !Array.isArray(池) ? 池 : {};
  } catch (error) {
    console.warn('[烟火] 归档池暂不可读:', error);
    return {};
  }
}

function 写归档池(新增: 归档池): boolean {
  if (!Object.keys(新增).length) return true;
  try {
    useHost().vars.update(variables => {
      const 旧 = variables?.[ARCHIVE_KEY]?.条目;
      const 条目 = { ...(旧 && typeof 旧 === 'object' ? 旧 : {}), ...klona(新增) };
      return { ...variables, [ARCHIVE_KEY]: { 版本: 1, 条目 } };
    }, { type: 'chat' });
    return true;
  } catch (error) {
    console.error('[烟火] 归档池写入失败, 本次快照不提交:', error);
    return false;
  }
}

/** 快照里的一组归档: 有引用清单就按池解引用(缺的记进 缺失), 否则读旧格式的内嵌数组 */
function 取归档(snapshot: Record<string, any>, 内嵌键: string, 引用键: string, 池: 归档池, 缺失: string[]): unknown[] | null {
  if (Array.isArray(snapshot[引用键])) {
    return snapshot[引用键].flatMap((键: unknown) => {
      if (typeof 键 !== 'string') return [];
      const 条目 = 池[键];
      if (条目 === undefined) { 缺失.push(键); return []; }
      return [klona(条目)];
    });
  }
  return Array.isArray(snapshot[内嵌键]) ? snapshot[内嵌键] : null;
}
// 2026-11-22 删除 EVENT_HISTORY_LIMIT(原值 8): 2026-11-02 起演变按项目纪律**完整保留、不裁条数**,
// 这个常量从那时起就没有任何地方在用, 注释却还写着"读回时裁到 8 条" —— 与代码相反。
// 演变无上限是有意的; 快照体积随之增长(× 快照保留份数), 真成问题时另议归档方案, 不要只在一处补 slice:
// 到期判定.ts 的"展开了"已改成比最后一步(对上限免疫); 但 节奏.ts 反推"上次新增时间"用的是**第一步**演变,
// 传播.ts 推算"听到哪一步"要看全部步 —— 加上限前这两处都得先改。

// ---------------------------------------------------------------------------
// 存储结构 (v1), 与彼方 v4.3 同款:
// - 聊天变量 `烟火` 只存轻量元数据: 哪些楼层有快照(索引) + 清空层
// - 世界状态本体(世界/事件/组织/小结/统计)整体存在**楼层变量**里, 每次推进写入本次
//   分析的最后一条楼层。快照随楼层存亡——删除楼层/重roll(新swipe页没有快照)时状态
//   自动回退到更早楼层的快照。v1.8 起楼层 hash 校验已移除(流式收尾/正则后处理会
//   让楼层内容在快照写入后再变动, hash 失配会把正常游玩误判为"被编辑")。
// ---------------------------------------------------------------------------

export function emptyData(): WorldData {
  return {
    版本: DATA_VERSION,
    世界: { 时间: '', 氛围: '', 总览: '' },
    地区: {},
    形势: {},
    暗线: [],
    日程: [],
    指标: {},
    事件: [],
    // 墓碑桶: 只由代码维护(见 sanitizeSnapshot 的旧格式分流与 世界数据.ts 的双桶合并)
    已结束: [],
    组织: {},
    小结: '',
    统计: { 推进次数: 0, 最后推进: 0 },
    锚点楼层: -1,
    处理到楼层: 0,
    清空层: 0,
    清空截止: null,
    修订: 0,
    世代: 0,
    处理签名: '',
  };
}

/** 聊天变量里的轻量元数据: 快照楼层索引 + 清空层(世界状态本体不在这里) */
export interface ChatMeta {
  版本: number;
  快照楼层: number[];
  清空层: number;
  清空截止?: number | null;
  修订?: number;
  世代?: number;
  提交?: Record<string, string>;
  /** 本聊天的传讯速度(v2.9.2): 聊天级设定, 不随楼层快照走, 清空世界也保留 */
  传讯速度?: 传讯速度;
}

function emptyMeta(): ChatMeta {
  return { 版本: DATA_VERSION, 快照楼层: [], 清空层: 0, 清空截止: null, 修订: 0, 世代: 0, 提交: {} };
}

function saveMeta(meta: ChatMeta): boolean {
  try {
    useHost().vars.update(variables => ({ ...variables, [STORAGE_KEY]: klona(meta) }), { type: 'chat' });
    return true;
  } catch (error) {
    console.error('[烟火] 保存元数据失败:', error);
    return false;
  }
}

function loadMeta(strict = false): ChatMeta {
  try {
    const raw = useHost().vars.get({ type: 'chat' })?.[STORAGE_KEY];
    if (raw == null) return emptyMeta();
    if (typeof raw !== 'object' || Array.isArray(raw)) throw Error('烟火聊天索引格式错误');
    const 清空层 = Number.isFinite(raw.清空层) ? raw.清空层 : 0;
    return {
      版本: DATA_VERSION,
      快照楼层: Array.isArray(raw.快照楼层) ? raw.快照楼层.filter((floor: unknown) => typeof floor === 'number' && Number.isFinite(floor)) : [],
      清空层,
      清空截止: raw.清空截止 === null ? null : Number.isFinite(raw.清空截止) ? raw.清空截止 : 清空层 > 0 ? 清空层 : null,
      修订: Number.isFinite(raw.修订) ? raw.修订 : 0,
      世代: Number.isFinite(raw.世代) ? raw.世代 : 0,
      提交: raw.提交 && typeof raw.提交 === 'object' && !Array.isArray(raw.提交) ? { ...raw.提交 } : {},
      ...(是传讯速度(raw.传讯速度) && raw.传讯速度 !== '未选' ? { 传讯速度: raw.传讯速度 } : {}),
    };
  } catch (error) {
    if (strict) throw error;
    console.warn('[烟火] 聊天索引暂不可读，未清理已有快照:', error);
    return emptyMeta();
  }
}

/** 无分支能力的旧测试适配器按0页；真实宿主必须能够读取当前swipe。 */
function 当前分支(floor: number): number {
  return useHost().chat.currentSwipe?.(floor) ?? 0;
}
function 分支键(floor: number): string {
  return `${floor}:${当前分支(floor)}`;
}
function 元数据字段(meta: ChatMeta) {
  return { 清空层: meta.清空层, 清空截止: meta.清空截止 ?? null, 修订: meta.修订 ?? 0, 世代: meta.世代 ?? 0,
    // 只在选过时才带出(旧数据形状不变)
    ...(meta.传讯速度 ? { 传讯速度: meta.传讯速度 } : {}) };
}

export interface 楼层归属 {
  聊天: string | null;
  楼层: number;
  分支: number;
  正文: string;
  修订: number;
  世代: number;
}
export function 绑定楼层(floor: number): 楼层归属 {
  const host = useHost();
  const message = host.chat.messages(floor)[0];
  if (!message) throw Error(`楼层 #${floor} 不存在`);
  const meta = loadMeta(true);
  return { 聊天: host.chat.currentChatId?.() ?? null, 楼层: floor, 分支: 当前分支(floor), 正文: message.message, 修订: meta.修订 ?? 0, 世代: meta.世代 ?? 0 };
}
export function 归属仍有效(origin: 楼层归属): boolean {
  try {
    const host = useHost();
    const meta = loadMeta(true);
    return (host.chat.currentChatId?.() ?? null) === origin.聊天
      && 当前分支(origin.楼层) === origin.分支
      && host.chat.messages(origin.楼层)[0]?.message === origin.正文
      && (meta.修订 ?? 0) === origin.修订 && (meta.世代 ?? 0) === origin.世代;
  } catch { return false; }
}

/** 索引是接受闸。覆盖同层后若索引提交失败，只能回到前一个已接受版本。 */
function 已接受快照(snapshot: any, meta: ChatMeta, key: string): any | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const expected = meta.提交?.[key];
  if (!snapshot.提交号) return expected ? null : snapshot;
  if (snapshot.提交号 === expected) return snapshot;
  const previous = snapshot.前一快照;
  if (!previous) return null;
  if (!previous.提交号 && !expected) return previous;
  return previous.提交号 === expected ? previous : null;
}

/** 重建一条事件(旧快照的 知晓/迫近 已废弃, 不随展开带进新结构)。
 *  字段方言走 世界字段表.事件层的「快照」模式: 不认 AI 别名、不填新默认值、时间不回落世界时间。 */
function 重建事件(列表: unknown[]): WorldEvent[] {
  const 结果: WorldEvent[] = [];
  for (const item of 列表) {
    if (!item || typeof item !== 'object') continue;
    const 原 = item as WorldEvent;
    const 字段 = 规范化事件字段(原 as unknown as Record<string, unknown>, '快照');
    if (!字段) continue;
    结果.push({
      id: String(原.id ?? ''),
      ...(字段 as unknown as Omit<WorldEvent, 'id' | '演变'>),
      ...Object.fromEntries((['结束原因', '等待条件', '下次判定时间'] as const).filter(key => typeof 原[key] === 'string').map(key => [key, 原[key]])),
      // v2.9.3 到期判定: 脚本独占字段, 形状对才带(到期是字符串、结果是三选一), 否则丢弃 —— 下一轮到期会重掷
      ...(原.判定 && typeof 原.判定 === 'object' && typeof 原.判定.到期 === 'string' && 判定结果表.includes(原.判定.结果)
        ? { 判定: { 到期: 原.判定.到期, 结果: 原.判定.结果 } }
        : {}),
      演变: Array.isArray(原.演变)
        ? 原.演变
            .filter((step): step is EventEvolution => !!step && typeof step === 'object' && typeof step.变化 === 'string')
            .map(step => ({ 时间: String(step.时间 ?? ''), 变化: String(step.变化) }))
        : [],
    });
  }
  return 结果;
}

/** 重建一组暗线。字段走 世界字段表.暗线层, 但那张表里没有「结束原因」(它是终止时才有的可选字段),
 *  直接用 规范化条目 会把终止依据静默丢掉 —— 所以单独补回来(有字符串才带)。 */
function 重建暗线(列表: unknown[]): WorldSeed[] {
  return 列表
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(raw => {
      const seed = 规范化条目<WorldSeed>(取层('暗线'), raw);
      if (typeof raw.结束原因 === 'string' && raw.结束原因) seed.结束原因 = raw.结束原因;
      return seed;
    });
}

/** 把一份楼层快照(可能是旧格式)按当前结构重建: 旧字段名迁移、废弃字段丢弃、缺字段补缺省; 归档引用按池解开 */
function sanitizeSnapshot(原快照: Record<string, any>, 池: 归档池 = {}): WorldData {
  // v2.10.1: 旧层名/旧字段名先搬到新名下(条目里的字段另有 字段表 的 旧名 兜底, 归档池里解出来的条目也走那条)
  const snapshot = 迁移旧键名(原快照);
  const data = emptyData();
  const 缺失: string[] = [];
  const 墓碑源 = 取归档(snapshot, '已结束', '已结束引用', 池, 缺失);
  const 失效暗线源 = 取归档(snapshot, '已失效暗线', '已失效暗线引用', 池, 缺失);
  const 过期日程源 = 取归档(snapshot, '已过期日程', '已过期日程引用', 池, 缺失);
  if (缺失.length) console.warn(`[烟火] 快照引用的 ${缺失.length} 条归档在归档池里找不到, 已略过: ${缺失.slice(0, 5).join(', ')}${缺失.length > 5 ? ' …' : ''}`);
  if (snapshot.世界 && typeof snapshot.世界 === 'object') {
    data.世界 = {
      时间: String(snapshot.世界.时间 ?? ''),
      氛围: String(snapshot.世界.氛围 ?? ''),
      // 旧快照的「大势」(一句话) 迁移为「总览」
      总览: String(snapshot.世界.总览 ?? snapshot.世界.大势 ?? ''),
    };
    // v2.9.1 主角所在: 有非空字符串才带出来(旧快照读回的形状与以前逐字一致)
    const 所在 = typeof snapshot.世界.主角所在 === 'string' ? snapshot.世界.主角所在.trim() : '';
    if (所在) data.世界.主角所在 = 所在;
  }
  {
    const 活跃 = Array.isArray(snapshot.事件) ? 重建事件(snapshot.事件) : [];
    const 新墓碑 = 墓碑源 ? 重建事件(墓碑源) : [];
    // 旧格式迁移: 旧快照的墓碑混在「事件」里, 这里分流出去(不然它们下一轮会被当成活跃事件发给 AI);
    // 新格式的「事件」里没有墓碑, 第二个 filter 自然为空, 不会重复
    data.事件 = 活跃.filter(event => event.阶段 !== '已结束');
    data.已结束 = [...新墓碑, ...活跃.filter(event => event.阶段 === '已结束')];
  }
  // 组织与五层档案: 字段清单 / 缺省 / 旧字段名迁移 一律照 世界字段表.ts(候选 4 起不在这里手抄字段名)
  if (snapshot.组织 && typeof snapshot.组织 === 'object' && !Array.isArray(snapshot.组织)) {
    for (const [name, faction] of Object.entries(snapshot.组织) as [string, Record<string, unknown>][]) {
      // 旧快照迁移: v1.7 前的组织缺 背景/领地/外部关系, 缺省补空串(领地 → 覆盖范围); 「对主角态度」已废弃, 丢弃
      if (faction && typeof faction === 'object') data.组织[name] = 规范化条目<WorldFaction>(取层('组织'), faction);
    }
  }
  if (snapshot.地区 && typeof snapshot.地区 === 'object' && !Array.isArray(snapshot.地区)) {
    for (const [name, region] of Object.entries(snapshot.地区) as [string, Record<string, unknown>][]) {
      if (region && typeof region === 'object') data.地区[name] = 规范化条目<WorldRegion>(取层('地区'), region);
    }
  }
  if (snapshot.形势 && typeof snapshot.形势 === 'object' && !Array.isArray(snapshot.形势)) {
    for (const [name, trend] of Object.entries(snapshot.形势) as [string, Record<string, unknown>][]) {
      if (trend && typeof trend === 'object') data.形势[name] = 规范化条目<WorldTrend>(取层('形势'), trend);
    }
  }
  if (Array.isArray(snapshot.暗线)) data.暗线 = 重建暗线(snapshot.暗线);
  // 2026-11-22 修: 两个归档以前不进快照 —— 每轮提交后 loadData() 读回就丢,
  // 于是"已终止的暗线不许同名复活 / 过期一次性日程不重复归档"这两道去重也跟着失效。
  // 只有快照里真有这一项才带出来(旧快照读回的形状与以前逐字一致)。
  if (失效暗线源?.length) data.已失效暗线 = 重建暗线(失效暗线源);
  if (过期日程源?.length) {
    data.已过期日程 = 过期日程源
      .filter((item: unknown) => !!item && typeof item === 'object')
      .map((occasion: object) => 规范化条目<WorldOccasion>(取层('日程'), occasion as Record<string, unknown>));
  }
  if (Array.isArray(snapshot.日程)) {
    data.日程 = snapshot.日程
      .filter((item: unknown) => !!item && typeof item === 'object')
      .map((occasion: object) => 规范化条目<WorldOccasion>(取层('日程'), occasion as Record<string, unknown>));
  }
  if (snapshot.指标 && typeof snapshot.指标 === 'object' && !Array.isArray(snapshot.指标)) {
    for (const [name, metric] of Object.entries(snapshot.指标) as [string, Record<string, unknown>][]) {
      if (metric && typeof metric === 'object') data.指标[name] = 规范化条目<WorldMetric>(取层('指标'), metric);
    }
  }
  data.小结 = String(snapshot.小结 ?? '');
  if (snapshot.统计 && typeof snapshot.统计 === 'object') {
    data.统计 = { 推进次数: Number(snapshot.统计.推进次数 ?? 0) || 0, 最后推进: Number(snapshot.统计.最后推进 ?? 0) || 0 };
    // v2.9.3 节奏事实: 有非空字符串才带出(旧快照读回的形状不变)
    // v2.10.1 起键名统一成 上次重大事件时间; 旧快照里的 上次大事时间 回落到这里
    const 重大事件时间 = snapshot.统计.上次重大事件时间 ?? snapshot.统计.上次大事时间;
    if (typeof 重大事件时间 === 'string' && 重大事件时间.trim()) data.统计.上次重大事件时间 = 重大事件时间;
    const 新增 = snapshot.统计.上次新增时间;
    if (typeof 新增 === 'string' && 新增.trim()) data.统计.上次新增时间 = 新增;
  }
  // v2.9.0 注入粘性: 只有快照里真有这一项才带出来(旧快照读回的形状与以前逐字一致)
  if (Array.isArray(snapshot.上次注入)) {
    data.上次注入 = snapshot.上次注入.filter((key: unknown): key is string => typeof key === 'string' && key.length > 0);
  }
  return data;
}

/**
 * 读取烟火当前世界状态: 从最新快照楼层往前找第一份**有效**快照。
 * - 楼层不存在(被删) → 快照随之消亡, 从索引清理, 继续往前;
 * - 楼层变量里没有快照(如重roll产生的新swipe页) → 继续往前;
 * - 索引未接受的提交或旧清空世代 → 保留最后已接受版本，或继续往前;
 * 命中或扫尽后返回状态; 一个快照都没有时返回空状态(清空层仍生效)。
 */
export function loadData(excludeFloor = -1): WorldData {
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
      return { ...emptyData(), ...元数据字段(meta) };
    }

    // ── 2026-11-20 C1：索引/有效性/护栏走共用内核 ──
    //
    //  不变量 1/2/3/4 在三家各写过一遍，现在只有一份实现（`共用/楼层快照.ts`）。
    //  **烟火特有的语义通过策略传进去**，内核不碰它们：
    //    · 世代一致（`snapshot.世代 === meta.世代`）
    //    · 已接受快照链（提交号 / 前一快照）
    //    · excludeFloor 与 清空截止
    //
    //  ⚠ **写入路径没接内核**：烟火有一套"提交号 + 前一快照 + 失败回滚"的协议，
    //    内核没有那套东西。硬接会把回滚能力弄丢 —— 那是行为变更，不在本批范围。
    //
    //  ⚠ **`已接受快照` 可能返回"前一快照"而不是传入的那份**（候选被拒时回退到已提交版本）。
    //    原代码 `snapshot = 已接受快照(raw, ...)` 用的是**返回值**，不是原值。
    //    第一版我只判了真假、用了原值 → 读到了未提交的候选（`yanhuo-commit-guard` 当场抓住）。
    const 已接受结果 = new Map<number, any>();
    const 读结果 = 取最新有效(建快照存储(meta), {
      跳过: (楼层) => 楼层 === excludeFloor || (meta.清空截止 != null && 楼层 <= meta.清空截止),
      有效: (载荷, 楼层) => {
        // 世代必须一致
        if ((载荷.世代 ?? 0) !== (meta.世代 ?? 0))
          return false;
        // 提交号协议：只认"已接受"的那份；**把返回值存起来**（它可能是前一快照）
        const 接受 = 已接受快照(载荷, meta, 分支键(楼层));
        if (!接受)
          return false;
        已接受结果.set(楼层, 接受);
        return true;
      },
    });

    if (读结果.载荷) {
      // 内核判出"这些层真的被删了" → 清索引（与原来同一时机）
      if (读结果.已删楼层.length > 0) {
        meta.快照楼层 = meta.快照楼层.filter(楼层 => !读结果.已删楼层.includes(楼层));
        saveMeta(meta);
      }
      // ⚠ 用 `已接受快照` 的返回值（可能是前一快照），不是内核给的原载荷
      const snapshot = 已接受结果.get(读结果.楼层) ?? 读结果.载荷;
      return {
        ...sanitizeSnapshot(snapshot, 读归档池()),
        锚点楼层: 读结果.楼层,
        处理到楼层: Number(snapshot.处理到楼层 ?? 0) || 0,
        处理签名: String(snapshot.处理签名 ?? ''),
        ...元数据字段(meta),
      };
    }

    // 没有命中 → 清掉内核判出的已删楼层，返回空状态
    if (读结果.已删楼层.length > 0) {
      meta.快照楼层 = meta.快照楼层.filter(楼层 => !读结果.已删楼层.includes(楼层));
      saveMeta(meta);
    }
    return { ...emptyData(), ...元数据字段(meta) };
  } catch (error) {
    console.warn('[烟火] 读取世界状态失败, 使用空状态:', error);
    return emptyData();
  }
}

/**
 * 把烟火的宿主接成内核的 `快照存储`（2026-11-20 C1）。
 *
 * ⚠ **只接读路径用**：写入路径有"提交号 + 前一快照 + 失败回滚"那套协议，
 *    内核没有，所以 `writeStateSnapshot` 保持原样。
 */
function 建快照存储(meta: ChatMeta): 快照存储 {
  return {
    读索引: () => ({ 快照楼层: [...meta.快照楼层] }),
    // 读路径不该写索引 —— 真被调用说明逻辑有误，直接返回 false 让它显形
    写索引: () => false,
    楼层还在: (楼层) => {
      try {
        return !!useHost().chat.messages(楼层)[0];
      } catch {
        return false;
      }
    },
    读楼层: (楼层) => {
      try {
        const raw = useHost().vars.get({ type: 'message', message_id: 楼层 })?.[STORAGE_KEY];
        return raw && typeof raw === 'object' ? raw as any : null;
      } catch {
        return null;
      }
    },
    写楼层: () => {
      throw new Error('[烟火] 读路径不该写楼层');
    },
    删楼层: (楼层) => {
      try { useHost().vars.del(STORAGE_KEY, { type: 'message', message_id: 楼层 }); }
      catch { /* 楼层可能已不存在 */ }
    },
    末层: () => useHost().chat.lastMessageId(),
  };
}

/** 构造楼层快照数据(楼层不存在时返回 null); v1.8 起楼层 hash 校验已移除, 不再写入 */
function buildSnapshotPayload(data: WorldData, anchorFloor: number, processedFloor: number, 池: 归档池 = {}) {
  let message = null;
  try {
    message = useHost().chat.messages(anchorFloor)[0] ?? null;
  } catch {
    message = null;
  }
  if (!message) return null;
  // 归档只记引用(v2.9.6), 内容进池; 空就不写引用键
  const 墓碑 = 入池('e', data.已结束 ?? [], 池);
  const 失效暗线 = 入池('s', data.已失效暗线 ?? [], 池);
  const 过期日程 = 入池('o', data.已过期日程 ?? [], 池);
  const 新增 = { ...墓碑.新增, ...失效暗线.新增, ...过期日程.新增 };
  const payload = {
    版本: DATA_VERSION,
    楼层: anchorFloor,
    处理到楼层: processedFloor,
    世界: klona(data.世界),
    地区: klona(data.地区 ?? {}),
    形势: klona(data.形势 ?? {}),
    暗线: klona(data.暗线 ?? []),
    日程: klona(data.日程 ?? []),
    指标: klona(data.指标 ?? {}),
    事件: klona(data.事件),
    ...(墓碑.引用.length ? { 已结束引用: 墓碑.引用 } : {}),
    组织: klona(data.组织),
    小结: data.小结 ?? '',
    统计: {
      推进次数: data.统计?.推进次数 ?? 0, 最后推进: data.统计?.最后推进 ?? 0,
      // v2.9.3 节奏事实: 有值才写(旧快照形状不变)
      ...(data.统计?.上次重大事件时间 ? { 上次重大事件时间: data.统计.上次重大事件时间 } : {}),
      ...(data.统计?.上次新增时间 ? { 上次新增时间: data.统计.上次新增时间 } : {}),
    },
    处理签名: data.处理签名 ?? '',
    // v2.9.0 注入粘性: 有值才写, 没有就不出现这个键(不改动既有快照的形状)
    ...(data.上次注入?.length ? { 上次注入: [...data.上次注入] } : {}),
    // 2026-11-22 修: 两个归档随快照落盘(完整保留, 不裁条数也不裁字段); v2.9.6 起只记引用, 空就不写这个键
    ...(失效暗线.引用.length ? { 已失效暗线引用: 失效暗线.引用 } : {}),
    ...(过期日程.引用.length ? { 已过期日程引用: 过期日程.引用 } : {}),
  };
  return { payload, 新增 };
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
export function writeStateSnapshot(data: WorldData, anchorFloor: number, processedFloor: number, _consumeClearLayer: boolean, metaInput: ChatMeta | null = null, origin?: 楼层归属): boolean {
  try {
    if (origin && !归属仍有效(origin)) return false;
    const meta = klona(metaInput ?? loadMeta(true));
    const built = buildSnapshotPayload(data, anchorFloor, processedFloor, 读归档池());
    if (!built) return false;
    const { payload, 新增 } = built;
    // 先写池: 失败就整次不提交(楼层与索引都没动); 成功而后面失败, 池里最多多几条没人引用的孤儿
    if (!写归档池(新增)) return false;
    const key = 分支键(anchorFloor);
    const oldVariables = useHost().vars.get({ type: 'message', message_id: anchorFloor });
    const oldRaw = klona(oldVariables[STORAGE_KEY]);
    const accepted = 已接受快照(oldRaw, meta, key);
    const commitId = `c${Date.now().toString(36)}${Math.random().toString(36)}`;
    const staged: Record<string, any> = { ...payload, 提交号: commitId, 世代: meta.世代 ?? 0, 修订: (meta.修订 ?? 0) + 1 };
    if (accepted) {
      staged.前一快照 = klona(accepted);
      delete staged.前一快照.前一快照;
    }
    writeFloorVariables(staged);
    const allFloors = [...new Set([...meta.快照楼层, anchorFloor])].sort((a, b) => a - b);
    const limit = snapshotLimit();
    const retained = allFloors.slice(-limit);
    const next = { ...meta, 版本: DATA_VERSION, 修订: staged.修订, 快照楼层: retained, 提交: { ...meta.提交, [key]: commitId } };
    if (!saveMeta(next)) {
      try {
        useHost().vars.update(vars => {
          const restored = { ...vars };
          if (oldRaw === undefined) delete restored[STORAGE_KEY];
          else restored[STORAGE_KEY] = oldRaw;
          return restored;
        }, { type: 'message', message_id: anchorFloor });
      } catch (error) {
        console.error('[烟火] 候选回滚暂未写回；索引仍只接受前一快照:', error);
      }
      return false;
    }
    // 索引已接受新版本: 「前一快照」只为"索引写失败时还能读回上一版"而存, 现在用不着了, 清掉(v2.9.6)。
    // 清理失败不影响正确性(读路径认提交号, 不会去读它), 只是多占一份空间。
    if (staged.前一快照) {
      try {
        useHost().vars.update(vars => {
          const 当前 = vars?.[STORAGE_KEY];
          if (当前 && typeof 当前 === 'object' && 当前.提交号 === commitId) delete 当前.前一快照;
          return vars;
        }, { type: 'message', message_id: anchorFloor });
      } catch (error) {
        console.warn('[烟火] 前一快照暂未清理(不影响读取):', error);
      }
    }
    // 仅在索引已接受新版本后清理旧的完整快照；不裁任何内容字符串。
    for (const removed of allFloors.filter(floor => !retained.includes(floor))) {
      try { useHost().vars.del(STORAGE_KEY, { type: 'message', message_id: removed }); }
      catch (error) { console.warn(`[烟火] 旧快照 #${removed} 暂未清理:`, error); }
    }
    console.info(`[烟火] 快照写入楼层 #${anchorFloor} (事件=${payload.事件.length}件, 组织=${Object.keys(payload.组织).length}个, 保留${retained.length}/${limit}份)`);
    return true;
  } catch (error) {
    console.error('[烟火] 快照未提交:', error);
    return false;
  }
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
export function 保存推进结果(data: WorldData, 锚点楼层: number, origin?: 楼层归属): 存档结果 {
  const next = { ...data, 处理到楼层: 锚点楼层 };
  const 落盘 = writeStateSnapshot(next, 锚点楼层, 锚点楼层, false, null, origin);
  return {
    落盘,
    锚点楼层: 落盘 ? 锚点楼层 : -1,
    数据: 落盘 ? loadData() : data,
    说明: 落盘 ? `世界状态已存进楼层 #${锚点楼层}` : `楼层 #${锚点楼层} 未提交，保留上一份状态`,
  };
}

/** 只读排除重推锚点；新生成失败不会破坏已提交世界。 */
export function 读取重推基准(floorId: number): WorldData {
  return loadData(floorId);
}

/** 撤销指定楼层的快照(手动「重新推进」用): 从索引移除并物理删除, 状态自动回落到更早楼层 */
export function discardSnapshotAt(floorId: number): boolean {
  const meta = loadMeta(true);
  if (!meta.快照楼层.includes(floorId)) return false;
  const next = { ...meta, 修订: (meta.修订 ?? 0) + 1, 快照楼层: meta.快照楼层.filter(floor => floor !== floorId) };
  if (!saveMeta(next)) return false;
  try { useHost().vars.del(STORAGE_KEY, { type: 'message', message_id: floorId }); }
  catch (error) { console.warn('[烟火] 已撤销索引，旧快照暂未清理:', error); }
  return true;
}

/** 显式撤销仍提供给旧调用者；模型重推准备使用非破坏性的读取重推基准。 */
export function 撤销快照并重读(floorId: number): WorldData {
  discardSnapshotAt(floorId);
  return loadData();
}

export function clearAllData(): number {
  const meta = loadMeta(true);
  const cutoff = useHost().chat.lastMessageId();
  if (cutoff < 0) throw Error('聊天尚未就绪，未清空世界');
  // 传讯速度是这个聊天的设定(哪个时代), 不是世界状态: 清空世界保留它
  const next = { ...emptyMeta(), 清空层: cutoff, 清空截止: cutoff, 修订: (meta.修订 ?? 0) + 1, 世代: (meta.世代 ?? 0) + 1,
    ...(meta.传讯速度 ? { 传讯速度: meta.传讯速度 } : {}) };
  if (!saveMeta(next)) throw Error('清空索引未提交，世界保持原样');
  // 归档池随世界一起清空(旧世代的快照读路径已经不认, 池里的东西没人会再引用)
  try {
    useHost().vars.update(variables => {
      const 余 = { ...variables };
      delete 余[ARCHIVE_KEY];
      return 余;
    }, { type: 'chat' });
  } catch (error) {
    console.warn('[烟火] 清空已生效, 归档池暂未删除:', error);
  }
  for (const floor of meta.快照楼层) {
    try { useHost().vars.del(STORAGE_KEY, { type: 'message', message_id: floor }); }
    catch (error) { console.warn(`[烟火] 清空已生效，旧快照 #${floor} 暂未物理移除:`, error); }
  }
  return cutoff;
}

/**
 * 设定本聊天的传讯速度(v2.9.2)。只写聊天变量里的这一项, 不碰快照、不推修订号 ——
 * 它不改世界状态, 只改"注入时按什么时差过滤", 所以在途的推进不需要因此作废。
 * 选"未选"等于删掉这一项。调用方之后应重新读数据并同步世界书条目(注入内容会变)。
 */
export function 设传讯速度(速度: 传讯速度): boolean {
  if (!是传讯速度(速度)) return false;
  const meta = loadMeta(true);
  const next: ChatMeta = { ...meta };
  if (速度 === '未选') delete next.传讯速度;
  else next.传讯速度 = 速度;
  return saveMeta(next);
}

export function 读传讯速度(): 传讯速度 {
  return loadMeta().传讯速度 ?? '未选';
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
  重推基准: 读取重推基准,
  /** 撤销指定楼层的快照 */
  撤销楼层: discardSnapshotAt,
  /** 清空全部数据, 返回新的「清空层」 */
  清空: clearAllData,
  /** 本聊天的传讯速度(聊天级设定, 不随快照回退) */
  设传讯速度,
  读传讯速度,
};
