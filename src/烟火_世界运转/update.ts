import { klona } from 'klona';
import { chatCompletion, maskBaseUrl } from './api';
import { buildTickMessages } from './prompts';
import { getFreshSettings, getSettings } from './settings';
import { useDebugStore, useDiffStore, useStateStore, useUpdatingStore } from './state';
import { 世界状态存档, 绑定楼层, 归属仍有效, type 楼层归属 } from './保存世界状态';
import { getActiveWorldbookBundle } from './worldbook-read';
import { useHost } from './host';
import { syncWorldbookEntry } from './inject';
import { toastError, toastInfo, toastSuccess, toastWarning } from './toast';
import { 请求并校验 } from '../共用/模型往返';
import { createTextFilter } from '../共用/楼层标签过滤';
import { 事件账目, 构建推进弹窗文案, validateAndNormalize } from './世界数据';
import { 解析世界载荷 } from './解析';
import { 收集推进输入, type 推进消息 } from './更新输入';
import { 建立世界时间约束, 描述世界日差, 算跨世界日 } from './时间校验';
import { 构建公开摘要, 选工作事件 } from './公开摘要';
import { 版本标签 } from './版本';
import { 判定给模型, 掷到期判定, 收尾到期判定 } from './到期判定';
import { 维护节奏 } from './节奏';
import { 格式化彼方公域切片, 读取彼方公域切片 } from './彼方联动';

export interface 推进结果 {
  状态: '已提交' | '待同步' | '跳过' | '取消' | '失败';
  说明: string;
}
let isUpdating = false;
let generation = 0;

/** 撤销在途任务，不依赖上游一定能真正停止；晚返回仍需通过归属闸门。 */
export function 取消世界推进(): void {
  generation++;
  useUpdatingStore().cancel();
}

function 读取输入窗口(anchor: number, recentCount: number, processed: number, initialized: boolean): 推进消息[] {
  const host = useHost();
  let start = Math.max(0, anchor - Math.max(60, recentCount * 10));
  if (initialized) start = Math.min(start, Math.max(0, processed));
  let messages = host.chat.messages(`${start}-${anchor}`);
  while (start > 0 && messages.filter(m => m.role === 'assistant' && !m.is_hidden && (!initialized || m.message_id <= processed)).length < recentCount) {
    const previous = Math.max(0, start - Math.max(60, recentCount * 10));
    messages = [...host.chat.messages(`${previous}-${start - 1}`), ...messages];
    start = previous;
  }
  return messages;
}

