// 烟火 · 推进输入(纯函数)
// ---------------------------------------------------------------------------
// 这一层只回答三件事, 不碰酒馆平台、不碰 Vue、不建第二套状态:
//   1. **选哪几层**: 锚点封上界、隐藏楼层不取、清空截止之后才读; 初始化取最近 N 条完整
//      assistant, 已有状态则"最近 N 条上下文 + 全部未处理"——补全时**只告警, 不截断**。
//   2. **哪份材料给谁**: 原文(完整) / 扫描材料(原始, 不吃标签过滤) / 模型正文(先剥回忆协议
//      块, 再套调用方给的 filter) 三份分开。主 AI 的记忆插件会把 AM 编码塞进正文或注释里,
//      先过滤再扫描会把关键词一起删掉 —— 所以扫描材料永远是原始文本。
//   3. **回忆证据**: 从原始消息里提完整 `<recall>` 块与 `AMxx | 时差`, 连同来源楼层与角色
//      作为**只读元数据**交出去。不闭合的块显式告警, 不拿残缺编码猜; 这里的编码只是
//      "聊天原文里出现过的", 不等于主 AI 本次请求最终激活的同一批(不冒充)。
//
// 用例见 tests/yanhuo-input-window.test.ts。调用方的预期(主代理接 update.ts 时):
//   const 输入 = 收集推进输入(useHost().chat.messages(...), {
//     anchorFloor, recentCount: settings.运转.读取最近回复数, processedFloor: data.处理到楼层 ?? 0,
//     clearFloor: 清空层 > 0 ? 清空层 : null, initialized: Boolean(data.锚点楼层 >= 0),
//     filter: createTextFilter(settings.标签),
//   });
//   随后 输入.reply / 输入.latestReply / 输入.context 进提示词, 输入.scanText 进世界书扫描,
//   输入.recall 只作诊断与降级说明, 输入.warnings 直接显示给用户。
// ---------------------------------------------------------------------------

/** 一层聊天: 与平台 `ChatMessage` 的同名子集; 多出来的 swipe_id 只用来说明"这条属于哪一页" */
export type 推进消息 = {
  message_id: number;
  role: 'system' | 'assistant' | 'user';
  message: string;
  is_hidden?: boolean;
  swipe_id?: number;
};

/** 推进选项: 全部由调用方给值, 本模块不读设置、不读全局 */
export type 推进输入选项 = {
  /** 本轮分析的最后一层(含). 锚点之后的楼层一律不取 */
  anchorFloor: number;
  /** 设置里的「读取最近回复数」(AI 回复条数, 不是对话轮数) */
  recentCount: number;
  /** 上次已推进到的楼层; 严格大于它的 assistant 都算未处理, 必须补全 */
  processedFloor: number;
  /** 清空截止: `null` = 从未清空; 数字 = 只读**严格大于**它的楼层 */
  clearFloor: number | null;
  /** 是否已有世界状态(决定"只取最近 N 条"还是"最近 N 条上下文 + 全部未处理") */
  initialized: boolean;
  /** 标签过滤(通常是 共用/楼层标签过滤 的 createTextFilter); **只作用于模型正文** */
  filter: (text: string) => string;
};

/** 一条 AM 记忆编码: 码 + 相对时差(时差只是元数据, 不是让世界时钟跳这么多天的指令) */
export type 回忆编码 = {
  readonly 码: string;
  readonly 时差: string;
};

/** 某一层里的回忆证据: 只读元数据, 不改写原文、不进世界时钟 */
export type 回忆证据 = {
  readonly 楼层: number;
  readonly 角色: string;
  readonly 编码: readonly 回忆编码[];
  /** 完整 `<recall>…</recall>` 块的内部原文(不带标签) */
  readonly 块: readonly string[];
  /** 有 `<recall>` 没闭合(或闭合多出来): 这一段不参与编码提取 */
  readonly 未闭合: boolean;
  /** 来源: 这一批编码来自聊天原文, 不是主请求的激活结果 */
  readonly 来源: '聊天原文';
};

