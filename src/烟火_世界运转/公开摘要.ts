import type { Settings, WorldData, WorldEvent, 传讯速度 } from './schema';
import { 取运转策略 } from './运转策略';
import { 解析日期 } from './时间校验';
import { 事件层, 取层, 该注入 } from './世界字段表';
import { 属于本地, 判传播, 推算所闻, type 所闻 } from './传播';

// 属于本地 v2.9.2 起住在 传播.ts(地缘关系的一部分); 这里原样转出, 既有调用方与用例不用改 import
export { 属于本地 } from './传播';

/** 只选完整事件；等待不会被伪装成结束，未选中记录仍存在存档里。
 *  等待中的事态不能永久沉底：到期、被正文点名、或已经等够轮数的，都要重新进入工作集。
 *  强制(v2.9.3): 本轮掷出到期判定的事件键, 优先级 40(高于正文提及的 30), 一定进工作集。 */
export function 选工作事件(data: WorldData, settings: Settings, evidence: string, 强制: ReadonlySet<string> = new Set()): WorldEvent[] {
  const policy = 取运转策略(settings.运转);
  const now = 解析日期(data.世界.时间)?.天;
  const start = (data.统计.推进次数 ?? 0) % Math.max(1, data.事件.length);
  return data.事件.map((event, index) => {
    const due = 解析日期(event.下次判定时间)?.天;
    const mentioned = [event.标题, event.组织, event.地点].filter(Boolean).some(key => evidence.includes(key));
    const waiting = !!event.等待条件 && !mentioned && !(now != null && due != null && due <= now);
    // 等待中的事如果一直没被点名/没到期，按位置轮换强制复审，避免"等待"变成永久冷藏。
    const 复审 = waiting && (index - start + data.事件.length) % Math.max(1, data.事件.length) < Math.max(1, Math.floor(policy.重点跟进 / 2));
    const priority = 强制.has(event.id || event.标题) ? 40 : mentioned ? 30 : now != null && due != null && due <= now ? 20 : 复审 ? 5 : waiting ? -10 : event.阶段 === '进行中' ? 10 : 0;
    return { event, priority, position: (index - start + data.事件.length) % Math.max(1, data.事件.length) };
  }).sort((a,b) => b.priority - a.priority || a.position - b.position)
    .slice(0, policy.重点跟进).map(row => row.event);
}

// ---------------------------------------------------------------------------
// 注入投影(v2.9.0): 给主 AI 的那一份
// ---------------------------------------------------------------------------
//
// 与 v2.8.x 的三处不同(设计稿 docs「注入重构与世界传播」模块 A):
//   ① 只写主 AI 用得上的东西: 不再写「等待条件」(引擎调度语言, 主 AI 会当钩子提前写出来),
//      不再写"未列出不等于结束 / 仍在存档里 / 未被删除"这类账本话术;
//   ② 字段清单从 世界字段表.事件层.注入列 来(白名单 + 顺序), 不再在这里手写一份;
//   ③ 挑哪几条不再看数组位置, 而是按确定性分数整条挑, 上次注入过的加粘性分 ——
//      "这轮出现下轮消失"会让主 AI 以为事情结束了, 以前靠那几句话术去防, 现在靠挑选本身稳定。
// 仍然不变的纪律: 整条选择、绝不截断; 超字符目标只标 overTarget; 保密事件默认不进。

export interface 在途事件 {
  标题: string;
  地点: string;
  传播: string;
  原因: '在途' | '传不到';
  预计剩余天数: number | null;
}

export interface 公开摘要结果 {
  text: string;
  selectedIds: string[];
  omittedIds: string[];
  /** 本轮注入的最近已结束公开事态(整条选择，不是删除) */
  了结Ids: string[];
  characters: number;
  targetCharacters: number;
  overTarget: boolean;
  /** 传播时滞这一轮生效没有; 说明 = 开关开着却没生效的原因(只进日志) */
  传播: { 生效: boolean; 说明: string };
  /** 因传播时滞暂未传到主角所在地的公开进行中事件（供面板日志页可视化，不注入主 AI） */
  在途: 在途事件[];
}

