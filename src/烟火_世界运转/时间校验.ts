// 烟火 · 正文时间约束
//
// 世界引擎可以维护正文镜头之外的事件, 但世界时钟不能脱离正文凭空向未来漂移。
// 这里把"从正文认出时间"与"校验 AI 返回的世界时间"收成纯函数, 供提示词和数据
// 校验共同使用。纯函数不碰酒馆平台, 可以直接在 node 用例里覆盖真实跳跃与误跳跃。

export type 日期值 = {
  年: number;
  月: number;
  日: number;
  天: number;
};

export type 世界时间约束 = {
  类型: '正文绝对时间' | '正文相对跳跃' | '无正文时间';
  正文日期: 日期值 | null;
  最早日期: 日期值 | null;
  最晚日期: 日期值 | null;
  跳跃: string | null;
  提示: string;
};

/**
 * 相对跳跃词表: 词义 → 世界时间可落的天数区间。
 *
 * v2.8 对着"卡片正文会自然写出的时间表达"整张复查过一遍。判据只有一条:
 * **卡片正文会自然写出它, 而它确实表示跨日。**
 *
 * 复查**补进来**的: 翌日 / 隔日 / 转天 / 第二日(=次日); 数日后(=几天后);
 * 十来天后(=十几天后); 一个星期后 / 一星期后 / 一周后(=7 天); 半个月后(=15 天);
 * 大半年后(6~9 个月); 以及全表统一的"…之后"写法(三天之后 / 两周之后 / 半年之后, 由 归一跳跃词 折算)。
 * 带具体天数的"N天后 / N日后 / N天之后 / N日之后"不写在这里——min/max 是变量, 由 找跳跃们 单独认。
 *
 * **故意不收的**(写下来, 免得下一个人再问一遍):
 *  - 半晌后 / 片刻后 / 一会儿后 / 少顷: 表示几小时以内, **不跨日**。世界时间的时分由模型按剧情补全
 *    (§13 已定: 时钟·时分在码里看不见), 跨日判定只认"天";
 *  - 当天 / 同日 / 当晚 / 今天: 0 天, 本来就不是跳跃(默认态就是"未跨日");
 *  - 第三天 / 半个月里: 语义取决于故事起点, 而不是"从上轮世界时间算 +N"——给 min/max 会误判
 *    (第二天 / 第二日 是既有裁决, 保留);
 *  - 日后 / 之后(不带数字): 指"将来的某天", 不是跳跃;
 *  - "10月14日之后"这类**日期后缀**: 它是绝对日期不是跳跃词, 由 找跳跃们 的左边界挡掉
 *    (数字紧跟在 数字/年/月/日/-///. 后面就不算)。
 */
const 相对跳跃 = [
  { pattern: /一夜之间|第二天一早|第二天|第二日|次日|翌日|隔日|隔天|转天/, text: '次日', min: 1, max: 1 },
  { pattern: /十几天后|十来天后/, text: '十几天后', min: 10, max: 19 },
  { pattern: /一两周后/, text: '一两周后', min: 7, max: 14 },
  { pattern: /两周后/, text: '两周后', min: 14, max: 14 },
  { pattern: /一个星期后|一星期后|一周后/, text: '一周后', min: 7, max: 7 },
  { pattern: /几周后|数周后|几个星期后|几个礼拜后/, text: '几周后', min: 14, max: 56 },
  { pattern: /几天后|数天后|数日后/, text: '几天后', min: 2, max: 14 },
  { pattern: /半个月后/, text: '半个月后', min: 15, max: 15 },
  { pattern: /一个月后/, text: '一个月后', min: 28, max: 31 },
  { pattern: /两个月后/, text: '两个月后', min: 56, max: 62 },
  { pattern: /大半年后/, text: '大半年后', min: 180, max: 270 },
  { pattern: /半年后/, text: '半年后', min: 180, max: 184 },
  { pattern: /一年后/, text: '一年后', min: 365, max: 366 },
  { pattern: /两年后/, text: '两年后', min: 730, max: 731 },
  { pattern: /几个月后|数月后/, text: '几个月后', min: 60, max: 365 },
  { pattern: /几年后|数年后|多年后|若干年后/, text: '几年后', min: 730, max: 3650 },
] as const;