/** 选中的一层: 原文(完整) / 正文(剥回忆块 + 过滤后) 分开交出去 */
export type 输入楼层 = {
  readonly message_id: number;
  readonly 角色: string;
  readonly 原文: string;
  readonly 正文: string;
  readonly swipe_id?: number;
};

export type 推进输入 = {
  /** 所选完整 assistant 楼层(按楼层升序; 不截断任何一条) */
  recent: 输入楼层[];
  /** 标注了先后的模型正文; 最后一条是【最新回复】 */
  reply: string;
  /** 最后一条 assistant 的正文 */
  latestReply: string;
  /** 锚点之前最近一条 user 的清洗文本(锚点之后的 user 不混进来) */
  context: string;
  /** 独立的世界书扫描原料: 原始文本(含 AM 编码/aftertalk), 不吃标签过滤 */
  scanText: string;
  /** 回忆证据(只读元数据) */
  recall: 回忆证据[];
  /** 需要显示给用户的告警(补全超 N / 清空截止 / 未闭合回忆块 / 空窗口 …) */
  warnings: string[];
  /** 本轮未处理(严格大于 processedFloor)的 assistant 楼层号 */
  unprocessedIds: number[];
};

// ---------------------------------------------------------------------------
// 回忆协议块
// ---------------------------------------------------------------------------
// 记忆插件把 "<recall>…</recall>" 追加在用户输入后面, 前面还有一段写给主 AI 的说明
// ("以上是用户的本轮输入，以下是<记忆回溯>的编码…"). 这两段都是**协议**, 不是剧情:
// 模型正文里不该出现它们。口径是"删完整块", 不是"按关键词抹字"; 而且**未闭合就一个字都不动**
// (不删前后正文, 也不删已闭合的块) + 告警要求拒绝本轮 —— 见 剥离回忆协议块。
const 回溯块 = /<recall>([\s\S]*?)<\/recall>/g;
// 说明段**只从固定的协议开头**("以上是用户的本轮输入")起算: 以前前面挂着 `[^\n]*`,
// 用户在协议同一行前面写的行动("他把信收好。以上是用户的本轮输入…")会被一起吞掉。
const 说明段 = /以上是用户的本轮输入[\s\S]*?(?=<recall>)/g;