export interface 公开摘要选项 {
  /** 主角此刻所在的地区名; 不传时取 data.世界.主角所在(v2.9.1)。空 = 未知: 不判"本地", 所有事件保留背景, 不出【所在地】段。 */
  主角所在?: string;
  /** 本聊天的传讯速度; 不传时取 data.传讯速度(来自聊天变量, v2.9.2) */
  传讯速度?: 传讯速度;
}

/** 已结束的公开结果只注入最近这么多世界日内结束的(两边时间都可解析时才按它筛; 古代历法退回"最近 N 条") */
export const 了结注入窗口天数 = 30;
/** 【近期日程】: 只注入 0~7 世界日内会到的, 最多 3 条; 时间解析不了的(古代历法)不注入, 不伪造"几天后" */
export const 日程注入窗口天数 = 7;
export const 日程注入条数 = 3;
/** 【数据变化】: 只注入趋势不是"平稳"的指标, 最多 3 条 */
export const 指标注入条数 = 3;

/** 字段表里的键是数据口径, 注入时换成主 AI 读得顺的说法(其余键原样作标签) */
const 注入标签: Readonly<Record<string, string>> = { 描述: '当前', 组织: '归属' };

const 一日毫秒 = 86400000;

function 事件键(event: WorldEvent): string {
  return event.id || event.标题;
}

/** 世界日差: 两边都能解析才有值(正数 = 这件事在"今"之前) */
function 距今天数(时间: string | undefined, 今: number | undefined): number | null {
  const 天 = 解析日期(时间)?.天;
  if (今 == null || 天 == null) return null;
  return Math.round((今 - 天) / 一日毫秒);
}

export interface 注入评分上下文 {
  /** 当前世界时间的 解析日期().天; 不可解析 = undefined(时效分不加) */
  今?: number;
  主角所在: string;
  /** 上一次注入选中的事件键(粘性) */
  上次: ReadonlySet<string>;
}

/**
 * 一条事件的注入分(纯函数, 只看字段, 不看数组位置):
 *   本地 +30 · 重大 +15 · 全域 +10 / 区域 +5 · 进行中 +5 / 收尾 −5 · 最近进展 ≤3 日 +10 / ≤10 日 +5 · 上次注入过 +8
 * 不含"正文提及": 注入在切聊天、面板预览时也要重算, 那时手上没有正文, 加了这一项会让同一份数据注出两种结果。
 * 正文提到的事一般本轮就有进展, 由"最近进展"那一项接住。
 */
export function 事件注入分(event: WorldEvent, 上下文: 注入评分上下文): number {
  let 分 = 0;
  if (属于本地(event, 上下文.主角所在)) 分 += 30;
  if (event.规模 === '重大') 分 += 15;
  分 += event.传播 === '全域' ? 10 : event.传播 === '区域' ? 5 : 0;
  分 += event.阶段 === '进行中' ? 5 : event.阶段 === '收尾' ? -5 : 0;
  const 天 = 距今天数(event.时间, 上下文.今);
  if (天 != null && 天 >= 0) 分 += 天 <= 3 ? 10 : 天 <= 10 ? 5 : 0;
  if (上下文.上次.has(事件键(event))) 分 += 8;
  return 分;
}

/** 按分数整条挑 N 条; 同分时最近进展新者在前, 再按事件键排, 保证同一份数据永远挑出同一批。 */
export function 选注入事件(候选: readonly WorldEvent[], 条数: number, 上下文: 注入评分上下文): WorldEvent[] {
  return 候选
    .map(event => ({ event, 分: 事件注入分(event, 上下文), 天: 解析日期(event.时间)?.天 ?? -Infinity, 键: 事件键(event) }))
    .sort((a, b) => b.分 - a.分 || b.天 - a.天 || (a.键 < b.键 ? -1 : a.键 > b.键 ? 1 : 0))
    .slice(0, Math.max(0, 条数))
    .map(row => row.event);
}

/** 一条事件的注入文本: 字段与顺序来自 事件层.注入列; 带背景=false 时去掉「背景」。空字段不写。 */
function 事件文本(event: WorldEvent, 带背景: boolean, 标注 = ''): string {
  const 行 = (事件层.注入列 ?? [])
    .filter(键 => 带背景 || 键 !== '背景')
    .map(键 => [注入标签[键] ?? 键, (event as unknown as Record<string, unknown>)[键]] as const)
    .filter(([, 值]) => !!值)
    .map(([标签, 值]) => `${标签}：${String(值)}`);
  return `${event.标题}（${event.阶段}${标注}）\n` + 行.join('\n');
}

