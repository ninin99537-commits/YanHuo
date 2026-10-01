import json5 from 'json5';
import { chatCompletion, maskBaseUrl } from './api';
import { buildTickMessages } from './prompts';
import type { WorldData, WorldEvent, WorldFaction, WorldMetric, WorldOccasion, WorldSeed } from './schema';
import { EVENT_SCALE, EVENT_SECRECY, EVENT_SPREAD, EVENT_STAGE, METRIC_TREND, SEED_MATURITY } from './schema';
import { getSettings } from './settings';
import {
  discardSnapshotAt,
  ENDED_EVENT_LIMIT,
  EVENT_HISTORY_LIMIT,
  EVENT_LIMIT,
  FACTION_LIMIT,
  METRIC_LIMIT,
  OCCASION_LIMIT,
  REGION_LIMIT,
  SEED_LIMIT,
  TREND_LIMIT,
  loadData,
  useDebugStore,
  useStateStore,
  useUpdatingStore,
  writeStateSnapshot,
} from './state';
import { getActiveWorldbookText } from './worldbook-read';
import { useHost } from './host';
import { syncWorldbookEntry } from './inject';
import { toastError, toastInfo, toastSuccess, toastWarning } from './toast';
import { 请求并校验 as 共用请求并校验 } from '../共用/模型往返';
import { 事件账目, validateAndNormalize } from './世界数据';

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
// AI 输出解析与校验
// ---------------------------------------------------------------------------

/** 逐个 { 起做括号配平, 返回所有完整的顶层对象候选(按出现顺序)。
 *  模型受世界书格式影响时, 烟火 JSON 前后可能跟着自带 { } 的其他格式块(UpdateVariable/思维链伪示例),
 *  所以由调用方在候选里挑出真正的「世界推进」对象, 而不是固定取第一个 { */
function sliceBalancedCandidates(text: string): string[] {
  const out: string[] = [];
  let start = text.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closed = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(text.slice(start, i + 1));
          start = text.indexOf('{', i + 1);
          closed = true;
          break;
        }
      }
    }
    if (!closed) break; // 扫到末尾仍未配平(截断), 没有更多完整候选
  }
  return out;
}

/** 对象是否像「世界推进」载荷(含中文或常见英文核心字段), 用于从多个 JSON 候选中挑出目标 */
function looksLikeWorldPayload(value: any): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).some(key =>
    ['世界', 'world', '地域', 'region', 'regions', '大势', 'trend', 'trends', '事件', 'event', 'events', '势力', 'faction', 'factions'].includes(key),
  );
}

/** AI 偶尔把模板的中文键名翻成英文——按区块把常见英文键名归一成中文, 避免整轮输出被判"格式不符"丢弃 */
const TOP_KEY_ALIASES: Record<string, string> = {
  world: '世界',
  world_info: '世界',
  region: '地域',
  regions: '地域',
  areas: '地域',
  trend: '大势',
  trends: '大势',
  seed: '伏笔',
  seeds: '伏笔',
  foreshadow: '伏笔',
  foreshadows: '伏笔',
  occasion: '节令',
  occasions: '节令',
  festival: '节令',
  festivals: '节令',
  metric: '指标',
  metrics: '指标',
  indicator: '指标',
  indicators: '指标',
  event: '事件',
  events: '事件',
  faction: '势力',
  factions: '势力',
  powers: '势力',
  summary: '小结',
};
const SECTION_FIELD_ALIASES: Record<string, Record<string, string>> = {
  世界: { time: '时间', atmosphere: '氛围', mood: '氛围', overview: '总览', total_overview: '总览' },
  地域: {
    overview: '概况',
    description: '概况',
    situation: '局势',
    state: '局势',
    ruler: '当权者',
    power: '当权者',
    foreign_relations: '对外关系',
    foreign: '对外关系',
    relations: '对外关系',
    background: '前情',
    history: '前情',
  },
  大势: {
    overview: '概况',
    description: '概况',
    progress: '进展',
    direction: '走向',
    trend: '走向',
    background: '前情',
    history: '前情',
  },
  伏笔: {
    title: '标题',
    name: '标题',
    setup: '埋设',
    basis: '埋设',
    aim: '指向',
    direction: '指向',
    point: '指向',
    maturity: '成熟度',
    background: '前情',
    history: '前情',
  },
  节令: {
    name: '名称',
    title: '名称',
    cycle: '周期',
    period: '周期',
    frequency: '周期',
    time: '时间',
    date: '时间',
    overview: '概况',
    description: '概况',
  },
  指标: { value: '值', amount: '值', level: '值', trend: '趋势', direction: '趋势', note: '说明', description: '说明' },
  事件: {
    title: '标题',
    name: '标题',
    description: '描述',
    detail: '描述',
    background: '前情',
    history: '前情',
    change: '变化',
    delta: '变化',
    location: '地点',
    place: '地点',
    time: '时间',
    date: '时间',
    scale: '规模',
    spread: '传播',
    channel: '渠道',
    faction: '势力',
    stage: '阶段',
    secrecy: '隐秘',
    secret: '隐秘',
    representative: '代表人物',
    figure: '代表人物',
  },
  势力: {
    goal: '目标',
    objective: '目标',
    movement: '动向',
    action: '动向',
    background: '前情',
    history: '前情',
    scope: '势力范围',
    range: '势力范围',
    territory: '势力范围',
    relations: '对外关系',
    foreign_relations: '对外关系',
    head: '头面人物',
    leader: '头面人物',
    figure: '头面人物',
  },
};