function 取文本(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/** 从一段原始文本里取 "AM0256 | 0m" 这样的编码(码 + 时差; 缺时差的残缺编码不采纳) */
function 取编码(文本: string): 回忆编码[] {
  const 结果: 回忆编码[] = [];
  const 见过 = new Set<string>();
  for (const 匹配 of 文本.matchAll(/(AM\d+)\s*\|\s*([^\s|<>]+)/g)) {
    const 键 = `${匹配[1]}|${匹配[2]}`;
    if (见过.has(键))
      continue;
    见过.add(键);
    结果.push({ 码: 匹配[1], 时差: 匹配[2] });
  }
  return 结果;
}

/** 文本里有 `<recall>` 但没闭合(或闭合比开标签多): 只报告, 不猜 */
function 有无闭合(文本: string): boolean {
  const 开 = (文本.match(/<recall>/g) ?? []).length;
  const 闭 = (文本.match(/<\/recall>/g) ?? []).length;
  return 开 !== 闭;
}

/**
 * 剥掉**完整的**回忆协议块(说明段 + `<recall>…</recall>`); 没有块时原样返回。
 *
 * 未闭合(或闭合多出来)时**一个字都不动**: 既不清前后正文, 也不删完整块 —— 这一层原样交给
 * 调用方, 由它拒绝本轮(把残缺协议喂给模型比不剥更糟)。`recall[]` 里会标 `未闭合: true`,
 * 告警里也写清了要拒绝。取编码用的"块外截取"(见 提取回忆证据)只是协议解析, 不替代这里。
 */
function 剥离回忆协议块(文本: string): string {
  if (!文本.includes('<recall>'))
    return 文本;
  if (有无闭合(文本))
    return 文本;
  return 文本
    .replace(说明段, '')
    .replace(回溯块, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 提取某一层的回忆证据; 什么都没找到时返回 null(不造空壳)。
 * 编码来源: ① 所有已闭合的 `<recall>` 块; ② 块外(含 aftertalk/注释)出现的完整编码行。
 * 块外截取只用于**协议解析**, 不参与模型正文; 未闭合段之后的文字不参与提取 —— 宁可少认, 不拿残缺编码猜。
 */
export function 提取回忆证据(楼层: number, 角色: string, 文本: string): 回忆证据 | null {
  const 块: string[] = [];
  for (const 匹配 of 文本.matchAll(回溯块))
    块.push(匹配[1]);
  const 剩余 = 文本.replace(回溯块, '');
  const 未闭合位置 = 剩余.indexOf('<recall>');
  const 块外 = 未闭合位置 >= 0 ? 剩余.slice(0, 未闭合位置) : 剩余;
  const 编码 = 取编码(`${块.join('\n')}\n${块外}`);
  const 未闭合 = 有无闭合(文本);
  if (编码.length === 0 && 块.length === 0 && !未闭合)
    return null;
  return Object.freeze({
    楼层,
    角色,
    编码: Object.freeze(编码),
    块: Object.freeze(块),
    未闭合,
    来源: '聊天原文' as const,
  });
}

// ---------------------------------------------------------------------------
// 选楼层
// ---------------------------------------------------------------------------

function 按楼层排序(列表: 推进消息[]): 推进消息[] {
  return [...列表].sort((a, b) => a.message_id - b.message_id);
}

/** 同一个楼层号只留第一份(平台偶尔给出重复条目; 重复会让提示词里同一段出现两次) */
function 去重楼层(列表: 推进消息[]): 推进消息[] {
  const 见过 = new Set<number>();
  const 结果: 推进消息[] = [];
  for (const 楼层 of 列表) {
    if (见过.has(楼层.message_id))
      continue;
    见过.add(楼层.message_id);
    结果.push(楼层);
  }
  return 结果;
}

function 是楼层(value: unknown): value is 推进消息 {
  const 候选 = value as 推进消息 | null;
  return !!候选 && typeof 候选 === 'object' && Number.isFinite(Number(候选.message_id));
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 收集本轮推进要用的输入。
 *
 * - 锚点封上界: 只读 `message_id <= anchorFloor` 的楼层; 上下文 user 更是**严格小于**锚点。
 * - 隐藏楼层不取(也不为凑够 N 条把它们拉回来)。
 * - `clearFloor === null` 表示从未清空; 给数字时只读严格大于它的楼层。
 * - 初始化: 取最近 `recentCount` 条完整 assistant(更早的不追补, 并告警说明)。
 * - 已有状态: 最近 `recentCount` 条上下文 + 全部未处理(`message_id > processedFloor`);
 *   超出 `recentCount` 只明确告警, **绝不从某一条中间截断**, 也不漏中间跨日。
 */
export function 收集推进输入(messages: readonly 推进消息[], options: 推进输入选项): 推进输入 {
  const warnings: string[] = [];
  const 空 = (): 推进输入 => ({
    recent: [],
    reply: '',
    latestReply: '',
    context: '',
    scanText: '',
    recall: [],
    warnings,
    unprocessedIds: [],
  });

  // 楼层号统一成数字(平台有时给字符串); 复制一份, 不改调用方传进来的数组
  const 楼层们 = (Array.isArray(messages) ? messages : [])
    .filter(是楼层)
    .map(楼层 => ({ ...楼层, message_id: Number(楼层.message_id) }));
  const filter = typeof options?.filter === 'function' ? options.filter : (文本: string) => 文本;
  const 取正文 = (文本: string): string => 取文本(filter(剥离回忆协议块(文本)));
  const 原文 = (楼层: 推进消息): string => 取文本(楼层.message);

  const anchor = Number(options?.anchorFloor);
  if (!Number.isFinite(anchor) || anchor < 0) {
    warnings.push(`锚点楼层无效(${取文本(options?.anchorFloor)})：本轮不收集输入, 也不发起推进。`);
    return 空();
  }

  const 配置条数 = Number(options?.recentCount);
  const recentCount = Math.max(1, Number.isFinite(配置条数) ? Math.round(配置条数) : 1);
  const 配置进度 = Number(options?.processedFloor);
  const processedFloor = Number.isFinite(配置进度) ? 配置进度 : 0;
  const 清空配置 = options?.clearFloor;
  const clearFloor = 清空配置 === null || 清空配置 === undefined || !Number.isFinite(Number(清空配置))
    ? null
    : Number(清空配置);
  const initialized = options?.initialized === true;

  // 清空截止: null = 未清空; 数字 = 严格大于它才读
  const 在截止后 = (id: number): boolean => clearFloor === null || id > clearFloor;
  const 可见 = (楼层: 推进消息): boolean => 楼层.is_hidden !== true;

  const assistant们 = 去重楼层(按楼层排序(楼层们.filter(楼层 =>
    String(楼层.role ?? '') === 'assistant' && 可见(楼层) && 楼层.message_id <= anchor && 在截止后(楼层.message_id),
  )));

  // 诊断用的计数(不影响选择, 只把"为什么少了"说出来)
  const 隐藏助手数 = 楼层们.filter(楼层 =>
    String(楼层.role ?? '') === 'assistant'
    && 楼层.is_hidden === true
    && 楼层.message_id <= anchor
    && 在截止后(楼层.message_id)
    && 楼层.message_id > processedFloor,
  ).length;
  const 截止外条数 = clearFloor === null
    ? 0
    : 楼层们.filter(楼层 => String(楼层.role ?? '') === 'assistant' && 楼层.message_id <= clearFloor).length;

  // 未处理: 严格大于 processedFloor 的 assistant, 全部要, 一条都不能漏
  const 未处理 = initialized ? assistant们.filter(楼层 => 楼层.message_id > processedFloor) : assistant们;
  // 上下文: 已有状态时, 再往前带最近 N 条已处理的 assistant(让模型知道上一段因果)
  const 上下文池 = initialized ? assistant们.filter(楼层 => 楼层.message_id <= processedFloor) : [];
  const 上下文 = 上下文池.slice(-recentCount);

  const 选中 = 去重楼层(按楼层排序(initialized ? [...上下文, ...未处理] : assistant们.slice(-recentCount)));

  if (选中.length === 0) {
    warnings.push(`没有可分析的 AI 回复(锚点 #${anchor}、清空截止 ${clearFloor === null ? '无' : `#${clearFloor}`})：本轮不发起推进。`);
    return 空();
  }

  // ---- 选了多少、为什么这么多: 告警必须能被人看懂 ----
  if (!initialized) {
    warnings.push(`首次建立输入：只取最近 ${选中.length} 条完整 assistant 作为起点(更早的旧回复不追补, 也不会被你这次设置的上限之外的重扫偷偷带回)。`);
  }
  else if (未处理.length > recentCount) {
    warnings.push(`未处理回复 ${未处理.length} 条，超过「读取最近回复数」${recentCount}：已全部补全(不从任意一条中间截断, 也不漏中间跨日)。`);
  }
  else if (选中.length > recentCount) {
    warnings.push(`本轮纳入 ${选中.length} 条 assistant，超过「读取最近回复数」${recentCount}：其中 ${上下文.length} 条是上下文、${未处理.length} 条未处理; 按"上下文 + 全部未处理"补全, 不截断。`);
  }
  if (initialized && 未处理.length === 0) {
    warnings.push(`锚点 #${anchor} 不在未处理区间(已处理到 #${processedFloor})：本轮只重扫最近 ${选中.length} 条作为上下文, 不会重复把旧楼层当新发生。`);
  }
  if (隐藏助手数 > 0)
    warnings.push(`未处理区间内有 ${隐藏助手数} 条隐藏回复, 已跳过(不为凑数把隐藏楼层拉回来)。`);
  if (截止外条数 > 0)
    warnings.push(`清空截止 #${clearFloor} 之前的 ${截止外条数} 条回复已排除(清空后只读严格大于截止的楼层)。`);

  const recent: 输入楼层[] = 选中.map(楼层 => {
    const 条 = {
      message_id: 楼层.message_id,
      角色: String(楼层.role ?? ''),
      原文: 原文(楼层),
      正文: 取正文(原文(楼层)),
    };
    return typeof 楼层.swipe_id === 'number' ? Object.freeze({ ...条, swipe_id: 楼层.swipe_id }) : Object.freeze(条);
  });

  const 空正文 = recent.filter(楼层 => 楼层.正文.trim() === '' && 楼层.原文.trim() !== '');
  if (空正文.length > 0)
    warnings.push(`楼层 ${空正文.map(楼层 => `#${楼层.message_id}`).join('、')} 在剥掉回忆块/标签过滤后没有正文: 原文仍完整保留, 但这一条对模型只剩空壳。`);

  const reply = recent
    .map((楼层, index) => `【${index === recent.length - 1 ? '最新回复' : `较早回复 ${index + 1}`}】\n${楼层.正文}`)
    .join('\n\n');
  const latestReply = recent[recent.length - 1].正文;

  // 上下文: 锚点之前最近一条 user(严格小于锚点), 隐藏楼层不取, 清空截止同样生效
  const user们 = 按楼层排序(楼层们.filter(楼层 =>
    String(楼层.role ?? '') === 'user' && 可见(楼层) && 楼层.message_id < anchor && 在截止后(楼层.message_id),
  ));
  const 上下文楼层 = user们.length > 0 ? user们[user们.length - 1] : null;
  const context = 上下文楼层 ? 取正文(原文(上下文楼层)) : '';

  // 扫描材料: 原始文本, 按楼层时序; **不吃 filter**(aftertalk 里的 AM 关键词要留着)
  const 扫描楼层 = 去重楼层(按楼层排序([
    ...(上下文楼层 ? [上下文楼层] : []),
    ...选中,
  ]));
  const scanText = 扫描楼层
    .map(楼层 => `【楼层 #${楼层.message_id} · ${String(楼层.role ?? '')}】\n${原文(楼层)}`)
    .join('\n\n');

  // 回忆证据: 只读元数据; 未闭合块显式告警
  const recall: 回忆证据[] = [];
  for (const 楼层 of 扫描楼层) {
    const 证据 = 提取回忆证据(楼层.message_id, String(楼层.role ?? ''), 原文(楼层));
    if (!证据)
      continue;
    recall.push(证据);
    if (证据.未闭合)
      warnings.push(`楼层 #${楼层.message_id} 的 <recall> 未闭合：这一层原文完整保留、不做任何清理(不删前后正文, 也不删任何块)；请拒绝本轮, 不要把残缺协议喂给模型。`);
    const 有码无时差 = /AM\d+\s*\|/.test(原文(楼层)) && 证据.编码.length === 0;
    if (有码无时差)
      warnings.push(`楼层 #${楼层.message_id} 的回忆块里有 AM 编码但缺少可解析的相对时差：未采纳(不猜残缺编码)。`);
  }
  const 编码总数 = recall.reduce((合计, 条) => 合计 + 条.编码.length, 0);
  if (编码总数 > 0) {
    warnings.push(`扫描材料里出现 ${编码总数} 条 AM 编码(来自聊天原文)：这只是重扫原料, 不等于主 AI 本次请求最终激活的同一批记忆, 不要显示成"已与主请求对齐"。`);
  }

  return {
    recent,
    reply,
    latestReply,
    context,
    scanText,
    recall: Object.freeze(recall) as unknown as 回忆证据[],
    warnings,
    unprocessedIds: (initialized ? 未处理 : 选中).map(楼层 => 楼层.message_id),
  };
}