/** 只传到较早一步的远方事件(v2.9.2): 写所在地听到的那一步, 不写"当前"与背景 —— 那是远方此刻的事, 这里还不知道。
 *  阶段也不写(听到之后可能已经变了)。 */
function 传闻文本(event: WorldEvent, 闻: 所闻): string {
  const 行 = ([['时间', 闻.听到时间], ['地点', event.地点], ['当地所闻', 闻.听到变化], ['归属', event.组织], ['代表人物', event.代表人物]] as const)
    .filter(([, 值]) => !!值)
    .map(([标签, 值]) => `${标签}：${String(值)}`);
  return `${event.标题}（外地传来 · 约${闻.距今天数}天前的消息 · ${闻.公告 ? '公告' : '传言'}）\n` + 行.join('\n');
}

function 来路标注(闻: 所闻): string {
  return ` · ${闻.关系 === '本地' ? '本地见闻' : '外地传来'} · ${闻.公告 ? '公告' : '传言'}`;
}

/** 一条档案按某层的 注入列 渲染成「标签：值」(空字段不写) */
function 字段行(列: readonly string[] | null, 条目: Record<string, unknown>): string {
  return (列 ?? []).filter(键 => !!条目[键]).map(键 => `${键}：${String(条目[键])}`).join('\n');
}

export function 相对日(差: number): string {
  return 差 === 0 ? '今天' : 差 === 1 ? '明天' : `${差}天后`;
}

/** 【所在地】: 主角所在正好是某个地区名, 且这一条有内容时才出; 字段只取 地区层.注入列(概况/局势/主事方/外部关系, 不含背景)。 */
function 所在地段(data: WorldData, 主角所在: string): string | null {
  if (!主角所在) return null;
  const 层 = 取层('地区');
  const 地区 = data.地区?.[主角所在];
  if (!地区 || !该注入(层, 地区 as unknown as Record<string, unknown>)) return null;
  return `【所在地】\n${主角所在}\n${字段行(层.注入列, 地区 as unknown as Record<string, unknown>)}`;
}

/** 范围(v2.9.5): 空 = 全境, 总是给; 有值时只给与主角所在对得上的; 主角所在未知时不过滤(降级, 不丢信息) */
function 范围对得上(范围: string | undefined, 主角所在: string): boolean {
  const 值 = String(范围 ?? '').trim();
  return !值 || !主角所在 || 属于本地({ 地点: 值 }, 主角所在);
}
/** 主角所在未知、却给了别处范围的条目, 标出它是哪里的(否则主 AI 会当成本地的) */
function 范围标注(范围: string | undefined, 主角所在: string): string {
  const 值 = String(范围 ?? '').trim();
  return 值 && !主角所在 ? `，${值}` : '';
}

/** 近期日程(注入与面板共用, v2.9.7 抽出): 日程层开着、世界时间与日程时间都能解析、0~7 日内、周期不是每天、
 *  范围对得上; 按天数排, 最多 日程注入条数 条。 */
export function 取近期日程(data: WorldData, settings: Settings, 今: number | undefined, 主角所在: string): { 日程: WorldData['日程'][number]; 差: number }[] {
  if (settings.运转.世界日程 === false || 今 == null) return [];
  const 近: { 日程: WorldData['日程'][number]; 差: number }[] = [];
  for (const 日程 of data.日程 ?? []) {
    if (/每天|每日/.test(String(日程.周期 ?? ''))) continue;
    if (!范围对得上(日程.范围, 主角所在)) continue;
    const 天 = 解析日期(日程.时间)?.天;
    if (天 == null) continue;
    const 差 = Math.round((天 - 今) / 一日毫秒);
    if (差 >= 0 && 差 <= 日程注入窗口天数) 近.push({ 日程, 差 });
  }
  近.sort((a, b) => a.差 - b.差).splice(日程注入条数);
  return 近;
}

