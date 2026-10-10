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
 * 带具体天数的"N天后 / N日后 / N天之后 / N日之后"不写在这里——min/max 是变量, 由 提取数字跳跃 单独认。
 *
 * **故意不收的**(写下来, 免得下一个人再问一遍):
 *  - 半晌后 / 片刻后 / 一会儿后 / 少顷: 表示几小时以内, **不跨日**。世界时间的时分由模型按剧情补全
 *    (§13 已定: 时钟·时分在码里看不见), 跨日判定只认"天";
 *  - 当天 / 同日 / 当晚 / 今天: 0 天, 本来就不是跳跃(默认态就是"未跨日");
 *  - 第三天 / 半个月里: 语义取决于故事起点, 而不是"从上轮世界时间算 +N"——给 min/max 会误判
 *    (第二天 / 第二日 是既有裁决, 保留);
 *  - 日后 / 之后(不带数字): 指"将来的某天", 不是跳跃;
 *  - "10月14日之后"这类**日期后缀**: 它是绝对日期不是跳跃词, 由 提取数字跳跃 的左边界挡掉
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

/** 解析烟火世界时间或正文里的绝对日期, 支持中文年月日与 ISO 日期。 */
export function 解析日期(text: unknown): 日期值 | null {
  const value = String(text ?? '').trim();
  const cn = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(value);
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

function 最新正文段(reply: string): string {
  const marker = '【最新回复】';
  const index = reply.lastIndexOf(marker);
  return index >= 0 ? reply.slice(index + marker.length) : reply;
}

/** 只从最新正文段提取日期, 不读取世界书或旧快照。 */
export function 提取正文日期(reply: string): 日期值 | null {
  const text = 最新正文段(reply);
  const matches: Array<{ index: number; date: 日期值 }> = [];
  const patterns = [
    /(\d{4})年(\d{1,2})月(\d{1,2})日/g,
    /(?:^|[^\d])(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[^\d]|$)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const date = pattern.source.includes('年')
        ? 合法日期(Number(match[1]), Number(match[2]), Number(match[3]))
        : 合法日期(Number(match[1]), Number(match[2]), Number(match[3]));
      if (date && match.index !== undefined) matches.push({ index: match.index, date });
    }
  }
  // 正文顶部通常有场景时间; 取最新正文中最先出现的明确日期, 避免把后文提到的历史日期当成当前时间。
  matches.sort((a, b) => a.index - b.index);
  return matches[0]?.date ?? null;
}

/** 词形归一: 把"…之后"折成"…后"(三天之后 = 三天后, 半年之后 = 半年后), 免得每个词条都要写两遍。 */
function 归一跳跃词(text: string): string {
  return text.replace(/([天日周月年])之后/g, '$1后');
}

function 提取跳跃(reply: string): { text: string; min: number; max: number } | null {
  const text = 归一跳跃词(最新正文段(reply));
  return 提取数字跳跃(text) ?? 相对跳跃.find(item => item.pattern.test(text)) ?? null;
}

/** 中文数字(一~十; "两"当 2 用) */
const 中文数: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/**
 * "三天后 / 15天后 / 十五天后 / 三日后"这类**带具体天数**的跳跃词。
 * 表格里的固定 min/max 装不下它, 所以在这里单独认一次。
 *
 * 为什么非要有它(v2.8 复核时发现): 卡片正文写"三天后"是常态, 而 相对跳跃 表里只有
 * "第二天 / 几天后 / 两周后"这几档——漏掉它就等于判定"正文没有时间线索", 世界时间被约束
 * **按兵不动**; 模型若跟着正文跨了日, 校验世界时间 会直接抛错, 重试三次后整轮推进失败。
 *
 * 两处边界:
 *  - 左边界的字符类挡掉"十X 被读成 X"(否则"十五天后"会变成 5 天)与**日期后缀**
 *    ("10月14日之后"里的"14日后"不是跳跃词, 前面跟着 数字/年/月/日/-///. 都不算);
 *  - "天"与"日"两种写法都认(古风卡多写"三日后"), 上限 3650 天挡住离谱数字。
 */
