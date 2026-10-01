import { chatCompletion, maskBaseUrl } from './api';
import { buildTickMessages } from './prompts';
import type { WorldData, WorldEvent, WorldFaction, WorldMetric, WorldOccasion, WorldSeed } from './schema';
import { EVENT_SCALE, EVENT_SECRECY, EVENT_SPREAD, EVENT_STAGE, METRIC_TREND, SEED_MATURITY } from './schema';
import { getSettings } from './settings';
import {
  ENDED_EVENT_LIMIT,
  EVENT_HISTORY_LIMIT,
  EVENT_LIMIT,
  FACTION_LIMIT,
  METRIC_LIMIT,
  OCCASION_LIMIT,
  REGION_LIMIT,
  SEED_LIMIT,
  TREND_LIMIT,
  useDebugStore,
  useStateStore,
  useUpdatingStore,
} from './state';
// 世界状态的落盘 / 读回 / 重推 / 清空都从这一个 module 进(候选 3): 不再自己拼 payload、
// 不再自己管 store 的成功/失败两条分支、不再记"先撤销快照再重读"的顺序
import { 世界状态存档 } from './保存世界状态';
import { getActiveWorldbookText } from './worldbook-read';
import { useHost } from './host';
import { syncWorldbookEntry } from './inject';
import { toastError, toastInfo, toastSuccess, toastWarning } from './toast';
import { 请求并校验 as 共用请求并校验 } from '../共用/模型往返';
import { 事件账目, validateAndNormalize } from './世界数据';
import { 解析世界载荷 } from './解析';

let isUpdating = false;

const TIME_JUMP_PATTERN = /(一夜之间|第二天一早|第二天|次日|隔天|几天后|数天后|十几天后|一两周后|两周后|几周后|数周后|几个星期后|几个礼拜后|一个月后|两个月后|数月后|几个月后|半年后|一年后|两年后|几年后|数年后|多年后|若干年后)/;