function 天数(年: number, 月: number, 日: number): number {
  const date = new Date(0);
  date.setUTCFullYear(年, 月 - 1, 日);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function 合法日期(年: number, 月: number, 日: number): 日期值 | null {
  if (月 < 1 || 月 > 12 || 日 < 1 || 日 > 31) return null;
  const 天 = 天数(年, 月, 日);
  const date = new Date(天);
  if (date.getUTCFullYear() !== 年 || date.getUTCMonth() + 1 !== 月 || date.getUTCDate() !== 日) return null;
  return { 年, 月, 日, 天 };
}

/**
 * 解析烟火世界时间或正文里的绝对日期 —— **世界时钟的唯一解析入口**(跨日、校验、完成日志都从这里过)。
 *
 * 支持两种写法, 缺一不可:
 *   - 中文: `2008年5月2日 08:15` / `2008年5月2号`(真机上引擎实际写出来的就是这种;
 *     时:分只是附带信息, 跨日判定只认"天", 见 §13);
 *   - ISO:  `2008-05-02 08:15` / `2008/5/2` / `2008.5.2`。
 * v2.8.5 D3 备注: 曾经担心"世界时间只存年月日、而解析只认 ISO, 于是跨日算不出来"——
 * 实际不会: 中文分支一直在, 两个格式都能进。这条顾虑已由 `tests/yanhuo-time-guard.test.ts [7]`
 * 逐条钉住(含"没有正文日期、只有上轮年月日世界时间"这一路)。
 */
export function 解析日期(text: unknown): 日期值 | null {
  const value = String(text ?? '').trim();
  const cn = /(\d{4})年(\d{1,2})月(\d{1,2})[日号]/.exec(value);
  if (cn) return 合法日期(Number(cn[1]), Number(cn[2]), Number(cn[3]));
  const iso = /(?:^|[^\d])(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[^\d]|$)/.exec(value);
  if (iso) return 合法日期(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  return null;
}

function 加天(日期: 日期值, days: number): 日期值 {
  const date = new Date(日期.天);
  date.setUTCDate(date.getUTCDate() + days);
  return 合法日期(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())!;
}

// ---------------------------------------------------------------------------
// 时间证据: 当前场景 / 叙述 / 引述 / 回忆 / 未来约定
// ---------------------------------------------------------------------------
// v2.8 之前这里只有"正文最先出现的日期"。链条详审 第10项 指出两个方向的误判:
//   ① 一层里先给旧场景日期、后切到新日期 → 取第一个就落后;
//   ② 正文没有场景日期, 但引述/回忆/未来约定里先出现日期 → 取第一个就凭空跳。
// 两个方向相反, 所以**不能简单改成"取最后一个日期"**。现在改成先认时间证据:
//   - **明确场景时间标记**(【场景时间】/【当前时间】/【时间】/场景时间：/时间：…)优先, 紧跟其后的
//     **绝对日期**就是当前场景; 同一层出现多个场景标记时, 当前时间是**最后一个**有效时间终点;
//   - 没有标记时, 只在**独立叙述位置**认日期(段首, 或紧跟"…后/次日/来到/已是"这类推进词),
//     句子中间顺带提到的日期不算;
//   - 引号内、以及引述/回忆/未来约定的段落里, 日期与跳跃词一律**不采纳**(只记进证据供上层说明);
//   - 回忆协议块(`<recall>…</recall>`)与裸 AM 编码行不是世界时钟原料:
//     "AM0256 | 0m" 不是当前动作, "185d17h15m" 不是让世界时钟跳 185 天的指令;
//     协议块没闭合时**整层不做时钟判定**(不拿半截层的 prefix 推日期)。
export type 时间跳跃 = { text: string; min: number; max: number };

export type 时间证据 = {
  /** 该证据所在的句子(原文片段, 用于诊断与提示) */
  文本: string;
  日期: 日期值 | null;
  跳跃: 时间跳跃 | null;
  来源: '场景标记' | '叙述日期' | '叙述跳跃' | '未采纳';
  /** 仅在 来源='未采纳' 时非空: 引述 / 回忆 / 未来约定 / 非场景位置 */
  未采纳原因: string | null;
};

/**
 * 明确场景时间标记。
 * 两类写法都认: 方括号式(【场景时间】【当前时间】【时间】)与行内式("场景时间：""时间：")。
 * 行内"时间："是现有卡片最常见的写法("时间：2039年7月13日11:35"、"地点：X | 时间：2039-07-13 …"),
 * 它只让**紧跟其后的绝对日期**成为场景时间; "时间：三天后"里没有日期, 照旧按相对跳跃处理。
 */
const 场景标记 = /【\s*(?:场景|当前|现在|此刻)?时间\s*】|(?:场景|当前|现在|此刻)?时间\s*[::：]/;

/** 引述线索: 说的不是"此刻发生", 而是某个人/某份文书里的话 */
const 引述线索 = /引述|原话|口信|据说|听说|声称|转述|记载|诏书|公文|信上|纸上|账上|笔记|写着|念道|说道|问道|答道|喊道|叫道|笑道|低声道|告诉你|告诉他|对.{0,4}说|他\s*说|她\s*说/;

/** 回忆线索: 指向"以前", 不是当前场景 */
const 回忆线索 = /回想|回忆|忆起|想起|记得|记忆|梦里|梦见|梦到|往事|当年|昔日|曾经|从前|那时|旧事|前尘|追溯|上回|上次|多年前|早先|早年|往昔|回首/;

/** 未来约定线索: 计划/约定不是已经过去的时间 */
const 未来线索 = /计划|打算|约定|约好|将要|将会|未来|将来|今后|明日|明天|届时|预计|承诺|答应|发誓|说好|等到|盘算|琢磨着/;

const 回溯块 = /<recall>[\s\S]*?<\/recall>/g;
// 说明段只从固定协议开头起算(不带"本行任意前缀"): 协议同一行前面写的行动不能被吞掉。
const 说明段 = /以上是用户的本轮输入[\s\S]*?(?=<recall>)/g;

/**
 * 时间原料里先剥掉回忆协议块与裸 AM 编码行。
 * 对**时间**比"模型正文"更狠是故意的: 一条旧记忆的日期被当成本轮场景时间, 方向就是错的。
 *
 * 未闭合(或闭合多出来)时**整层不采用**, 返回空串: 不许拿半截层的 prefix 推时钟 ——
 * 协议在哪结束不知道, 前面那半层是完整场景还是回忆的开头也无从判断。这一层的时间证据
 * 由 单段证据 自然变成空, 世界时钟保持旧日期 + 在提示里说明。
 */
function 剥离回忆协议块(文本: string): string {
  const 开 = (文本.match(/<recall>/g) ?? []).length;
  const 闭 = (文本.match(/<\/recall>/g) ?? []).length;
  if (开 !== 闭)
    return '';
  return 文本
    .replace(说明段, '')
    .replace(回溯块, '')
    .replace(/^[ \t]*AM\d+[ \t]*\|[^\n]*$/gm, '');
}

function 最新正文段(reply: string): string {
  const marker = '【最新回复】';
  const index = reply.lastIndexOf(marker);
  return index >= 0 ? reply.slice(index + marker.length) : reply;
}

/** 一条或多条新正文 → 要分析的正文段(每条各自只取最新回复段) */
function 正文段列表(reply: string | readonly string[]): string[] {
  const 列表 = Array.isArray(reply) ? reply : [reply];
  return 列表.map(段 => 最新正文段(String(段 ?? '')));
}

/** 中文引号(可跨行)与英文双引号(不跨行)里的内容: 引述/对白 */
function 引号区间(text: string): Array<[number, number]> {
  const 区间: Array<[number, number]> = [];
  for (const match of text.matchAll(/[“「『][\s\S]*?[”」』]/g))
    区间.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  for (const match of text.matchAll(/"[^"\n]*"/g))
    区间.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  return 区间;
}

function 在引号内(区间: Array<[number, number]>, index: number): boolean {
  return 区间.some(([起, 止]) => index >= 起 && index < 止);
}

/** 某个位置所在句子(以 。！？；; 换行 分段) */
function 所在段(text: string, index: number): { 起: number; 文: string } {
  let 起 = 0;
  const 段界 = /[。！？；;\n]/g;
  let 匹配: RegExpExecArray | null;
  while ((匹配 = 段界.exec(text)) && 匹配.index < index)
    起 = 匹配.index + 匹配[0].length;
  const 余 = text.slice(index);
  const 止相对 = 余.search(/[。！？；;\n]/);
  const 止 = 止相对 >= 0 ? index + 止相对 : text.length;
  return { 起, 文: text.slice(起, 止) };
}

/** 日期是否紧跟在一个明确场景时间标记后面("【场景时间】" 与日期之间只有空白/标点) */
function 紧跟在场景标记后(text: string, index: number): boolean {
  const 标记 = new RegExp(场景标记.source, 'g');
  let 起 = -1;
  let 匹配: RegExpExecArray | null;
  while ((匹配 = 标记.exec(text)) && 匹配.index + 匹配[0].length <= index)
    起 = 匹配.index + 匹配[0].length;
  if (起 < 0)
    return false;
  return /^[\s·、,，:：\-—…|｜]*$/.test(text.slice(起, index));
}

/** 引述/回忆/未来约定 → 不采纳原因; 都不是则 null */
function 排除原因(段文: string, index: number, 引号: Array<[number, number]>): string | null {
  if (在引号内(引号, index))
    return '引述';
  if (引述线索.test(段文))
    return '引述';
  if (回忆线索.test(段文))
    return '回忆';
  if (未来线索.test(段文))
    return '未来约定';
  return null;
}

/** 独立叙述位置: 段首, 或紧跟"…后 / 次日 / 来到 / 已是"这类推进词 */
function 属于独立叙述(段文: string, 段起: number, index: number): boolean {
  const 前 = 段文.slice(0, index - 段起);
  if (前.replace(/[\s·、,，:：\-—…|｜【】]/g, '') === '')
    return true;
  return /(?:后|过后|次日|翌日|隔日|转天|第二日|第二天|来到|已是|到了|时至|转眼|过了|又过)\s*[，,]?\s*$/.test(前);
}

/** 正文里所有合法绝对日期(带位置) */
function 找日期们(text: string): Array<{ index: number; date: 日期值 }> {
  const 结果: Array<{ index: number; date: 日期值 }> = [];
  for (const match of text.matchAll(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]/g)) {
    const date = 合法日期(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date)
      结果.push({ index: match.index ?? 0, date });
  }
  for (const match of text.matchAll(/(?:^|[^\d])(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[^\d]|$)/g)) {
    const date = 合法日期(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date)
      结果.push({ index: (match.index ?? 0) + match[0].indexOf(match[1]), date });
  }
  return 结果.sort((a, b) => a.index - b.index);
}

/**
 * 正文里所有跳跃词(带位置)。词表与"带具体天数"的写法都在这儿, 只多做两件事:
 * 给出位置(供排除引述/回忆)与保留原有左边界(挡住"十五天后→五天""10月14日之后→14天后")。
 */
function 找跳跃们(text: string): Array<{ index: number; 跳跃: 时间跳跃 }> {
  const 结果: Array<{ index: number; 长度: number; 跳跃: 时间跳跃 }> = [];
  for (const match of text.matchAll(/(?:^|[^\d年月日\-/.])(\d+)\s*[天日]后/g)) {
    const 天 = Number(match[1]);
    const index = (match.index ?? 0) + match[0].indexOf(match[1]);
    if (天 >= 1 && 天 <= 3650)
      结果.push({ index, 长度: match[0].length - (match[0].indexOf(match[1])), 跳跃: { text: `${match[1]}天后`, min: 天, max: 天 } });
  }
  for (const match of text.matchAll(/(?:^|[^一二三四五六七八九十两\d年月日])(十[一二三四五六七八九]?|[一二三四五六七八九两])[天日]后/g)) {
    const 词 = match[1];
    const 天 = 词.length === 1 ? 中文数[词] : 10 + 中文数[词[1]];
    const index = (match.index ?? 0) + match[0].indexOf(词);
    if (天 >= 1)
      结果.push({ index, 长度: match[0].length - (match[0].indexOf(词)), 跳跃: { text: `${词}天后`, min: 天, max: 天 } });
  }
  for (const 词条 of 相对跳跃) {
    // 词条正则本身不带 g; 这里逐处找, 免得"前一句在引述里、后一句才是叙述"时把真的那次丢掉
    const 匹配们 = text.matchAll(new RegExp(词条.pattern.source, 'g'));
    for (const 匹配 of 匹配们)
      结果.push({ index: 匹配.index ?? 0, 长度: 匹配[0].length, 跳跃: { text: 词条.text, min: 词条.min, max: 词条.max } });
  }
  // 同一处可能同时命中长词与短词(「十几天后」也含「十天后」, 「大半年后」也含「半年后」)。
  // 取覆盖该位置的最长匹配, 丢弃被它覆盖的短匹配, 否则一次跳跃会被重复累计成 20~38 天。
  结果.sort((a, b) => a.index - b.index || b.长度 - a.长度);
  const 去重: Array<{ index: number; 长度: number; 跳跃: 时间跳跃 }> = [];
  for (const 项 of 结果) {
    const 上一项 = 去重[去重.length - 1];
    if (上一项 && 项.index < 上一项.index + 上一项.长度)
      continue;
    去重.push(项);
  }
  return 去重.map(({ index, 跳跃 }) => ({ index, 跳跃 }));
}

/** 多层各自跳一次时累计(较早一层写了"两天后"、最后一条只续写动作, 不能漏那两天) */
function 合并跳跃(列表: 时间跳跃[]): 时间跳跃 | null {
  if (列表.length === 0)
    return null;
  return {
    text: [...new Set(列表.map(跳跃 => 跳跃.text))].join('、'),
    min: 列表.reduce((合计, 跳跃) => 合计 + 跳跃.min, 0),
    max: 列表.reduce((合计, 跳跃) => 合计 + 跳跃.max, 0),
  };
}

/** 一段正文的时间证据(逐条; 日期与前后的跳跃都在里面) */
function 单段证据(正文: string): 时间证据[] {
  const 结果: 时间证据[] = [];
  const 文本 = 归一跳跃词(剥离回忆协议块(正文));
  if (!文本.trim())
    return 结果;
  const 引号 = 引号区间(文本);
  for (const { index, date } of 找日期们(文本)) {
    const { 起, 文: 段文 } = 所在段(文本, index);
    if (紧跟在场景标记后(文本, index)) {
      结果.push({ 文本: 段文, 日期: date, 跳跃: null, 来源: '场景标记', 未采纳原因: null });
      continue;
    }
    const 原因 = 排除原因(段文, index, 引号);
    if (原因) {
      结果.push({ 文本: 段文, 日期: date, 跳跃: null, 来源: '未采纳', 未采纳原因: 原因 });
      continue;
    }
    if (!属于独立叙述(段文, 起, index)) {
      结果.push({ 文本: 段文, 日期: date, 跳跃: null, 来源: '未采纳', 未采纳原因: '非场景位置' });
      continue;
    }
    结果.push({ 文本: 段文, 日期: date, 跳跃: null, 来源: '叙述日期', 未采纳原因: null });
  }
  for (const { index, 跳跃 } of 找跳跃们(文本)) {
    const { 文: 段文 } = 所在段(文本, index);
    const 原因 = 排除原因(段文, index, 引号);
    if (原因) {
      结果.push({ 文本: 段文, 日期: null, 跳跃, 来源: '未采纳', 未采纳原因: 原因 });
      continue;
    }
    结果.push({ 文本: 段文, 日期: null, 跳跃, 来源: '叙述跳跃', 未采纳原因: null });
  }
  return 结果;
}

/** 一条或多条新正文 → 逐段的时间证据(按正文先后顺序摊平) */
function 分段证据(reply: string | readonly string[]): 时间证据[][] {
  return 正文段列表(reply).map(单段证据);
}

/**
 * 从新正文里提取**结构化的时间证据**(只认当前场景/叙述, 引述·回忆·未来约定记成"未采纳")。
 * 主代理可以直接读它做诊断; `建立世界时间约束` 也走这一条, 保证两边口径一样。
 */
export function 提取正文时间证据(reply: string | readonly string[]): 时间证据[] {
  return 分段证据(reply).flat();
}

/**
 * 只从最新正文段提取日期, 不读取世界书或旧快照。
 * 场景时间标记优先; 没有标记时取**最先出现的独立叙述日期**(正文顶部通常就是场景时间)。
 * 引述/回忆/未来约定里的日期不会在这里冒出来。
 */
export function 提取正文日期(reply: string | readonly string[]): 日期值 | null {
  const 证据 = 提取正文时间证据(reply);
  const 场景 = 证据.find(条 => 条.来源 === '场景标记' && 条.日期);
  if (场景?.日期)
    return 场景.日期;
  const 叙述 = 证据.find(条 => 条.来源 === '叙述日期' && 条.日期);
  return 叙述?.日期 ?? null;
}

/** 词形归一: 把"…之后"折成"…后"(三天之后 = 三天后, 半年之后 = 半年后), 免得每个词条都要写两遍。 */
function 归一跳跃词(text: string): string {
  return text.replace(/([天日周月年])之后/g, '$1后');
}

/** 中文数字(一~十; "两"当 2 用) —— 找跳跃们 认"三天后 / 十五天后"时用 */
const 中文数: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

// "三天后 / 15天后 / 十五天后 / 三日后"这类**带具体天数**的跳跃词在 找跳跃们 里认。
// 两处边界照旧(它们由 v2.8 §3 定下来, 这次只加了"给位置"):
//  - 左边界的字符类挡掉"十X 被读成 X"(否则"十五天后"会变成 5 天)与**日期后缀**
//    ("10月14日之后"里的"14日后"不是跳跃词, 前面跟着 数字/年/月/日/-///. 都不算);
//  - "天"与"日"两种写法都认(古风卡多写"三日后"), 上限 3650 天挡住离谱数字。

/**
 * 根据新正文与上轮世界时间建立本轮时间约束。
 * - 有明确场景日期: 世界日期必须与正文日期一致, 允许正文一层跨越任意时长;
 *   同一层多个场景时间标记时, 取**最后一个**有效时间终点;
 * - 只有相对跳跃: 按词义给出日期范围; 多层各跳一次时按天累计(更新频率 > 1 时不漏中间跨日);
 * - 没有时间: 世界日期必须原样沿用, 防止每轮惯性加天; 引述/回忆/未来约定里出现过的
 *   日期只在提示里说明"未作为当前场景时间", 不当成时钟依据。
 *
 * `reply` 可以是**多条新正文**(按时间先后), 也可以是 update.ts 那种已标注
 * 【较早回复 n】/【最新回复】 的一整段 —— 两种形状都吃得下。
 */
export function 建立世界时间约束(reply: string | readonly string[], oldWorldTime: string): 世界时间约束 {
  const 各段 = 分段证据(reply);
  const 证据 = 各段.flat();
  const 未采纳原因 = [...new Set(证据.filter(条 => 条.来源 === '未采纳' && 条.未采纳原因).map(条 => 条.未采纳原因!))];
  const 排除说明 = 未采纳原因.length > 0
    ? `（正文里的时间出现在${未采纳原因.join('、')}中，未作为当前场景时间）`
    : '';
  const 显示 = (日期: 日期值) => `${日期.年}-${String(日期.月).padStart(2, '0')}-${String(日期.日).padStart(2, '0')}`;

  // 按正文先后逐段推进"当前场景时间": 一段给出日期就落到那一天; 只有跳跃词就从当前日期往后推。
  // 这样较早一段写的"两天后"不会被最后一段的"续写动作"吞掉。
  let 绝对日期: 日期值 | null = null;
  let 绝对来源: 时间证据['来源'] | null = null;
  let 最早日期: 日期值 | null = null;
  let 最晚日期: 日期值 | null = null;
  const 跳跃们: 时间跳跃[] = [];
  for (const 段 of 各段) {
    const 段日期条 = 段.filter(条 => (条.来源 === '场景标记' || 条.来源 === '叙述日期') && 条.日期);
    const 段跳跃们 = 段.filter(条 => 条.来源 === '叙述跳跃' && 条.跳跃).map(条 => 条.跳跃!);
    跳跃们.push(...段跳跃们);
    if (段日期条.length > 0) {
      const 最后 = 段日期条[段日期条.length - 1];
      绝对日期 = 最后.日期!;
      绝对来源 = 最后.来源;
      最早日期 = 绝对日期;
      最晚日期 = 绝对日期;
      continue;
    }
    const 段跳跃 = 合并跳跃(段跳跃们);
    const 基准最早 = 最早日期 ?? 解析日期(oldWorldTime);
    const 基准最晚 = 最晚日期 ?? 解析日期(oldWorldTime);
    if (段跳跃 && 基准最早 && 基准最晚) {
      最早日期 = 加天(基准最早, 段跳跃.min);
      最晚日期 = 加天(基准最晚, 段跳跃.max);
    }
  }

  const 跳跃 = 合并跳跃(跳跃们);
  const 场景说明 = 绝对来源 === '场景标记' ? '（当前时间取自正文的场景时间标记；同一层出现多个场景时间时取最后一个时间终点）' : '';

  if (绝对日期 && 最早日期 && 最晚日期) {
    const 是区间 = 最早日期.天 !== 最晚日期.天;
    return {
      类型: '正文绝对时间',
      正文日期: 绝对日期,
      最早日期,
      最晚日期,
      跳跃: 跳跃?.text ?? null,
      提示: 是区间
        ? `正文明确日期为 ${显示(绝对日期)}，之后正文又推进到 ${显示(最早日期)}${最早日期.天 === 最晚日期.天 ? '' : ` 至 ${显示(最晚日期)}`}；世界时间日期必须落在该范围内。${场景说明}${排除说明}`
        : `正文明确日期为 ${显示(绝对日期)}，世界时间日期必须与该日期一致；正文若跨越数小时、数天或数月，只要正文明确写出新的日期就允许。${场景说明}${排除说明}`,
    };
  }
  if (!绝对日期 && 最早日期 && 最晚日期 && 跳跃 && 解析日期(oldWorldTime)) {
    return {
      类型: '正文相对跳跃',
      正文日期: null,
      最早日期,
      最晚日期,
      跳跃: 跳跃.text,
      提示: `正文出现“${跳跃.text}”，世界时间日期必须落在上轮日期之后 ${跳跃.min}~${跳跃.max} 天的范围内；不得跳到范围之外。${排除说明}`,
    };
  }
  const 旧日期 = 解析日期(oldWorldTime);
  return {
    类型: '无正文时间',
    正文日期: null,
    最早日期: 旧日期,
    最晚日期: 旧日期,
    跳跃: null,
    提示: (旧日期
      ? `正文没有明确时间或跳跃词，世界时间日期必须沿用上轮日期 ${显示(旧日期)}；不得自行跨日。`
      : '正文没有明确时间，且上轮世界时间不可解析；请不要凭世界书未来日期自行跳日。') + 排除说明,
  };
}

/**
 * 校验模型返回的世界时间。
 *
 * 两条边界的口径(v2.8 P1「时间证据」):
 *  - **旧/约束已经是可解析公历**时, 新输出突然变成非法公历或乱码("傍晚"、"2008年13月40日")
 *    要拒绝 —— 否则一个坏值就能把整条世界时钟弄成永久"不可判定";
 *  - **真正的未知历法**(古代/仙侠卡的"元和三年·三月初七")仍然明确降级: 约束没有公历边界,
 *    这里一律不拦, 不改写、不强行解析时分。
 */
export function 校验世界时间(worldTime: string, constraint: 世界时间约束): void {
  const 世界日期 = 解析日期(worldTime);
  const 有公历边界 = !!(constraint.最早日期 && constraint.最晚日期);
  if (!世界日期) {
    if (有公历边界) {
      const 原值 = String(worldTime ?? '').trim();
      throw Error(`「世界.时间」无法解析为公历日期（${原值 || '空'}）：上轮世界时间或正文已有可解析的公历日期，不能突然换成非法公历或乱码，请重新输出；${constraint.提示}`);
    }
    return;
  }
  if (!有公历边界) return;
  if (世界日期.天 < constraint.最早日期!.天 || 世界日期.天 > constraint.最晚日期!.天) {
    const lower = `${constraint.最早日期!.年}-${String(constraint.最早日期!.月).padStart(2, '0')}-${String(constraint.最早日期!.日).padStart(2, '0')}`;
    const upper = `${constraint.最晚日期!.年}-${String(constraint.最晚日期!.月).padStart(2, '0')}-${String(constraint.最晚日期!.日).padStart(2, '0')}`;
    throw Error(`「世界.时间」日期 ${世界日期.年}-${String(世界日期.月).padStart(2, '0')}-${String(世界日期.日).padStart(2, '0')} 超出正文时间约束 ${lower}${lower === upper ? '' : ` 至 ${upper}`}；${constraint.提示}`);
  }
}

/**
 * 跨日判定(脚本给出的事实, 不是让模型估的时长):
 *  - `{ 最少, 最多 }`: 本轮跨了 k 个世界日;
 *  - `'首次'`: **没有上轮世界时间**(开局第一轮)。它既不是"跨了"也不是"解析不出来"——
 *    报成"不可判定"是误报, 而且每个用户每张卡都会看到一次;
 *  - `null`: 上轮世界时间**存在但解析不出来**(古代/仙侠卡的"元和三年·三月初七") → 整条降级成纯提示。
 */
export type 跨日判定 = { 最少: number; 最多: number } | '首次' | null;

const 一日的毫秒 = 86400000;

/**
 * 本轮跨了几个世界日: 由「正文时间约束」与上次世界时间算出, 与 校验世界时间 用的是同一套日期。
 * 这是**脚本给出的事实**——配额键与受校验的字段因此是同一处, 模型骗不开(世界时间本来就受校验)。
 */
export function 算跨世界日(constraint: 世界时间约束, oldWorldTime: string): 跨日判定 {
  if (!String(oldWorldTime ?? '').trim()) return '首次';
  const 旧日期 = 解析日期(oldWorldTime);
  if (!旧日期 || !constraint.最早日期 || !constraint.最晚日期) return null;
  // 正文闪回/回退时差值为负: 按"没有向前跨日"算, 不报负数
  const 最少 = Math.max(0, Math.round((constraint.最早日期.天 - 旧日期.天) / 一日的毫秒));
  const 最多 = Math.max(0, Math.round((constraint.最晚日期.天 - 旧日期.天) / 一日的毫秒));
  return { 最少, 最多: Math.max(最少, 最多) };
}

/**
 * 完成日志用的文案: 旧 / 新世界时间的**日期差**。
 *   `首次推进（无上轮世界时间, 不计跨日）` / `跨了 k 世界日` / `未跨日（沿用上轮日期）` / `时间不可解析, 无法判定`
 * 铁律: 上轮时间**存在**但旧或新任一解析不出来, 都归"不可判定", 不许落成"未推进"
 * (否则用户分不清"正常的静"与"卡住了")。开局不属于"不可判定"——它是**首次推进**。
 * 第五态是"世界时间被写回更早的日期"(正文闪回): 既不是跨日也不是沿用, 所以单独报, 不混进第二态。
 */
export function 描述世界日差(旧世界时间: string, 新世界时间: string): string {
  const 旧文本 = String(旧世界时间 ?? '').trim();
  const 新文本 = String(新世界时间 ?? '').trim();
  if (!旧文本) return '首次推进（无上轮世界时间, 不计跨日）';
  const 旧 = 解析日期(旧文本);
  const 新 = 解析日期(新文本);
  if (!旧 || !新) return `时间不可解析, 无法判定${旧文本 === 新文本 ? '（沿用上轮日期）' : ''}`;
  const 差 = Math.round((新.天 - 旧.天) / 一日的毫秒);
  if (差 > 0) return `跨了 ${差} 世界日`;
  if (差 === 0) return '未跨日（沿用上轮日期）';
  return `世界时间回退到更早日期（较上轮早 ${Math.abs(差)} 日）`;
}