function remapKeys(value: any, aliases: Record<string, string> | undefined): any {
  if (!aliases || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) out[aliases[key] ?? key] = item;
  return out;
}

function normalizeKeyAliases(parsed: any): any {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(parsed)) out[TOP_KEY_ALIASES[key] ?? key] = value;
  out['世界'] = remapKeys(out['世界'], SECTION_FIELD_ALIASES['世界']);
  for (const section of ['地域', '大势', '指标', '势力']) {
    const record = out[section];
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      const mapped: Record<string, any> = {};
      for (const [name, entry] of Object.entries(record)) mapped[name] = remapKeys(entry, SECTION_FIELD_ALIASES[section]);
      out[section] = mapped;
    }
  }
  for (const section of ['伏笔', '节令', '事件']) {
    const list = out[section];
    if (Array.isArray(list)) out[section] = list.map(item => remapKeys(item, SECTION_FIELD_ALIASES[section]));
  }
  return out;
}

/** 模型可能把内部思考当成顶层字段输出的键名(非烟火数据): 解析前剥离,
 *  其中的裸换行/未转义引号会让 JSON 与 JSON5 全部解析失败 */
const THINKING_FIELD_KEYS = ['静默思考流程', '思考流程', '思考过程', '思维链', '推理过程'];

/** 字符串内的裸控制字符(换行/回车/制表符等)转义为合法 JSON 转义序列。
 *  模型把多行文本直接写进 JSON 字符串时会产生裸换行, JSON.parse 与 json5 都会拒绝。
 *  只在字符串内部做转义, 不改动结构字符。 */
function escapeRawControlCharsInStrings(text: string): string {
  const src = String(text ?? '');
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code === 0x0a) out += '\\n';
      else if (code === 0x0d) out += '\\r';
      else if (code === 0x09) out += '\\t';
      else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
      else out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/** 剥离顶层"静默思考流程"等思考字段(非烟火数据, 直接无视)。
 *  优先按"下一个顶层键"定位值结尾(`,` + 换行 + `"键名"`), 找不到再退回对象结尾 `}`;
 *  切完由调用方用真实解析验证, 切坏则自动降级到原始文本。找不到思考键时原样返回。 */
function stripThinkingFields(text: string): string {
  let result = String(text ?? '');
  for (const key of THINKING_FIELD_KEYS) {
    const keyRe = new RegExp(`"${key}"\\s*:`, 'g');
    let match = keyRe.exec(result);
    while (match) {
      const valueStart = keyRe.lastIndex;
      let end = -1;
      let endWithComma = false;
      // ① 优先: 顶层键分隔符 `,` + 换行 + `"键名"`
      for (let i = valueStart; i < result.length; i++) {
        if (result[i] === ',') {
          const rest = result.slice(i + 1);
          if (/^\s*\n\s*"/.test(rest)) {
            end = i;
            break;
          }
        }
      }
      // ② 退回: 顶层对象结尾 `}`(此时候选会缺数据键, 由调用方判定作废)
      if (end === -1) {
        const closeIdx = result.lastIndexOf('}');
        if (closeIdx > valueStart) {
          end = closeIdx;
          endWithComma = true;
        }
      }
      if (end === -1) break;
      const before = result.slice(0, match.index);
      const after = result.slice(end + (endWithComma ? 0 : 1));
      result = before + after.replace(/^\s*/, '');
      match = keyRe.exec(result);
    }
  }
  return result;
}