export async function updateWorld(force = false): Promise<推进结果> {
  if (isUpdating) return { 状态: '跳过', 说明: '上一次推进尚未结束' };
  isUpdating = true;
  const run = ++generation;
  const debug = useDebugStore();
  const updating = useUpdatingStore();
  const store = useStateStore();
  const signal = updating.start('读取完整世界材料…');
  let origin: 楼层归属 | null = null;
  let inputOrigins: 楼层归属[] = [];
  let stage = '读取';
  let committed = false;
  const check = () => {
    if (signal.aborted || generation !== run || !origin || !归属仍有效(origin) || inputOrigins.some(item => !归属仍有效(item))) {
      const error = Error('本轮已取消或输入所属聊天、分支、正文、世界修订发生变化');
      error.name = '失效推进';
      throw error;
    }
    const current = getFreshSettings();
    if (!current.启用运转 || (!force && !current.运转.自动更新)) {
      const error = Error('世界推进已停用，本次结果不提交'); error.name = '失效推进'; throw error;
    }
  };
  try {
    const settings = klona(getFreshSettings());
    if (!settings.启用运转 || (!force && !settings.运转.自动更新)) return { 状态: '跳过', 说明: '世界推进已停用或自动更新已暂停' };
    if (!settings.接口.地址 || !settings.接口.模型) {
      toastWarning('尚未配置接口地址或模型，请先完成设置', '烟火');
      return { 状态: '跳过', 说明: '接口未配置' };
    }
    const host = useHost();
    const last = host.chat.lastMessageId();
    const tail = host.chat.messages(`${Math.max(0, last - 60)}-${last}`, { role: 'assistant' }).filter(m => !m.is_hidden);
    const anchor = tail.at(-1)?.message_id;
    if (anchor == null) return { 状态: '跳过', 说明: '没有可分析的AI回复' };
    origin = 绑定楼层(anchor);
    if (!origin.聊天) throw Error('当前聊天身份不可确认，未发起推进');
    const saved = 世界状态存档.读取();
    // 重推只读取更早基准；未校验的新响应不提前删除最后好快照。
    const data = force && saved.锚点楼层 === anchor ? 世界状态存档.重推基准(anchor) : saved;
    const input = 收集推进输入(读取输入窗口(anchor, settings.运转.读取最近回复数, data.处理到楼层, data.锚点楼层 >= 0), {
      anchorFloor: anchor, recentCount: settings.运转.读取最近回复数,
      processedFloor: data.处理到楼层, clearFloor: saved.清空截止 ?? (saved.清空层 > 0 ? saved.清空层 : null),
      initialized: data.锚点楼层 >= 0, filter: createTextFilter(settings.标签),
    });
    if (!input.recent.length) return { 状态: '跳过', 说明: input.warnings.join('\n') };
    if (input.recall.some(row => row.未闭合)) throw Error('本轮存在未闭合的回溯协议，完整原文保留但不发起模型请求；请修正协议后重试');
    if (!input.latestReply.trim()) return { 状态: '跳过', 说明: '本轮过滤后没有完整有效正文' };
    inputOrigins = input.recent.map(row => 绑定楼层(row.message_id));
    const fingerprint = JSON.stringify([origin.楼层, origin.分支, input.recent.map(row => [row.message_id, row.原文]), input.context, input.recall]);
    if (!force && saved.处理到楼层 >= anchor && saved.处理签名 === fingerprint) return { 状态: '跳过', 说明: '这份聊天分支和完整正文已经处理，不重复推进' };
    const timeRows = force && saved.锚点楼层 === anchor ? input.recent.map(row => row.正文)
      : input.recent.filter(row => data.锚点楼层 < 0 || input.unprocessedIds.includes(row.message_id)).map(row => row.正文);
    const timeConstraint = 建立世界时间约束(timeRows.length ? timeRows : [input.latestReply], data.世界.时间);
    const crossed = 算跨世界日(timeConstraint, data.世界.时间);
    const recalled = input.recall.at(-1)?.编码.map(row => row.码) ?? [];
    check();
    stage = '世界书读取';
    const books = settings.运转.读取世界书 ? await getActiveWorldbookBundle(input.scanText, {
      excludeNames: settings.运转.世界书排除, includeGlobal: settings.运转.读取全局世界书, expectedAM: recalled,
    }) : null;
    check();
    // 到期掷骰(v2.9.3): 请求前掷一次, 三次原样重试发的是同一份请求, 结果天然一致。
    // 只掷"本轮至少跨过的世界日之后肯定已经到期"的; 基准快照里同一到期点已有判定(上轮没展开)就沿用, 不重掷。
    const 本轮判定 = settings.运转.到期掷骰 !== false
      ? 掷到期判定(data, typeof crossed === 'object' && crossed ? crossed.最少 : 0)
      : new Map();
    const 彼方切片 = settings.运转.联动彼方 !== false ? 读取彼方公域切片(host, anchor) : null;
    const 彼方人物动向 = 彼方切片 ? 格式化彼方公域切片(彼方切片) : '';
    const workEvents = 选工作事件(data, settings, [input.context, input.reply].join('\n'), new Set(本轮判定.keys())).map(event => event.id || event.标题);
    const messages = buildTickMessages({
      world: data, reply: input.reply, replyCount: input.recent.length, context: input.context,
      timeJump: timeConstraint.跳跃, 时间约束: timeConstraint.提示, 跨日: crossed,
      worldbook: books?.facts ?? '', memory: books?.memory ?? '', recallContext: JSON.stringify(input.recall),
      工作事件: workEvents, 运转: settings.运转,
      playerName: host.persona.name(), playerDesc: host.persona.description(),
      预填充: settings.运转.预填充,
      世界形势: settings.运转.世界形势,
      世界日程: settings.运转.世界日程, 世界指标: settings.运转.世界指标, 世界密度: settings.运转.世界密度,
      到期判定: 判定给模型(本轮判定),
      彼方人物动向,
      自定义提示词: settings.运转.自定义提示词,
    });
    const notes = [...input.warnings, ...(books?.warnings ?? []), '世界书记忆按完整聊天原文独立重扫，未核实与主请求同批',
      ...(彼方切片 ? [`已联动彼方幕后人物（${彼方切片.条目.length} 人，截至 #${彼方切片.楼层} 楼；仅公域与暗中打算字段）`] : []),
      ...[...本轮判定].map(([键, 判定]) => `到期判定：${data.事件.find(e => (e.id || e.标题) === 键)?.标题 ?? 键} → ${判定.结果}`)];
    debug.开始新记录({ time: Date.now(), model: settings.接口.模型, replyIds: input.recent.map(row => row.message_id), replyPreview: input.reply,
      timeConstraint: timeConstraint.提示, 版本: 版本标签(), request: messages.map(m => `【${m.role}】\n${m.content}`).join('\n\n'),
      备注: notes, 输入来源: books?.entries ?? [], 提交状态: '候选尚未提交', 工作事件: workEvents });
    stage = '模型调用';
    const result = await 请求并校验({
      messages, 预填充: settings.运转.预填充, signal,
      最多尝试: (settings.运转.重试次数 ?? 2) + 1,
      发请求: (prompt, options) => { check(); return chatCompletion(prompt, { ...options, api: settings.接口 }); },
      解析: text => {
        stage = 'JSON解析'; check();
        const value = 解析世界载荷(text);
        if (value.成功) return value.载荷;
        const error = Error(value.原因); error.name = value.截断 ? '截断' : '解析'; throw error;
      },
      校验: candidate => {
        stage = '字段校验'; check();
        // v2.10.1 起提示词要求 v2(键名换成通用词); v1 照收, 老键名由 validateAndNormalize 搬到新名下
        if (candidate.协议 !== '烟火增量-v2' && candidate.协议 !== '烟火增量-v1') throw Error('响应必须声明协议“烟火增量-v2”，未按形似内容猜测协议');
        return validateAndNormalize(candidate, data, timeConstraint, { 密度: settings.运转.世界密度, 运转: settings.运转, 工作事件: workEvents, 正文: input.latestReply });
      },
      判断错误: (error, phase) => error.name === '失效推进' ? '致命' : phase === '解析' && error.name !== '截断' ? '致命' : phase === '请求' ? '接口' : '反馈',
      名字: '烟火', 结构失败标签: '推进失败', 中断文案: '用户已中断本次推进',
      取重试理由: () => '本轮候选未通过校验，原样重试',
      记日志: log => { if (origin && host.chat.currentChatId() === origin.聊天) debug.record(log); },
      报进度: text => { updating.message = text; },
    });
    check(); stage = '快照提交';
    // 到期判定收尾(v2.9.3): 展开了就清掉; 没展开写进事件, 下一轮沿用同一结果; 别处残留的旧判定清掉
    const 收尾 = 收尾到期判定(data, result.parsed, 本轮判定);
    result.parsed = { ...收尾.数据, 维护备注: [...(收尾.数据.维护备注 ?? []), ...收尾.备注] };
    // 节奏事实(v2.9.3): 本轮有新增 / 有重大事件出现或换阶段 / 有暗线已发生, 就把对应时间记成本轮世界时间
    const 节奏 = 维护节奏(data, result.parsed, 事件账目(data.事件, result.parsed.事件).added.length);
    // 注入粘性(v2.9.0): 用上一份的「上次注入」算出本轮会注入哪几条, 记进新快照。
    // 之后切聊天/预览再按新快照重算, 选中的那几条各多 +8 分, 结果仍是同一批(不动点), 所以不需要正文也不会漂。
    // 「上次注入」显式取自本轮基准 data: validateAndNormalize 现在是 `...oldData` 展开才顺带把它带过来的,
    // 那是隐式依赖 —— 哪天它改成逐项重建, +8 就会静默空转(存下的永远是裸前 N 名)。
    const 本轮注入 = 构建公开摘要({ ...result.parsed, 上次注入: data.上次注入 }, getFreshSettings()).selectedIds;
    const candidate = { ...result.parsed, 上次注入: 本轮注入, 处理签名: fingerprint, 统计: { 推进次数: (data.统计.推进次数 ?? 0) + 1, 最后推进: Date.now(),
      ...(节奏.上次重大事件时间 ? { 上次重大事件时间: 节奏.上次重大事件时间 } : {}), ...(节奏.上次新增时间 ? { 上次新增时间: 节奏.上次新增时间 } : {}) } };
    const commit = 世界状态存档.推进落盘(candidate, anchor, origin);
    if (!commit.落盘) throw Error(commit.说明);
    committed = true;
    store.data = commit.数据;
    useDiffStore().record(data, commit.数据);
    const diff = 事件账目(data.事件, commit.数据.事件);
    debug.record({ addedEvents: diff.added, updatedEvents: diff.updated, removedEvents: diff.removed, summary: commit.数据.小结,
      备注: [...(debug.log?.备注 ?? notes), ...(candidate.维护备注 ?? [])], 提交状态: '快照已提交', 请求统计: {次数: result.请求次数, 毫秒: result.请求耗时} });
    stage = '世界书同步';
    const current = getFreshSettings();
    // 快照提交本身会推进世界修订；同步的归属基准必须取提交后的当前楼层，而不是提交前的 origin，
    // 否则自己刚提交的这一轮会被自己的修订校验误判成“晚到旧结果”。
    const syncOrigin = 绑定楼层(anchor);
    const synced = await syncWorldbookEntry(commit.数据, current.启用运转 && current.运转.注入世界书条目, current,
      () => generation === run && !signal.aborted && 归属仍有效(syncOrigin));
    const projection = 构建公开摘要(commit.数据, current);
    if (projection.overTarget) {
      debug.record({ 备注: [...notes, ...(candidate.维护备注 ?? []), `公开摘要${projection.characters}字符超过目标${projection.targetCharacters}字符：完整条目未截断，不冒充token计数`] });
      toastWarning('公开摘要超过字符目标，内容仍完整保留；可调整整条摘要名额', '烟火');
    }
    // 传播时滞开着却没生效(传讯速度未选 / 主角所在未知 / 历法不可换算): 只记进日志, 不打扰
    if (projection.传播.说明) {
      debug.record({ 备注: [...(debug.log?.备注 ?? []), projection.传播.说明] });
    }
    debug.record({ 提交状态: synced.状态 === '已同步' ? '快照及世界书已同步' : synced.说明 });
    console.info(`[烟火] 世界推进完成: ${描述世界日差(data.世界.时间, candidate.世界.时间)} (进行中 ${candidate.事件.length} 件 / 已结束 ${(candidate.已结束 ?? []).length} 件, 新增 ${diff.added.length} 件, 更新 ${diff.updated.length} 件${diff.removed.length ? `, 了结 ${diff.removed.length} 件` : ''})`);
    if (synced.状态 !== '已同步' && current.运转.注入世界书条目) {
      toastWarning(`快照已保存，${synced.说明}`, '烟火');
      return { 状态: '待同步', 说明: synced.说明 };
    }
    toastSuccess(构建推进弹窗文案(data, commit.数据, diff, candidate.维护备注), '烟火');
    return { 状态: '已提交', 说明: commit.说明 };
  } catch (error) {
    const cancelled = signal.aborted || generation !== run || (error instanceof Error && error.name === '失效推进');
    const reason = error instanceof Error ? error.message : String(error);
    if (origin && useHost().chat.currentChatId() !== origin.聊天) return { 状态: '取消', 说明: '聊天已切换，旧任务不写入当前状态' };
    if (cancelled) {
      debug.record({ error: '', 备注: [reason], 提交状态: committed ? '快照已提交，后续操作取消' : '取消，未提交' });
      toastInfo('本次推进已取消，未校验的新候选不会写入', '烟火');
      return { 状态: '取消', 说明: reason };
    }
    const settings = getSettings();
    const detail = `[烟火] 世界推进失败\n阶段：${stage}\n接口：${maskBaseUrl(settings.接口.地址)}\n错误：${reason}\n${error instanceof Error ? error.stack ?? '' : ''}`;
    debug.record({ error: detail, 提交状态: committed ? '快照已保存，等待重试同步' : '失败，原世界保持' });
    toastError(reason, '烟火推进失败');
    return { 状态: committed ? '待同步' : '失败', 说明: reason };
  } finally { isUpdating = false; updating.stop(); }
}
