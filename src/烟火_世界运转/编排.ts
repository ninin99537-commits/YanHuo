// 烟火 · 主线编排(接线层) —— 把已写好的「主线」数据层接进烟火的运转里。
//
// 数据层(./主线.ts)只管规则: 读取 / 合并 / 封顶 / 渲染 + 提示词; 它**故意不碰**平台、不碰存档、
// 不碰"上次编排"这个时间戳(楼层只有调用方知道)。这一层就是那个调用方:
//   状态存取(聊天变量 `主线`) → 频率闸门(每 N 层跑一次) → 楼层窗口(最近一段正文) →
//   组装消息(主线 JSON + 正文 + 剧情时间) → 共用的 请求并校验(带破限/预填充的形状) →
//   合并编排 → 记账(上次编排) → 落盘 + 写世界书条目。
//
// 形状全部照 update.ts(那一轮推进的骨架): 同一个 共用/模型往返.ts、同一份破限常量与收尾文案、
// 同一套失败文案口径。差别只有两处:
//   1 存档在**聊天变量**的 `主线` 键(不复用烟火的 `烟火` 键: 主线没有楼层快照 —— 删楼/回滚把
//     `上次编排.楼层` 变成"已经不存在的楼层"时, 算窗口起点 会判它**位置过期**, 按最近 N 层重新锚定);
//   2 发请求用的 signal 是这一层自己的 AbortController —— 烟火的 updatingStore 控制器是
//     "世界推进"那一个, 借用会把正在跑的世界推进顶掉。
//
// 硬约束: 入口(编排一次 / 触发编排)全程**不向调用方抛错** —— 消息回调里的调用点是
// fire-and-forget, 炸出去会打断调用点(与 updateWorld 同款: 内部 try/catch 收干净)。
import JSON5 from 'json5';
import { klona } from 'klona';
import { chatCompletion } from './api';
import { useHost, type Host } from './host';
import { 合并编排, 读取主线, 主线提示词, type 主线 } from './主线';
import { 同步主线条目 } from './主线条目';
import { GEMINI_JB_DOUPO, GEMINI_JB_REFERENCE, JB_ASSISTANT, JB_SYSTEM, 收尾文案 as 破限收尾文案 } from './prompts';
import { 世界状态存档 } from './保存世界状态';
import type { Settings } from './schema';
import { getSettings } from './settings';
import { toastError, toastInfo, toastSuccess } from './toast';
import { 请求并校验 } from '../共用/模型往返';

/** 这一层用到的平台能力(用 Pick 把需求写在签名上, 用例传假宿主即可跑) */
export type 编排宿主 = Pick<Host, 'vars' | 'chat' | 'persona' | 'macros' | 'worldbook' | 'model'>;

/** 主线存档在**聊天变量**里的键(与烟火的 `烟火` 键并列, 不复用) */
export const 主线变量键 = '主线';

/** 预填充开着时, 末尾那条 assistant 起手(与 共用/模型往返.ts 里补的 '{' 同一个形状)。
 *  这里只用于**如实交代**这次的收尾是什么(见 组装编排消息 的返回值): 真正补消息的是 请求并校验。 */
const 预填充起手 = '{\n';

// ---------------------------------------------------------------------------
// a. 状态存取(聊天变量)
// ---------------------------------------------------------------------------

/**
 * 读回主线存档。**永远给得出可用对象**: 变量表读不到/读失败/存的是旧值 → 空主线
 * (读取主线(undefined) 会造一份规范形状, 调用方不必判空)。
 */
export function 读取主线存档(host: Pick<Host, 'vars'>): 主线 {
  try {
    return 读取主线(host.vars.get({ type: 'chat' })?.[主线变量键]);
  }
  catch (error) {
    console.warn('[主线] 读取存档失败, 按空主线处理:', error);
    return 读取主线(undefined);
  }
}