/** 【近期日程】: 条目见 取近期日程 */
function 近期日程段(data: WorldData, settings: Settings, 今: number | undefined, 主角所在: string): string | null {
  const 近 = 取近期日程(data, settings, 今, 主角所在);
  if (!近.length) return null;
  return '【近期日程】\n' + 近.map(({ 日程, 差 }) =>
    `${日程.名称}（${相对日(差)}${日程.周期 ? `，${日程.周期}` : ''}${范围标注(日程.范围, 主角所在)}）${日程.概况 ? `：${日程.概况}` : ''}`).join('\n');
}

/** 数据变化(注入与面板共用, v2.9.7 抽出): 指标层开着、趋势不是平稳、这一条有内容、范围对得上; 最多 指标注入条数 条。 */
export function 取数据变化(data: WorldData, settings: Settings, 主角所在: string): [string, WorldData['指标'][string]][] {
  if (settings.运转.世界指标 === false) return [];
  const 层 = 取层('指标');
  return Object.entries(data.指标 ?? {})
    .filter(([, 指标]) => 指标.趋势 !== '平稳' && 该注入(层, 指标 as unknown as Record<string, unknown>) && 范围对得上(指标.范围, 主角所在))
    .slice(0, 指标注入条数);
}

/** 【数据变化】: 条目见 取数据变化 */
function 数据变化段(data: WorldData, settings: Settings, 主角所在: string): string | null {
  const 变 = 取数据变化(data, settings, 主角所在);
  if (!变.length) return null;
  // 该注入 的判据是 值 或 说明 任一非空, 所以"值空、说明有"是合法条目: 先只拼非空片段, 不留"：，"这种空位
  return '【数据变化】\n' + 变.map(([名, 指标]) => {
    // 范围标注也按片段拼, 值与趋势都空时不会留下开头的"，"
    const 片段 = [指标.值, 指标.趋势, 范围标注(指标.范围, 主角所在).slice(1)].filter(Boolean).join('，');
    return `${名}：${片段}${指标.说明 ? `${片段 ? '。' : ''}${指标.说明}` : ''}`;
  }).join('\n');
}