function detectTimeJump(text: string): string | null {
  const match = text.match(TIME_JUMP_PATTERN);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// 楼层标签过滤(与彼方同款)
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTagContent(text: string, tag: string): string {
  const escaped = escapeRegExp(tag);
  // 边界排除 ASCII 字母/数字/下划线/连字符: 中文标签需自定义边界, 且防止误匹配带后缀的标签名
  const boundary = '(?![a-zA-Z0-9_-])';
  let result = text.replace(new RegExp(`<${escaped}${boundary}[^>]*>[\\s\\S]*?<\\/${escaped}>`, 'gi'), '');
  result = result.replace(new RegExp(`<${escaped}${boundary}[^>]*\\/?>`, 'gi'), '');
  return result;
}

function extractTagContent(text: string, tag: string): string[] {
  const escaped = escapeRegExp(tag);
  const boundary = '(?![a-zA-Z0-9_-])';
  const matches: string[] = [];
  const re = new RegExp(`<${escaped}${boundary}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'gi');
  for (const match of text.matchAll(re)) {
    matches.push(match[1].trim());
  }
  return matches;
}

/**
 * 清除"孤立闭合标签"(只有 </tag> 没有配对 <tag> 的残留)。
 * 只删除闭合标签本身, 绝不从文本开头删到它——否则会误伤正文。
 */
function stripLoneClosingBlocks(text: string, tag: string): string {
  const escaped = escapeRegExp(tag);
  const boundary = '(?![a-zA-Z0-9_-])';
  const closeRe = new RegExp(`</${escaped}${boundary}[^>]*>`, 'gi');
  return text.replace(closeRe, '');
}

interface TagFilterSettings {
  模式: '排除' | '只读';
  列表: string[];
}

function createTextFilter(settings: TagFilterSettings): (text: string) => string {
  const tags = (settings.列表 ?? []).map(tag => tag.trim().replace(/^<|>$/g, '')).filter(Boolean);
  // 去掉 begin_of_X ... end_of_X 的思维链整块(标记是注释、内容却是纯文本); 再清理剩余 HTML 注释
  const stripComments = (text: string) =>
    text
      .replace(/<!--\s*begin_of_[a-zA-Z0-9_\u4e00-\u9fa5]+[\s\S]*?end_of_[a-zA-Z0-9_\u4e00-\u9fa5]+\s*-->/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
  if (tags.length === 0) return stripComments;
  if (settings.模式 === '只读') {
    return text => {
      const parts: string[] = [];
      for (const tag of tags) parts.push(...extractTagContent(text, tag));
      return stripComments(parts.join('\n\n') || text);
    };
  }
  return text => stripComments(tags.reduce((acc, tag) => stripLoneClosingBlocks(stripTagContent(acc, tag), tag), text));
}

// ---------------------------------------------------------------------------
// 楼层读取
// ---------------------------------------------------------------------------

function getRecentAssistantMessages(count: number): { message_id: number; message: string }[] {
  try {
    const lastId = useHost().chat.lastMessageId();
    // 只取末尾一小段楼层(足够找到最近 N 条 AI 回复), 避免每次推进都拉全量楼层
    const start = Math.max(0, lastId - count * 10);
    const messages = useHost().chat.messages(`${start}-${lastId}`, { role: 'assistant' });
    return messages
      .filter(message => !message.is_hidden)
      .slice(-count)
      .map(message => ({ message_id: message.message_id, message: String(message.message ?? '') }));
  } catch {
    return [];
  }
}

function buildLatestUserInput(replyMessageId: number, filter: (text: string) => string, replyIds: Set<number>, minId: number): string {
  try {
    const lastId = useHost().chat.lastMessageId();
    const start = Math.max(0, Math.min(replyMessageId, lastId) - 4);
    const messages = useHost().chat.messages(`${start}-${lastId}`)
      .filter(message => message.role === 'user' && !message.is_hidden && message.message_id > minId && !replyIds.has(message.message_id))
      .slice(-1);
    return messages.map(message => filter(message.message)).join('\n\n');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// AI 输出解析与校验 → 已整段搬进 ./解析.ts(候选2)
// ---------------------------------------------------------------------------
// 「原始文本 → 世界载荷」那一层(括号配平切分 / 载荷识别 / 中英键名别名表 / 思考字段剥离 +
// 裸控制字符转义 / 双解析器 × 多变体择优)以前长在这里且全部私有, 现在只剩一个入口:
//   解析世界载荷(原始文本) → { 成功: true, 载荷, 片段 } | { 成功: false, 原因, 片段 }
// 改解析口径请去 解析.ts(原注释与原委都在那儿); 用例见 tests/parse-rescue.test.ts。

// ---------------------------------------------------------------------------
// 主流程: 推进世界
// ---------------------------------------------------------------------------

/** 任务 user 消息 = 最后一条 user, 但跳过破限+预填充关闭时烟火自己追加的收尾 user */
function 查任务消息下标(messages: { role: string; content: string }[]): number {
  const isTailKickoff = (message: { role: string; content: string }, idx: number) =>
    idx === messages.length - 1 && message.role === 'user' && message.content === '现在, 按上述全部规则开始执行任务。';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    if (isTailKickoff(messages[i], i)) continue;
    return i;
  }
  return -1;
}

export async function updateWorld(force = false): Promise<void> {
  if (isUpdating) {
    console.warn('[烟火] 上一次推进尚未完成, 已跳过本次推进');
    return;
  }
  isUpdating = true;
  const debugStore = useDebugStore();
  const updatingStore = useUpdatingStore();
  const abortSignal = updatingStore.start('世界运转中…');
  let parsed: any = null;
  let parseError: Error | null = null;
  try {
    const settings = getSettings();
    const { 地址, 模型 } = settings.接口;
    if (!地址 || !模型) {
      toastWarning('烟火: 尚未配置接口地址或模型, 请先在设置中完成配置', '烟火');
      return;
    }
    let data = 世界状态存档.读取();
    // 主角人设(名字+描述): 描述含"基本信息"等玩家自写资料, 整段原样发给世界引擎(不截断, 以正文实际视角为准), 拿不到也不影响
    let playerName: string | null = null;
    let playerDesc = '';
    try {
      playerName = useHost().persona.name();
      playerDesc = useHost().persona.description().trim();
    } catch {
      playerName = null;
      playerDesc = '';
    }
    // 手动推进: 若最新层已推进过, 先撤销当前快照(状态自动回落到更早楼层的快照),
    // 把最新层当作从未推进过再重推
    if (force) {
      try {
        // 只取尾部窗口找最后一条 AI 楼层(不拉全量), 过滤隐藏楼层
        const lastId = useHost().chat.lastMessageId();
        const tail = useHost().chat.messages(`${Math.max(0, lastId - 60)}-${lastId}`, { role: 'assistant' }).filter(message => !message.is_hidden);
        const lastAssistantFloor = tail.length > 0 ? tail[tail.length - 1].message_id : -1;
        if ((data.处理到楼层 ?? 0) >= lastAssistantFloor && lastAssistantFloor >= 0 && (data.锚点楼层 ?? -1) >= 0) {
          // 撤销锚点楼层的快照再重新读回(状态自动回落到更早快照): 顺序收在保存 module 里
          data = 世界状态存档.重推(data.锚点楼层);
        }
      } catch {
        // 楼层读取失败则跳过撤销
      }
    }
    const recentCount = Math.max(1, settings.运转.读取最近回复数 ?? 3);
    const clearLayer = data.清空层 ?? 0;
    // 自动推进只分析清空之后的楼层; 手动推进(force)强制分析最近 N 条
    let recent = getRecentAssistantMessages(recentCount);
    if (!force) recent = recent.filter(message => message.message_id > clearLayer);
    if (recent.length === 0) {
      if (force) {
        toastWarning('烟火: 没有可分析的AI回复(请确认已生成至少一条AI回复)', '烟火');
      } else {
        console.warn('[烟火] 未找到新的AI回复(清空后或仅剩旧楼层), 跳过本次推进');
      }
      return;
    }
    const filter = createTextFilter(settings.标签);
    // 标注每条回复的顺序, 最后一条为【最新回复】
    const reply = recent
      .map((message, index) => `【${index === recent.length - 1 ? '最新回复' : `较早回复 ${index + 1}`}】\n${filter(message.message)}`)
      .join('\n\n');
    const timeJump = detectTimeJump(reply);
    const replyIds = new Set(recent.map(message => message.message_id));
    // 「最近剧情」上下文只取最新 1 层用户输入
    const context = buildLatestUserInput(recent[recent.length - 1].message_id, filter, replyIds, force ? 0 : clearLayer);
    const worldbook = settings.运转.读取世界书
      ? await getActiveWorldbookText([context, reply].filter(Boolean).join('\n\n'), {
          excludeNames: settings.运转.世界书排除 ?? [],
          includeGlobal: settings.运转.读取全局世界书,
        })
      : '';
    const messages = buildTickMessages({ world: data, reply, replyCount: recent.length, context, timeJump, worldbook, playerName, playerDesc, 破限: settings.运转.破限, 头部填充: settings.运转.头部填充, 头部填充文本: settings.运转.头部填充文本 ?? '', 防截断: settings.运转.防截断, 预填充: settings.运转.预填充, 节令历法: settings.运转.节令历法, 世界指标: settings.运转.世界指标 });
    debugStore.record({
      time: Date.now(),
      model: settings.接口.模型,
      replyIds: recent.map(message => message.message_id),
      replyPreview: reply.slice(0, 150),
      request: messages
        .map(message => `【${message.role === 'system' ? '系统指令' : message.role === 'user' ? '用户' : '助手'}】\n${message.content}`)
        .join('\n\n────────\n\n'),
    });
    console.info(`[烟火] 开始推进世界 (使用最近 ${recent.length} 条回复: #${recent.map(message => message.message_id).join(', #')})`);
    // 发请求 → 解析 → 校验 → 不合格就带着错误原因重试: 这一段与彼方共用(候选5),
    // 节奏/回喂文案/预填充拼回都在 共用/模型往返.ts 里, 这里只交代烟火自己的四件事:
    // 解析怎么切 JSON、校验用什么(schema 规范化)、错误怎么归类、文案叫什么。
    const 往返 = await 共用请求并校验({
      messages,
      找任务下标: 查任务消息下标,
      预填充: settings.运转.预填充,
      signal: abortSignal,
      发请求: chatCompletion,
      解析: content => {
        const 结果 = 解析世界载荷(content);
        if (结果.成功) return 结果.载荷;
        const 错 = Error(结果.原因);
        // "被截断"(有 { 没闭合)与"整段根本不是 JSON"分开: 前者是接口把输出砍在半路, 原样重推一次
        // 往往就成了(2026-10-01 真机实测: 3284 字的世界 JSON 被砍断, 手动重推即成功);
        // 后者同样的提示词重推没用, 当场失败。
        错.name = 结果.截断 ? '截断' : '解析';
        throw 错;
      },
      校验: 候选 => validateAndNormalize(候选, data),
      取JSON片段: content => 解析世界载荷(content).片段,
      // 烟火的口径: "整段不是 JSON" 当场抛出(重试同样的提示词没用), 只有"是 JSON 但结构不合格"才回喂重试;
      // 唯一例外是输出被接口截断——那是"有输出、只是残缺", 归"反馈"让它带着理由重推一次
      // (截断的片段本来就是空的, 回喂里只有一句"JSON 不完整", 不会把半截 JSON 塞回去)。
      判断错误: (error, 阶段) => {
        parseError = error;
        if (阶段 === '解析') return error.name === '截断' ? '反馈' : '致命';
        return 阶段 === '请求' ? '接口' : '反馈';
      },
      名字: '烟火',
      结构失败标签: '推进失败',
      中断文案: '用户已中断本次推进',
      取重试理由: (error) => {
        const errMsg = error.message ?? '';
        return errMsg.includes('JSON') || errMsg.includes('解析') ? 'AI 返回的 JSON 不完整' : 'AI 返回格式不符合要求';
      },
      记日志: 记录 => debugStore.record(记录),
      报进度: (文字) => { updatingStore.message = 文字; },
    });
    parsed = 往返.parsed;
    const newData = parsed as WorldData;
    const diff = 事件账目(data.事件 ?? [], newData.事件 ?? []);
    debugStore.record({
      time: Date.now(),
      addedEvents: diff.added,
      updatedEvents: diff.updated,
      removedEvents: diff.removed,
      summary: newData.小结,
    });
    // 把推进后的世界整体写入本次分析的最后一条楼层(快照随该楼层存亡)。
    // 「靠哪条楼层当锚点 / 处理到楼层 / 清空层 / 超额裁剪」以及往内存里放哪一份(成功与失败
    // 两种结果)都由 保存 module 的「推进落盘」交代; 建仓仍排在落盘之前, 与改造前同序
    const anchorFloor = recent[recent.length - 1].message_id;
    const stateStore = useStateStore();
    stateStore.data = 世界状态存档.推进落盘(newData, anchorFloor).数据;
    // 同步世界动向到角色卡主世界书(蓝灯常驻条目), 供主 AI 读取
    if (settings.运转.注入世界书条目) {
      syncWorldbookEntry(newData, true, settings).catch(error => {
        console.error('[烟火] 同步世界书条目失败:', error);
      });
    }
    const eventCount = newData.事件.length;
    console.info(`[烟火] 世界推进完成: ${newData.小结 || '(无小结)'} (事件 ${eventCount} 件, 新增 ${diff.added.length} 件)`);
    toastSuccess(`烟火: ${newData.小结 || '世界无大事'}`, '烟火');
  } catch (error) {
    if (abortSignal.aborted) {
      const message = '推进已中断';
      debugStore.record({ time: Date.now(), error: message });
      toastInfo(`烟火: ${message}`, '烟火');
      return;
    }
    console.error('[烟火] 推进失败:', error);
    const settingsNow = getSettings();
    const stack = error instanceof Error ? (error.stack ?? '') : '';
    const message = error instanceof Error ? error.message : String(error);
    const detail = [
      '[烟火] 世界推进失败',
      `阶段: ${parseError && parsed === null ? 'JSON 解析' : '接口调用/其他'}`,
      `接口: ${maskBaseUrl(settingsNow.接口.地址) || '(未填)'} / 模型: ${settingsNow.接口.模型 || '(未选)'} / 最大token: ${settingsNow.接口.最大token} / 服务端转发: ${settingsNow.接口.服务端转发 ? '开' : '关'}`,
      `错误: ${message}`,
      ...(stack ? ['堆栈:', stack] : []),
    ].join('\n');
    debugStore.record({ time: Date.now(), error: detail });
    toastError(message, '烟火推进失败');
  } finally {
    isUpdating = false;
    updatingStore.stop();
  }
}