function 提取数字跳跃(text: string): { text: string; min: number; max: number } | null {
  const 阿拉伯 = /(?:^|[^\d年月日\-/.])(\d+)\s*[天日]后/.exec(text);
  if (阿拉伯) {
    const 天 = Number(阿拉伯[1]);
    if (天 >= 1 && 天 <= 3650) return { text: `${阿拉伯[1]}天后`, min: 天, max: 天 };
  }
  const 汉字 = /(?:^|[^一二三四五六七八九十两\d年月日])(十[一二三四五六七八九]?|[一二三四五六七八九两])[天日]后/.exec(text);
  if (汉字) {
    const 词 = 汉字[1];
    const 天 = 词.length === 1 ? 中文数[词] : 10 + 中文数[词[1]];
    if (天 >= 1) return { text: `${词}天后`, min: 天, max: 天 };
  }
  return null;
}

/**
 * 根据最新正文与上轮世界时间建立本轮时间约束。
 * - 有绝对日期: 世界日期必须与正文日期一致, 允许正文一层跨越任意时长;
 * - 只有相对跳跃: 按词义给出日期范围;
 * - 没有时间: 世界日期必须原样沿用, 防止每轮惯性加天。
 */
export function 建立世界时间约束(reply: string, oldWorldTime: string): 世界时间约束 {
  const 正文日期 = 提取正文日期(reply);
  const 跳跃 = 提取跳跃(reply);
  if (正文日期) {
    return {
      类型: '正文绝对时间',
      正文日期,
      最早日期: 正文日期,
      最晚日期: 正文日期,
      跳跃: 跳跃?.text ?? null,
      提示: `正文明确日期为 ${正文日期.年}-${String(正文日期.月).padStart(2, '0')}-${String(正文日期.日).padStart(2, '0')}，世界时间日期必须与该日期一致；正文若跨越数小时、数天或数月，只要正文明确写出新的日期就允许。`,
    };
  }
  const 旧日期 = 解析日期(oldWorldTime);
  if (跳跃 && 旧日期) {
    return {
      类型: '正文相对跳跃',
      正文日期: null,
      最早日期: 加天(旧日期, 跳跃.min),
      最晚日期: 加天(旧日期, 跳跃.max),
      跳跃: 跳跃.text,
      提示: `正文出现“${跳跃.text}”，世界时间日期必须落在上轮日期之后 ${跳跃.min}~${跳跃.max} 天的范围内；不得跳到范围之外。`,
    };
  }
  return {
    类型: '无正文时间',
    正文日期: null,
    最早日期: 旧日期,
    最晚日期: 旧日期,
    跳跃: null,
    提示: 旧日期
      ? `正文没有明确时间或跳跃词，世界时间日期必须沿用上轮日期 ${旧日期.年}-${String(旧日期.月).padStart(2, '0')}-${String(旧日期.日).padStart(2, '0')}；不得自行跨日。`
      : '正文没有明确时间，且上轮世界时间不可解析；请不要凭世界书未来日期自行跳日。',
  };
}

/** 校验模型返回的世界时间；无法解析模型日期时不拦截，交给原有结构校验处理。 */
export function 校验世界时间(worldTime: string, constraint: 世界时间约束): void {
  const 世界日期 = 解析日期(worldTime);
  if (!世界日期 || !constraint.最早日期 || !constraint.最晚日期) return;
  if (世界日期.天 < constraint.最早日期.天 || 世界日期.天 > constraint.最晚日期.天) {
    const lower = `${constraint.最早日期.年}-${String(constraint.最早日期.月).padStart(2, '0')}-${String(constraint.最早日期.日).padStart(2, '0')}`;
    const upper = `${constraint.最晚日期.年}-${String(constraint.最晚日期.月).padStart(2, '0')}-${String(constraint.最晚日期.日).padStart(2, '0')}`;
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