/** 公共输出只由已标记公开的事件及其公开后果派生；不透传可能复写秘密的总览/组织暗流。 */
export function 构建公开摘要(data: WorldData, settings: Settings, 选项: 公开摘要选项 = {}): 公开摘要结果 {
  const policy = 取运转策略(settings.运转);
  const 主角所在 = String(选项.主角所在 ?? data.世界.主角所在 ?? '').trim();
  const 今 = 解析日期(data.世界.时间)?.天;
  const 上下文: 注入评分上下文 = { 今, 主角所在, 上次: new Set(data.上次注入 ?? []) };

  // 传播时滞(v2.9.2): 不生效时下面每一处都退回 v2.9.1 的写法, 注入逐字不变
  const 判定 = 判传播(settings.运转.传播时滞 !== false, 选项.传讯速度 ?? data.传讯速度, 主角所在, 今, data);
  const 所闻表 = new Map<WorldEvent, 所闻>();
  const 闻 = (event: WorldEvent): 所闻 => {
    let 结果 = 所闻表.get(event);
    if (!结果) { 结果 = 推算所闻(event, 判定.上下文!); 所闻表.set(event, 结果); }
    return 结果;
  };
  // 保密事件不走公共渠道, 不按传播过滤(只在「注入保密事件」开着时进, 与以前一样)
  const 看得见 = (event: WorldEvent) => event.公开性 === '公开' ? (!判定.生效 || 闻(event).到达) : settings.运转.注入保密事件;
  // 传播时滞拦截的公开进行中事件(在途或超出传播范围): 只给面板展示, 不进注入文本
  const 在途: 在途事件[] = 判定.生效
    ? data.事件
        .filter(event => event.公开性 === '公开' && !闻(event).到达)
        .map(event => {
          const 此闻 = 闻(event);
          return {
            标题: event.标题,
            地点: event.地点 || '未知地点',
            传播: event.传播,
            原因: 此闻.原因 ?? '传不到',
            预计剩余天数: 此闻.原因 === '在途' ? (此闻.预计剩余天数 ?? null) : null,
          };
        })
    : [];
  // 远方已经了结、但结局还没传到的事: 所在地仍按最后听到的那一步当传闻在说, 不能凭空消失
  const 结局未到 = 判定.生效
    ? (data.已结束 ?? []).filter(event => event.公开性 === '公开' && 闻(event).到达 && !闻(event).最新)
    : [];
  const candidates = [...data.事件.filter(看得见), ...结局未到];
  const selected = 选注入事件(candidates, policy.公开摘要, 上下文);
  const selectedIds = selected.map(事件键);
  const selectedSet = new Set(selectedIds);
  const omittedIds = candidates.filter(e => !selectedSet.has(事件键(e))).map(事件键);

  // 已结束的公开结果蓝绿分流：蓝灯只常驻最近 7 世界日内、最多 2 条新鲜结局，8~30 日或超额的留给绿灯「往事」按需激活。
  const 保留条数 = Math.max(1, policy.公开摘要);
  const 公开了结 = (data.已结束 ?? []).filter(event => event.公开性 === '公开' && event.结束原因
    && (!判定.生效 || (闻(event).到达 && 闻(event).最新)));
  const 窗口内 = 公开了结.filter(event => {
    const 天 = 距今天数(event.时间, 今);
    return 天 == null || 天 <= 了结注入窗口天数;
  });
  const 蓝灯了结 = 窗口内.filter(event => {
    const 天 = 距今天数(event.时间, 今);
    return 天 == null || 天 <= 7;
  });
  const 最近了结 = 蓝灯了结.slice(-Math.min(2, 保留条数));
  const 了结Ids = 最近了结.map(事件键);

  const lines = [
    '[烟火 · 世界动向]',
    '以下为世界公共动态。角色只能通过耳闻、告示、传言等合理渠道自然得知并议论，不可凭空全知，也不要生硬地大段播报。',
    ...(判定.生效 ? ['标"传言"的说法可能走样；标"约N天前的消息"的是所在地最近听到的，远方此刻可能已经变了。'] : []),
    `世界时间：${data.世界.时间 || '未知'}${主角所在 ? ` ｜ 主角所在：${主角所在}` : ''}`,
  ];
  // v2.9.1 三段当地人看得见的东西: 所在地 / 近期日程 / 数据变化(各自有条件, 没有就整段不出)
  for (const 段 of [所在地段(data, 主角所在), 近期日程段(data, settings, 今, 主角所在), 数据变化段(data, settings, 主角所在)]) {
    if (段) lines.push(段);
  }
  const 地区列表 = Object.entries(data.地区 ?? {}).filter(([名]) => {
    const 键 = 名.trim();
    return 键.length > 0 && 键 !== 主角所在;
  });
  if (地区列表.length > 0) {
    // 蓝灯只放「非所在地地区名：一句话概况」作地图索引，详情留给绿灯按需触发
    lines.push('【已知地区】\n' + 地区列表.map(([名, 地区]) => {
      const 概况 = String(地区?.概况 ?? '').trim();
      return 概况 ? `- ${名}：${概况}` : `- ${名}`;
    }).join('\n'));
  }
  const 组织列表 = Object.entries(data.组织 ?? {}).filter(([名]) => 名.trim().length > 0);
  if (组织列表.length > 0) {
    // 蓝灯只放「组织名：公开目标」作为目录索引，让主 AI 知道有哪些组织可提及以触发绿灯；动向/外部关系/背景绝不进蓝灯
    lines.push('【已知组织】\n' + 组织列表.map(([名, 组织]) => {
      const 目标 = String(组织?.目标 ?? '').trim();
      return 目标 ? `- ${名}：${目标}` : `- ${名}`;
    }).join('\n'));
  }
  if (selected.length || 最近了结.length) lines.push('【动态】');
  for (const event of selected) {
    if (判定.生效 && event.公开性 === '公开') {
      const 此闻 = 闻(event);
      lines.push(此闻.最新 ? 事件文本(event, 此闻.关系 === '本地', 来路标注(此闻)) : 传闻文本(event, 此闻));
      continue;
    }
    // 主角所在未知时不判本地, 全部保留背景(降级); 已知时只有本地事件带背景 —— 主 AI 要的是"现在怎样"。
    const 带背景 = !主角所在 || 属于本地(event, 主角所在);
    const 文本 = 事件文本(event, 带背景);
    lines.push(event.公开性 === '保密' ? `保密背景（主角不得无依据知晓）：\n${文本}` : 文本);
  }
  // 持续后果独立于摘要条数；必要完整事实即使超目标也不裁切。
  for (const event of 最近了结) {
    const 标注 = 判定.生效 ? `（${来路标注(闻(event)).slice(3)}）` : '';
    lines.push(`已结束事态「${event.标题}」的公开结果${标注}：\n${event.结束原因}`);
  }
  const text = lines.join('\n\n');
  return { text, selectedIds, omittedIds, 了结Ids, characters: text.length, targetCharacters: policy.摘要目标字符, overTarget: text.length > policy.摘要目标字符,
    传播: { 生效: 判定.生效, 说明: 判定.说明 }, 在途 };
}

