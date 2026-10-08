// 烟火 · 解析抢救层(候选2) —— 「原始文本 → 世界载荷」只此一份
// ---------------------------------------------------------------------------
// 这一层(约 400 行)几乎全是纯函数与纯表: 括号配平切分 / 载荷识别 / 中英键名别名表 /
// 思考字段剥离 + 裸控制字符转义 / 双解析器 × 多变体择优。以前它长在 update.ts 里、全部私有,
// 六层薄带只能从 updateWorld 的最顶端进 —— 想验证"前文有伪 JSON 示例时挑对了候选"这么一件事,
// 也得先搭出 150 行假宿主(聊天楼层 / 变量表 / 世界书 / 模型接口)才够得着,
// 于是最该被钉住的逻辑反而成了整份 update.ts 里最不可测的部分。
// 现在它单独成 module: 对外只有 解析世界载荷(原始文本), 择优、别名、剥离、转义都在内部,
// 用例可以直接喂字符串(tests/parse-rescue.test.ts), 不用喂平台。
// 搬迁时逐字保留原逻辑、原表、原正则与原注释 —— 只调整"从哪 import"。
// 注: 本文件与 彼方_NPC幕后生命状态系统/模型请求.ts 是各自长出来的两份同源实现,
//     细节已经不一致(见文件末尾「两份的同源差异」), 这里按烟火现行逻辑原样搬, 不做合并。
import json5 from 'json5';

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
  // 只在原文本本来就带这个键时才改写: 否则会凭空多出一个值为 undefined 的「世界」键, 而
  // Object.keys 照样数它 —— 下游 looksLikeWorldPayload 会对任何可解析对象恒真, 于是
  // "优先挑世界推进载荷"、"都不像时取第一个"、"剥离切坏就降级到原文"三件事一起失效。
  // (其余六个别名区块本来就按值形态守卫 —— record && typeof === 'object' / Array.isArray ——
  //  缺失时根本不会写键, 所以没有第二处可修; 这里跟它们跟上同一个口径。)
  if ('世界' in out) out['世界'] = remapKeys(out['世界'], SECTION_FIELD_ALIASES['世界']);
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
      // 重建后必须重置 lastIndex: keyRe 是全局正则, 否则它会从旧字符串的位置继续扫,
      // 漏掉重建后从更前面挪过来的重复思考字段(彼方那份一直有这一行, 这边漏了)。
      keyRe.lastIndex = 0;
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

// ---------------------------------------------------------------------------
// 对外入口: 原始文本 → 世界载荷
// ---------------------------------------------------------------------------

export type 解析结果 =
  | { 成功: true; 载荷: any }
  | { 成功: false; 原因: string; 截断: boolean };

/** 唯一入口。解析成功给载荷; 失败给原因(原文案原样)。
 *
 *  截断 = 文本里 '{' 比 '}' 多 —— 输出在半路被切了(未闭合的那个可能是最外层的, 内层早已闭合,
 *  所以只能数括号, 不能比"最后一个 {' 和最后一个 }"的位置)。
 *  这个区分是给调用方定"重试值不值"用的: 2026-10-01 真机上遇到过接口把 3284 字的世界 JSON
 *  砍断, 同一个提示词原样重推一次就成功了(见 update.ts 的判断错误)。
 *  只在解析失败这条路上算: 真解析成功了就不看它; 失败时多余的 '{' 就是截断的强证据,
 *  万一误判, 代价也只是把这次当接口问题原样重推一遍, 不会改坏数据。 */
export function 解析世界载荷(原始文本: string): 解析结果 {
  try {
    return { 成功: true, 载荷: parseModelResponse(原始文本) };
  } catch (error) {
    const 截断 = (原始文本.match(/\{/g) ?? []).length > (原始文本.match(/\}/g) ?? []).length;
    return { 成功: false, 原因: error instanceof Error ? error.message : String(error), 截断 };
  }
}

// ---------------------------------------------------------------------------
// 两份的同源差异(仅记录, 不合并 —— 搬完只修了 normalizeKeyAliases 一处凭空造键的缺陷,
// 下面这四条差异一条都没动)
// ---------------------------------------------------------------------------
// 彼方/模型请求.ts 里有一份同源实现(它那边叫 sliceBalancedJson/, 且把候选挑选、思考字段剥离
// 都长在 parseModelResponse 里)。逐字比对后已经不一致的地方:
//  1. 本文件的 stripThinkingFields 切完一个思考字段后直接 keyRe.exec(result) 接着扫,
//     没有把 keyRe.lastIndex 归零; 彼方那份显式写了 keyRe.lastIndex = 0, 并留了注释
//     "重建后必须重置 lastIndex: 全局正则否则会从旧位置继续, 漏掉重复出现的思考字段"。
//     → 同一段文本里若同一个思考键重复出现两次, 两份的剥离结果会不同。
//  2. 候选挑选: 本文件先切出全部候选、再逐个(多变体 / 双解析器)挑「世界推进」载荷, 全部不像时
//     退而取第一个能解析的对象(fallback); 彼方是边切边按文本里是否含 '"剧情时间"' 判定,
//     没有 fallback。
//  3. 报错文案与截断长度不同(本文件 300/400 字, 彼方 400/600 字), 且彼方失败时会打一条
//     console.warn(本文件没有任何 console 输出)。