function parseModelResponse(content: string): any {
  let text = content.trim();
  const fence = text.match(/^```(?:json|yaml)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  const candidates = sliceBalancedCandidates(text);
  if (candidates.length === 0) {
    throw Error(
      `AI 没有返回 JSON 对象(只输出了文字/推理内容, 或大括号不配平被截断)。\n原始内容(共 ${content.length} 字): ${content.slice(0, 300)}${content.length > 300 ? '……' : ''}`,
    );
  }
  // 优先挑「世界推进」载荷(排除前文伪 JSON 示例); 都不像时退而取第一个能解析的候选
  let fallback: any = null;
  let lastError: unknown = null;
  for (const candidate of candidates) {
    // 思考字段带裸换行/未转义引号, 先剥离; 字符串内裸控制字符再转义兜一层
    const stripped = stripThinkingFields(candidate);
    const variants = [
      ...new Set([
        ...(stripped !== candidate ? [escapeRawControlCharsInStrings(stripped), stripped] : []),
        escapeRawControlCharsInStrings(candidate),
        candidate,
      ]),
    ];
    for (const variant of variants) {
      // 剥离/修复后必须仍是烟火 JSON(含数据键), 否则说明切坏了, 换下一候选
      for (const parse of [(t: string) => JSON.parse(t), (t: string) => json5.parse(t)]) {
        let parsed: any;
        try {
          parsed = parse(variant);
        } catch (error) {
          lastError = error;
          continue;
        }
        const normalized = normalizeKeyAliases(parsed);
        if (looksLikeWorldPayload(normalized)) return normalized;
        if (fallback === null) fallback = normalized;
      }
    }
  }
  if (fallback !== null) return fallback;
  throw Error(
    `AI 返回的 JSON 不完整或格式错误(已自动重试, 多次失败请调大「最大输出Token」或检查模型)。解析错误: ${lastError instanceof Error ? lastError.message : String(lastError)}\n原始内容(共 ${content.length} 字): ${content.slice(0, 400)}${content.length > 400 ? '……' : ''}`,
    { cause: lastError },
  );
}

/** 从 AI 原始输出中提取 JSON 部分(去思维链/正文等杂质), 供重试时回喂给 AI 指明格式错误 */
function extractJsonSnippet(content: string): string {
  let text = String(content || '').trim();
  const fence = text.match(/^```(?:json|yaml)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  const candidate = sliceBalancedCandidates(text)[0];
  if (!candidate) return '';
  // 思考字段可能超长, 回喂给 AI 前先剥离, 免得挤掉真正的格式错误信息
  return stripThinkingFields(candidate).trim() || candidate;
}

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
    let data = loadData();
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
          discardSnapshotAt(data.锚点楼层);
          data = loadData();
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
      解析: content => parseModelResponse(content),
      校验: 候选 => validateAndNormalize(候选, data),
      取JSON片段: content => extractJsonSnippet(content),
      // 烟火的口径: "整段不是 JSON" 当场抛出(重试同样的提示词没用), 只有"是 JSON 但结构不合格"才回喂重试
      判断错误: (error, 阶段) => {
        parseError = error;
        return 阶段 === '解析' ? '致命' : 阶段 === '请求' ? '接口' : '反馈';
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
    // 把推进后的世界整体写入本次分析的最后一条楼层(快照随该楼层存亡)
    const anchorFloor = recent[recent.length - 1].message_id;
    newData.处理到楼层 = anchorFloor;
    newData.清空层 = 0;
    const stateStore = useStateStore();
    if (writeStateSnapshot(newData, anchorFloor, anchorFloor, true)) {
      stateStore.data = { ...newData, 锚点楼层: anchorFloor };
    } else {
      stateStore.data = newData;
    }
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