/**
 * 写入主线存档(整份 `主线` 对象, 含 `上次编排`)。整体赋值该键, 不动聊天变量里其它键。
 * 写失败只记日志: 下一次编排会重新算一遍(闸门读的也是这份存档), 不向调用方抛错。
 */
export function 写入主线存档(host: Pick<Host, 'vars'>, 主线存档: 主线): void {
  try {
    host.vars.update((variables) => {
      variables[主线变量键] = klona(主线存档);
      return variables;
    }, { type: 'chat' });
  }
  catch (error) {
    console.error('[主线] 写入存档失败:', error);
  }
}

// ---------------------------------------------------------------------------
// b. 频率闸门
// ---------------------------------------------------------------------------

/**
 * 该编排了吗 —— 从 算窗口起点 给出的起点之后数**未隐藏的 assistant 楼层**, 攒够"更新频率"的整数倍才跑。
 *
 * 纯函数: 宿主与楼层都从参数进来(不在里面自己 new 宿主), 所以能脱离界面测。
 * - 总开关关(设置.主线.启用): 直接 false(连楼层都不读) —— 主线只认自己的开关, 不看烟火的启用运转/自动更新;
 * - 起点由 算窗口起点 算(与 取楼层窗口 同一份公式, 不许两处各写一份), 于是"闸门说该跑"和"窗口取哪几层"永远一致;
 * - **位置过期**(锚点被删/回滚/首次编排): 无视频率取模 —— 只要起点到当前楼层之间还有未隐藏的
 *   assistant 楼层就 true。锚点已经指不到东西了, 必须先按最近 N 层把它重建起来, 否则主线会静默停摆;
 * - 位置正常(含"锚点就是末层"): 只数未隐藏楼层, 隐藏楼层不是正文(index.ts 的推进频率计数同款口径),
 *   攒够频率的整数倍才跑; 锚点=末层时起点在末层之后, 直接 false(那三种"没有新楼层"的情形都不跑);
 * - 这里**不打日志**(它一轮会被调两次: 触发编排 一次 + 编排一次 一次), "位置已失效, 按最近 N 层
 *   重新锚定"那句话统一在 编排一次 里说一次(见 取楼层窗口 的 `位置过期`)。
 */
