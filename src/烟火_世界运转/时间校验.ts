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

const 相对跳跃 = [
  { pattern: /一夜之间|第二天一早|第二天|次日|隔天/, text: '次日', min: 1, max: 1 },
  { pattern: /十几天后/, text: '十几天后', min: 10, max: 19 },
  { pattern: /一两周后/, text: '一两周后', min: 7, max: 14 },
  { pattern: /两周后/, text: '两周后', min: 14, max: 14 },
  { pattern: /几周后|数周后|几个星期后|几个礼拜后/, text: '几周后', min: 14, max: 56 },
  { pattern: /几天后|数天后/, text: '几天后', min: 2, max: 14 },
  { pattern: /一个月后/, text: '一个月后', min: 28, max: 31 },
  { pattern: /两个月后/, text: '两个月后', min: 56, max: 62 },
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

function 提取跳跃(reply: string): (typeof 相对跳跃)[number] | null {
  const text = 最新正文段(reply);
  return 相对跳跃.find(item => item.pattern.test(text)) ?? null;
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