export interface 绿灯条目 {
  角色: '组织' | '地区' | '事态' | '往事';
  键: string;
  关键词: string[];
  内容: string;
}

const 关键词占位词 = new Set(['未知', '不详', '不明', '无', '暂无', '待定', '无名', '佚名']);

/** 从负责人/代表人物字符串（如"家主·林远山、副手·陈默"）里提取可读的关键词，过滤占位词 */
function 提取负责人关键词(负责人: string): string[] {
  const 词们: string[] = [];
  for (const 段 of String(负责人 ?? '').split(/[、,，/；;]+/)) {
    const 整 = 段.trim();
    if (!整 || 关键词占位词.has(整)) continue;
    if (整.length >= 2) 词们.push(整);
    const 尾 = 整.split(/[·・:：]/).pop()?.trim() ?? '';
    if (尾.length >= 2 && 尾 !== 整 && !关键词占位词.has(尾)) 词们.push(尾);
  }
  return 词们;
}

/**
 * 构建按关键词触发的绿灯条目（平时 0 token，正文提及才激活）:
 * - 组织：仅注入公开安全字段（目标/负责人/覆盖范围/外部关系），绝不透传「动向」与「背景」；
 * - 地区：仅注入非主角所在地的地区（所在地已在蓝灯【所在地】里），使用地区公开字段；
 * - 事态：未入选蓝灯【动态】的其余已到达公开进行中事件（不含保密事件与在途未到事件）。
 */