export function 该编排了吗(host: Pick<Host, 'vars' | 'chat'>, 设置: Settings, 当前楼层: number): boolean {
  try {
    if (!设置.主线?.启用)
      return false;
    if (!Number.isFinite(当前楼层))
      return false;
    const 频率 = Math.max(1, Math.round(设置.主线.更新频率 || 1));
    const 存档 = 读取主线存档(host);
    const { 起点, 位置过期 } = 算窗口起点(存档.上次编排?.楼层, 当前楼层, 设置.主线.每次发送层数);
    if (当前楼层 < 起点)
      return false;
    const 新增 = host.chat
      .messages(`${起点}-${当前楼层}`, { role: 'assistant' })
      .filter(message => !message.is_hidden);
    if (新增.length === 0)
      return false;
    if (位置过期)
      return true;
    return 新增.length % 频率 === 0;
  }
  catch (error) {
    console.warn('[主线] 频率闸门读取楼层失败, 本次跳过:', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// c. 消息组装
// ---------------------------------------------------------------------------

export interface 编排消息参数 {
  /** 当前主线(原样 JSON 发给模型, 不渲染成注入文本 —— 模型要按编号改它) */
  主线: 主线;
  /** 楼层窗口拼好的正文 */
  楼层文本: string;
  /** 当前剧情时间(世界状态里的「世界.时间」) */
  剧情时间: string;
  /** 破限开关(与烟火世界推进共用 运转.* 的那几个开关) */
  破限: boolean;
  /** 预填充开关 */
  预填充: boolean;
  /** 头部填充开关 */
  头部填充: boolean;
  /** 头部填充的自定义文本(留空用内置小说原文) */
  头部填充文本: string;
  /** 防截断开关(免责声明段缝 system 末尾) */
  防截断: boolean;
}

export interface 编排消息结果 {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  /**
   * 这次请求末尾实际会出现的"收尾", 只作交代(请求形状与 prompts.ts 的 buildTickMessages 完全同款):
   * - 预填充开 → `'{\n'`(本函数**不**追加消息, 由 共用/模型往返.ts 补 assistant 起手);
   * - 预填充关 + 破限开 → 那条把话语权交回任务侧的 user 收尾(已追加进 messages);
   * - 两者都关 → 空串(末尾就是任务 user)。
   * 收尾与预填充**二选一**: 预填充开时绝不追加那条 user 收尾, 免得"两样都上"。
   */
  收尾文案: string;
}

/**
 * 组装编排那一轮的消息: 头部填充 → system(主线提示词 + 防截断) → user 任务(当前主线 JSON +
 * 最近楼层正文 + 当前剧情时间) → 破限 SPECIAL NOTE + assistant 承诺 → (预填充关时的 user 收尾)。
 * system 与 user 任务用的是 主线提示词()(数据层导出), 不在这里另写一套提示词。
 */
export function 组装编排消息(参数: 编排消息参数): 编排消息结果 {
  const systemContent = 主线提示词() + (参数.防截断 ? GEMINI_JB_REFERENCE : '');
  const userContent = `【当前主线】(这部戏的骨架: 请按编号与字段增改它, 本轮没有任何实质变化就只回 {"动作":"无事"}):
${JSON.stringify(参数.主线)}

【最近的楼层正文】(按时间先后排列, 最后一条是当前正在发生的内容):
${参数.楼层文本 || '(无)'}

当前剧情时间: ${参数.剧情时间 || '(未定)'}

请编排这一轮的主线。`;
  const messages: 编排消息结果['messages'] = [];
  // 头部填充: 与 buildTickMessages 同款 —— 自定义文本优先, 留空则内置小说原文, 作为第一条消息单独发送
  if (参数.头部填充)
    messages.push({ role: 'user', content: (参数.头部填充文本 || '').trim() || GEMINI_JB_DOUPO });
  messages.push({ role: 'system', content: systemContent });
  messages.push({ role: 'user', content: userContent.trim() });
  // 破限段不在 system 里, 是 AI 读完任务后立刻看到的贴脸强化(与 buildTickMessages 同款)
  let 收尾 = '';
  if (参数.破限) {
    messages.push({ role: 'system', content: JB_SYSTEM });
    messages.push({ role: 'assistant', content: JB_ASSISTANT });
    if (!参数.预填充) {
      // 预填充关: 承诺不能是最后一条 assistant(部分供应商会当"已回答"), 补一条 user 收尾
      messages.push({ role: 'user', content: 破限收尾文案 });
      收尾 = 破限收尾文案;
    }
  }
  // 预填充开: 起手由 请求并校验 追加(承诺/任务之后紧跟 assistant '{', 连续 assistant 合法)
  if (参数.预填充)
    收尾 = 预填充起手;
  return { messages, 收尾文案: 收尾 };
}

// ---------------------------------------------------------------------------
// d. 楼层窗口
// ---------------------------------------------------------------------------

export interface 楼层窗口 {
  /** 拼好的正文(每层一行 `角色名: 正文`, 层间空行) */
  文本: string;
  /** 窗口末层(读到的当前末层; 取不到时为 -1) */
  到楼层: number;
  /** 窗口首层(被"每次发送层数"截过之后的实际起点; 位置过期时是"重新锚定"的起点) */
  起点楼层: number;
  /** 因为超过上限而从**最早**处截掉、没发出去的楼层数(0 = 一层没漏) */
  漏掉层数: number;
  /** 锚点(上次编排楼层)是不是"指到不存在的楼层"了 —— 由 算窗口起点 判, 交给调用方记一次日志 */
  位置过期: boolean;
}

/** 角色卡名(assistant 的说话人): 平台边界只有 macros, 用 {{char}} 展开; 取不到用 'AI' */
function 取角色名(host: Pick<Host, 'macros'>): string {
  try {
    const 名 = String(host.macros.expand('{{char}}') ?? '').trim();
    return 名 && 名 !== '{{char}}' ? 名 : 'AI';
  }
  catch {
    return 'AI';
  }
}

/** 人设名(user 的说话人): 没有时用 '你' */
function 取人设名(host: Pick<Host, 'persona'>): string {
  try {
    return String(host.persona.name() ?? '').trim() || '你';
  }
  catch {
    return '你';
  }
}

/** 「每次发送层数」的合法值: 至少 1 层(0/负数/NaN = 没配, 按 1 层) */
function 取上限层数(上限层数: number): number {
  return Math.max(1, Number.isFinite(上限层数) ? Math.floor(上限层数) : 1);
}

/** 从某层往回数 `上限层数` 层(含该层本身)得到的最早楼号 —— "严格不超过上限"的**唯一**一处公式 */
function 上限起点(当前楼层: number, 上限层数: number): number {
  return Math.max(0, 当前楼层 - 取上限层数(上限层数) + 1);
}

/**
 * 算窗口起点(纯函数, 频率闸门与楼层窗口**共用** —— 不许两处各写一份公式):
 * - 位置正常(`上次编排楼层 <= 当前楼层`): 起点 = 上次编排楼层 + 1, 位置过期 = false
 *   —— 只走"上次编排之后的新增", 不在这里截上限(截上限是 取楼层窗口 的事: "新增没超上限就
 *   必须从'上次编排 + 1'开始", 不能退化成"只取最近 N 层")。
 *   **相等也算正常态**: 锚点就是末层(上次编排之后没再来新楼层)时, 起点 = 当前 + 1 > 当前,
 *   窗口取不到正文、闸门也数不到新增 → 不跑。加载页面后补读的那一次、同一楼 regenerate/重 roll
 *   都走这条路, 不会白花一次请求 —— 要保护的只有"锚点被删到当前楼层之前"这一种失效;
 * - **位置过期**(`上次编排楼层 > 当前楼层`, 含没有存档的首次编排): 锚点已经指到"不存在的楼层"
 *   (删楼/回滚) —— 按最近 `上限层数` 层**重新锚定**: 起点 = max(0, 当前楼层 - 上限层数 + 1),
 *   位置过期 = true。
 */
export function 算窗口起点(
  上次编排楼层: number | undefined,
  当前楼层: number,
  上限层数: number,
): { 起点: number; 位置过期: boolean } {
  const 上次 = typeof 上次编排楼层 === 'number' && Number.isFinite(上次编排楼层) ? Math.floor(上次编排楼层) : undefined;
  const 当前 = Number.isFinite(当前楼层) ? Math.floor(当前楼层) : -1;
  if (上次 !== undefined && 上次 <= 当前)
    return { 起点: Math.max(0, 上次 + 1), 位置过期: false };
  return { 起点: 上限起点(当前, 上限层数), 位置过期: true };
}

/**
 * 取楼层窗口: 从 `上次编排楼层` 之后取到当前末层, 每层 `角色名: 正文`。
 *
 * 起点 = max(算窗口起点(...).起点, 末层 - 上限层数 + 1), 也就是:
 *   先要把"上次编排之后的新增"全部带上;**只有新增确实超过上限时**才从**最早**那段截掉、
 *   保留**最近**的 上限层数 层 —— 一个上限是"最多发这么多层", 不是"只取最近这么多层"的过滤条件。
 * 位置过期(锚点被删/回滚/首次编排)时 算窗口起点 给的就是"最近 上限层数 层"的起点, 两者一致。
 * 被截掉的层数写进 `漏掉层数`、锚点有没有失效写进 `位置过期`, 都交给调用方记日志
 * (编排一次 会各打一条 warn); `漏掉层数` 是相对**本该取的起点**(算窗口起点 的结果)算的,
 * 位置过期时从那里重新锚定, 故为 0(没有"本该发却被截掉"的楼层)。
 * 隐藏楼层不算正文(与世界推进同款口径: `is_hidden`), 但**算**在被截掉的楼号数里
 * ——"漏掉"说的是"这些楼号没进上下文", 不是"漏了几条正文"。
 */
export function 取楼层窗口(host: Pick<Host, 'chat' | 'persona' | 'macros'>, 上次编排楼层: number | undefined, 上限层数: number): 楼层窗口 {
  try {
    const 到楼层 = host.chat.lastMessageId();
    if (!Number.isFinite(到楼层) || 到楼层 < 0)
      return { 文本: '', 到楼层: -1, 起点楼层: 0, 漏掉层数: 0, 位置过期: false };
    const 锚 = 算窗口起点(上次编排楼层, 到楼层, 上限层数);
    const 起点楼层 = Math.max(锚.起点, 上限起点(到楼层, 上限层数));
    const 角色名 = 取角色名(host);
    const 人设名 = 取人设名(host);
    const 文本 = host.chat
      .messages(`${起点楼层}-${到楼层}`)
      .filter(message => !message.is_hidden)
      .map(message => `${message.role === 'assistant' ? 角色名 : 人设名}: ${String(message.message ?? '')}`)
      .join('\n\n');
    return { 文本, 到楼层, 起点楼层, 漏掉层数: Math.max(0, 起点楼层 - 锚.起点), 位置过期: 锚.位置过期 };
  }
  catch (error) {
    console.warn('[主线] 读取楼层窗口失败, 本次跳过:', error);
    return { 文本: '', 到楼层: -1, 起点楼层: 0, 漏掉层数: 0, 位置过期: false };
  }
}

// ---------------------------------------------------------------------------
// 模型输出的解析与校验(只服务这一层; 世界载荷的解析在 解析.ts, 两者互不干扰)
// ---------------------------------------------------------------------------

/** 去掉 markdown 围栏(模型偶尔还是把 JSON 包在 ```json 里) */
function 去围栏(文本: string): string {
  const 去空白 = 文本.trim();
  const 围栏 = 去空白.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return 围栏 ? 围栏[1].trim() : 去空白;
}

/**
 * 逐个 `{` 起做括号配平, 取**第一个**完整顶层对象。
 * 不能用"第一个 { 到最后一个 }"的粗切: 模型受世界书格式影响时, JSON 前后可能跟着自带 { } 的
 * 别的块(思维链里的伪示例), 粗切会拼出坏串。有 `{` 却没配平 = 输出被接口砍在半路(截断)。
 */
function 切配平对象(文本: string): { 片段: string; 截断: boolean } {
  const 起点 = 文本.indexOf('{');
  if (起点 === -1)
    return { 片段: '', 截断: false };
  let 深度 = 0;
  let 在串里 = false;
  let 转义 = false;
  for (let i = 起点; i < 文本.length; i++) {
    const 字 = 文本[i];
    if (在串里) {
      if (转义)
        转义 = false;
      else if (字 === '\\')
        转义 = true;
      else if (字 === '"')
        在串里 = false;
      continue;
    }
    if (字 === '"')
      在串里 = true;
    else if (字 === '{')
      深度++;
    else if (字 === '}') {
      深度--;
      if (深度 === 0)
        return { 片段: 文本.slice(起点, i + 1), 截断: false };
    }
  }
  return { 片段: '', 截断: true };
}

/** 解析: 切出配平对象 → JSON.parse → 退一步用 JSON5(模型把多行文本写进字符串时会有裸换行) */
function 解析编排载荷(原始文本: string): any {
  const 文本 = 去围栏(String(原始文本 ?? ''));
  const { 片段, 截断 } = 切配平对象(文本);
  if (!片段) {
    const 错 = Error(截断
      ? 'AI 的输出被截断(JSON 大括号没配平)'
      : 'AI 没有返回 JSON 对象(只输出了文字/推理内容)');
    错.name = 截断 ? '截断' : '解析';
    throw 错;
  }
  try {
    return JSON.parse(片段);
  }
  catch {
    // 落给 JSON5: 单引号/尾逗号/裸换行都是模型常见的手滑
  }
  try {
    return JSON5.parse(片段);
  }
  catch (error) {
    const 错 = Error(`AI 返回的 JSON 无法解析: ${error instanceof Error ? error.message : String(error)}`);
    错.name = '解析';
    throw 错;
  }
}

/** 回喂给 AI 的"上次输出"只取 JSON 片段(不带思维链/正文杂质) */
function 取编排JSON片段(原始文本: string): string {
  return 切配平对象(去围栏(String(原始文本 ?? ''))).片段;
}

/** 结构校验: 顶层必须是单个对象(内容认不认得出由数据层的 合并编排 决定, 这层不替它判断) */
function 校验编排载荷(候选: any): any {
  if (!候选 || typeof 候选 !== 'object' || Array.isArray(候选)) {
    const 错 = Error('编排输出不是一个 JSON 对象(顶层必须是单个对象)');
    错.name = '校验';
    throw 错;
  }
  return 候选;
}

/** 任务 user 消息 = 最后一条 user, 但跳过破限+预填充关闭时补的那条收尾 user(与 update.ts 同款) */
function 查编排任务下标(messages: { role: string; content: string }[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user')
      continue;
    if (i === messages.length - 1 && messages[i].content === 破限收尾文案)
      continue;
    return i;
  }
  return -1;
}

/** 往返日志: 走 console —— 烟火的 日志页 捕获脚本自身 console(captureConsole), 不占用
 *  「世界推进」那一份 debugStore 记录(两者的请求/响应混在一起会互相盖掉) */
function 记编排日志(记录: { error?: string; response?: string }): void {
  if (记录.error)
    console.warn(`[主线] ${记录.error}`);
  else if (记录.response !== undefined)
    console.info(`[主线] 模型输出(${String(记录.response).length} 字):\n${String(记录.response).slice(0, 2000)}`);
}

/** 当前楼层号(取不到 = -1) */
function 取当前楼层(host: Pick<Host, 'chat'>): number {
  try {
    const 末层 = host.chat.lastMessageId();
    return Number.isFinite(末层) ? Math.floor(末层) : -1;
  }
  catch {
    return -1;
  }
}

/**
 * 当前剧情时间: 只读地取世界状态里的「世界.时间」。
 * 世界状态存在楼层快照里(门面 = 世界状态存档), 这里**只读不写**; 读不到就给空串
 * (提示词里那行会显示"(未定)", 编排照跑 —— 主线的冻结规则不依赖时间, 时间只用于新增债的日期)。
 */
function 取剧情时间(): string {
  try {
    return String(世界状态存档.读取().世界.时间 ?? '');
  }
  catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// e. 跑一轮
// ---------------------------------------------------------------------------

export interface 编排结果 {
  /** 成功 = 存档已更新; 跳过 = 没到频率/没有新楼层(存档不动); 失败 = 失败(存档不动, 下次重试) */
  结果: '成功' | '跳过' | '失败';
  /** 跳过/失败的原因(成功时没有) */
  原因?: string;
}

/** 上一轮还没跑完就不再开一轮(与 update.ts 的 isUpdating 同款) */
let 进行中 = false;

/**
 * 当前这一轮编排的取消句柄 —— **故意留在模块级、可被外部拿到**: 下一步的面板会绑一个
 * `取消编排()` 调 `取编排取消句柄()?.abort()`(现在没有界面入口, 先不删也不收进 编排一次 的局部)。
 * 中断会走 共用/模型往返.ts 里的"用户已中断本次编排": 归档不推进, 下一轮照旧重试这一段。
 */
let 当前控制器: AbortController | null = null;

/** 取当前编排的取消句柄(没有在跑的编排时是 null): 外部(下一步的面板)的中断入口 */
export function 取编排取消句柄(): AbortController | null {
  return 当前控制器;
}

/**
 * 编排一次。
 * - 非强制时先过频率闸门(该编排了吗);
 * - 窗口从 算窗口起点(上次编排楼层) 给出的起点取到最新(上限 = 每次发送层数, 超了从最早处截并记日志;
 *   位置过期时按最近 N 层重新锚定 —— 闸门与窗口用的是同一个函数, 两边不会各算各的);
 * - 模型往返复用 共用/模型往返.ts(破限/预填充的形状、解析回喂、重试节奏都在那儿);
 * - **成功**才合并 + 记账(`上次编排 = { 楼层: 最新楼层, 时间: 剧情时间 }`, 数据层故意不碰这个字段)
 *   + 落盘 + 写世界书条目;
 * - **失败/跳过一律不推进 `上次编排`**, 于是下一次还会重试这一段。
 * 全程不抛错(返回 { 结果: '失败', 原因 }), 调用点(fire-and-forget)不会被炸掉。
 */
export async function 编排一次(host: 编排宿主, 设置: Settings, 强制 = false): Promise<编排结果> {
  if (进行中)
    return { 结果: '跳过', 原因: '上一次编排还没跑完' };
  进行中 = true;
  try {
    const 当前楼层 = 取当前楼层(host);
    if (当前楼层 < 0)
      return { 结果: '跳过', 原因: '读不到当前楼层' };
    if (!强制 && !该编排了吗(host, 设置, 当前楼层))
      return { 结果: '跳过', 原因: '还没到编排频率' };
    const 旧主线 = 读取主线存档(host);
    const 窗口 = 取楼层窗口(host, 旧主线.上次编排?.楼层, 设置.主线.每次发送层数);
    if (!窗口.文本)
      return { 结果: '跳过', 原因: '没有可编排的新楼层正文' };
    if (窗口.位置过期) {
      // 锚点被删/回滚/首次编排: 这一轮是"按最近 N 层重新锚定"。日志只在这里说**一次**
      // (该编排了吗 一轮会被调两次: 触发编排 一次 + 这里一次, 那儿不再重复输出)。
      console.warn(`[主线] 上次编排位置已失效(锚点 ${旧主线.上次编排?.楼层 ?? '无'}, 当前末层 ${窗口.到楼层}), 按最近 ${设置.主线.每次发送层数} 层重新锚定(第 ${窗口.起点楼层}~${窗口.到楼层} 楼)`);
    }
    if (窗口.漏掉层数 > 0) {
      // 新增楼层超过上限: 起点被截到"末层 - 上限 + 1", 这里如实说明漏了哪些楼号(用例钉住这个行为)
      console.warn(`[主线] 新增楼层超过「每次发送层数」(${设置.主线.每次发送层数}), 已从最早处截掉 ${窗口.漏掉层数} 层, 只发最近一段(第 ${窗口.起点楼层}~${窗口.到楼层} 楼)`);
    }
    const 剧情时间 = 取剧情时间();
    const { messages } = 组装编排消息({
      主线: 旧主线,
      楼层文本: 窗口.文本,
      剧情时间,
      破限: 设置.运转.破限,
      预填充: 设置.运转.预填充,
      头部填充: 设置.运转.头部填充,
      头部填充文本: 设置.运转.头部填充文本 ?? '',
      防截断: 设置.运转.防截断,
    });
    console.info(`[主线] 开始编排(楼层 ${窗口.起点楼层}~${窗口.到楼层}${窗口.漏掉层数 > 0 ? `, 漏掉 ${窗口.漏掉层数} 层` : ''})`);
    当前控制器 = new AbortController();
    const 往返 = await 请求并校验({
      messages,
      找任务下标: 查编排任务下标,
      预填充: 设置.运转.预填充,
      signal: 当前控制器.signal,
      发请求: chatCompletion,
      解析: content => 解析编排载荷(content),
      校验: 候选 => 校验编排载荷(候选),
      取JSON片段: content => 取编排JSON片段(content),
      // 与 update.ts 同款口径: "整段不是 JSON"当场失败(同样的提示词重推没用), 只有"是 JSON 但
      // 结构不合格"和"被接口截断"才带着理由回喂重试
      判断错误: (error, 阶段) => {
        if (阶段 === '解析')
          return error.name === '截断' ? '反馈' : '致命';
        return 阶段 === '请求' ? '接口' : '反馈';
      },
      名字: '主线',
      结构失败标签: '编排失败',
      中断文案: '用户已中断本次编排',
      取重试理由: (error) => {
        const 文字 = error.message ?? '';
        return 文字.includes('JSON') || 文字.includes('解析') ? 'AI 返回的 JSON 不完整' : 'AI 返回格式不符合要求';
      },
      记日志: 记录 => 记编排日志(记录),
      报进度: 文字 => console.info(`[主线] ${文字}`),
    });
    // 成功路径: 合并 → 记账 → 落盘 → 世界书条目。
    // 合并编排 是纯函数(什么都没变会原样返回旧对象), 上次编排 由**这里**写(数据层没有楼层可写)。
    const 新主线 = 合并编排(旧主线, 往返.parsed, 剧情时间);
    const 落库: 主线 = {
      终点: 新主线.终点,
      幕: 新主线.幕,
      债: 新主线.债,
      回顾: 新主线.回顾,
      上次编排: { 楼层: 窗口.到楼层, 时间: 剧情时间 },
    };
    写入主线存档(host, 落库);
    if (设置.主线.注入世界书条目)
      await 同步主线条目(host, 落库, true);
    const 欠着 = 落库.债.filter(一笔 => 一笔.状态 === '欠着').length;
    console.info(`[主线] 编排完成: 第 ${落库.幕.序号} 幕, 欠着 ${欠着} 笔`);
    toastSuccess(`主线: 第 ${落库.幕.序号} 幕, 欠着 ${欠着} 笔`, '主线');
    return { 结果: '成功' };
  }
  catch (error) {
    const 文字 = error instanceof Error ? error.message : String(error);
    if (当前控制器?.signal.aborted) {
      console.info('[主线] 编排已中断');
      toastInfo(`主线: ${文字}`, '主线');
      return { 结果: '失败', 原因: 文字 };
    }
    console.error('[主线] 编排失败:', error);
    toastError(`编排失败: ${文字}`, '主线');
    return { 结果: '失败', 原因: 文字 };
  }
  finally {
    当前控制器 = null;
    进行中 = false;
  }
}

/**
 * 触发编排(消息回调与下一步的面板都绑它): 先过闸门再跑, **不 await、不抛错**。
 * 调用点是**自己的一路**(index.ts: 防抖回调里、在调用烟火那一路之前; 启动补读那段同理), 不吃
 * 烟火那边的早退(关总开关 / 关自动更新 / 正文过短 / 世界频率没到)—— "该不该跑"只由
 * 该编排了吗(含 设置.主线.启用)决定, 主线有自己的频率。
 * 强制 = 手动点按钮: 跳过频率闸门(总开关与"有没有新楼层"仍由 编排一次 自己判)。
 * 收尾提示与失败日志都在 编排一次 里, 这里只兜住"连调用都出错"的极端情况。
 */
export function 触发编排(强制: boolean): void {
  try {
    const host = useHost();
    const 设置 = getSettings();
    if (!强制 && !该编排了吗(host, 设置, 取当前楼层(host)))
      return;
    编排一次(host, 设置, 强制).catch(error => console.error('[主线] 编排异常:', error));
  }
  catch (error) {
    console.error('[主线] 触发编排失败:', error);
  }
}