export function 构建绿灯条目(
  data: WorldData,
  settings: Settings,
  主角所在?: string,
  落选事件键?: readonly string[],
  蓝灯了结键?: readonly string[],
): 绿灯条目[] {
  if (settings.运转?.拆分绿灯条目 === false) return [];
  const 当前所在 = String(主角所在 ?? data.世界?.主角所在 ?? '').trim();
  const 条目们: 绿灯条目[] = [];

  for (const [名, 组织] of Object.entries(data.组织 ?? {})) {
    const 键 = 名.trim();
    if (!键 || !组织) continue;
    const 正文 = 字段行(['目标', '负责人', '覆盖范围', '外部关系'], 组织 as unknown as Record<string, unknown>);
    if (!正文) continue;
    const 关键词 = Array.from(new Set([键, ...提取负责人关键词(组织.负责人 ?? '')]));
    条目们.push({
      角色: '组织',
      键,
      关键词,
      内容: `[烟火 · 组织档案]\n组织：${键}\n${正文}`,
    });
  }

  const 地区列 = [...(取层('地区').注入列 ?? []), '邻近地区'];
  for (const [名, 地区] of Object.entries(data.地区 ?? {})) {
    const 键 = 名.trim();
    if (!键 || !地区 || 键 === 当前所在) continue;
    const 正文 = 字段行(地区列, 地区 as unknown as Record<string, unknown>);
    if (!正文) continue;
    条目们.push({
      角色: '地区',
      键,
      关键词: [键],
      内容: `[烟火 · 地区档案]\n地区：${键}\n${正文}`,
    });
  }

  const 摘要缓存 = (落选事件键 && 蓝灯了结键) ? null : 构建公开摘要(data, settings, { 主角所在: 当前所在 });
  const 落选集合 = new Set(落选事件键 ?? 摘要缓存!.omittedIds);
  const 蓝灯了结集合 = new Set(蓝灯了结键 ?? 摘要缓存!.了结Ids);
  if (落选集合.size > 0) {
    for (const event of data.事件 ?? []) {
      if (event.公开性 !== '公开') continue;
      if (!落选集合.has(事件键(event))) continue;
      const 标题 = String(event.标题 ?? '').trim();
      if (!标题) continue;
      const 地点词 = String(event.地点 ?? '').trim();
      const 组织词 = String(event.组织 ?? '').trim();
      const 关键词 = Array.from(new Set([
        标题,
        // 跳过主角当前所在地，避免在本地对话时把所有落选本地事件一并激活
        ...(地点词 && 地点词 !== 当前所在 ? [地点词] : []),
        组织词,
        ...提取负责人关键词(event.代表人物 ?? ''),
      ].filter(w => w.length >= 2 && !关键词占位词.has(w))));
      const 带背景 = !当前所在 || 属于本地(event, 当前所在);
      条目们.push({
        角色: '事态',
        键: 事件键(event),
        关键词: 关键词.length ? 关键词 : [标题],
        内容: `[烟火 · 公开事态]\n${事件文本(event, 带背景)}`,
      });
    }
  }

  const 今 = 解析日期(data.世界?.时间 ?? '')?.天;
  const 判定 = 判传播(settings.运转?.传播时滞 !== false, data.传讯速度, 当前所在, 今, data);
  for (const event of data.已结束 ?? []) {
    if (event.公开性 !== '公开' || !event.结束原因) continue;
    const 键 = 事件键(event);
    if (蓝灯了结集合.has(键)) continue;
    const 天 = 距今天数(event.时间, 今);
    if (天 != null && 天 > 了结注入窗口天数) continue;
    if (判定.生效) {
      const 此闻 = 推算所闻(event, 判定.上下文!);
      if (!此闻.到达 || !此闻.最新) continue;
    }
    const 标题 = String(event.标题 ?? '').trim();
    if (!标题) continue;
    // 「往事」只用高专有性的标题与代表人物作关键词，不放泛地名与泛组织名，防止高频误触
    const 关键词 = Array.from(new Set([
      标题,
      ...提取负责人关键词(event.代表人物 ?? ''),
    ].filter(w => w.length >= 2 && !关键词占位词.has(w))));
    条目们.push({
      角色: '往事',
      键,
      关键词: 关键词.length ? 关键词 : [标题],
      内容: `[烟火 · 往事结局]\n已结束事态「${标题}」的公开结果：\n${event.结束原因}`,
    });
  }

  return 条目们;
}

export interface 天时氛围 {
  图标: 'sun' | 'moon' | 'wind';
  标签: string;
}

/** 纯确定性推算世界时间的季节与时段（0 token），无法解析时返回 null */
export function 取天时氛围(时间文本: string): 天时氛围 | null {
  const 文本 = String(时间文本 ?? '').trim();
  if (!文本) return null;
  const 月匹配 = /(?:年|\d{4}-)(\d{1,2})(?:月|-)/.exec(文本);
  const 月 = 月匹配 ? Number(月匹配[1]) : NaN;
  const 季 = 月 >= 3 && 月 <= 5 ? '春' : 月 >= 6 && 月 <= 8 ? '夏' : 月 >= 9 && 月 <= 11 ? '秋' : (月 === 12 || 月 === 1 || 月 === 2) ? '冬' : '';

  const 时匹配 = /(?:^|[\s·T])(\d{1,2}):\d{2}/.exec(文本);
  const 时 = 时匹配 ? Number(时匹配[1]) : NaN;
  let 时段 = '';
  let 图标: 'sun' | 'moon' | 'wind' = 'wind';
  if (!Number.isNaN(时) && 时 >= 0 && 时 <= 23) {
    if (时 >= 5 && 时 <= 7) { 时段 = '黎明'; 图标 = 'sun'; }
    else if (时 >= 8 && 时 <= 11) { 时段 = '上午'; 图标 = 'sun'; }
    else if (时 >= 12 && 时 <= 13) { 时段 = '正午'; 图标 = 'sun'; }
    else if (时 >= 14 && 时 <= 17) { 时段 = '午后'; 图标 = 'sun'; }
    else if (时 >= 18 && 时 <= 19) { 时段 = '黄昏'; 图标 = 'wind'; }
    else { 时段 = '夜晚'; 图标 = 'moon'; }
  }

  const 标签 = [季, 时段].filter(Boolean).join(' · ');
  return 标签 ? { 图标, 标签 } : null;
}
