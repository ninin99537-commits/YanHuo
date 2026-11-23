// 烟火 · 面板动作: 面板里那些**与渲染无关**的规则(筛事件 / 推进记录 / 报错报告)。
//
// 症状(候选: 面板没有「页」接缝): 面板机制.ts 把 iframe/拖动那一层抽走了(好), 但六个页签的
// 非视觉逻辑全留在 悬浮球界面.vue 的同一个 setup 作用域里 —— 动态怎么筛、日志页那两段文本怎么拼,
// 都只能靠 `?raw` 字符串断言验(整个 .vue 当文本 import), 按字符串验、不按行为验。
//
// 这里只搬**纯函数**: 吃数据、吐数据/文本, 不碰 Vue、不碰 toast、不碰设置存储。
// 视图那边留一行 computed 调用; 这三件事因此第一次能在 Node 里被断言。
import type { WorldEvent } from './schema';

// ---------------------------------------------------------------------------
// 动态: 阶段 / 规模 两道筛选
// ---------------------------------------------------------------------------

// v2.10.0: 活跃那一桶叫「未结束」(阶段值本身有了「进行中」, 不能再拿它当筛选名)
export type 阶段筛选 = '全部' | '未结束' | '已结束';

/**
 * 两个桶: 活跃(`事件`)与墓碑(`已结束`)。各自**最新在前**;
 * 「全部」时两个桶都在, 且活跃的必须排在墓碑上面(墓碑是"已经翻过去的"那一段)。
 * 阶段与规模都是「全部」以外的值才过滤。
 */
export function 筛事件(
  活跃: WorldEvent[],
  墓碑: WorldEvent[],
  阶段: 阶段筛选,
  规模: string,
): WorldEvent[] {
  const 倒序活跃 = [...活跃].reverse();
  const 倒序墓碑 = [...墓碑].reverse();
  const 候选 = 阶段 === '未结束' ? 倒序活跃 : 阶段 === '已结束' ? 倒序墓碑 : [...倒序活跃, ...倒序墓碑];
  return 规模 === '全部' ? 候选 : 候选.filter(event => event.规模 === 规模);
}

// ---------------------------------------------------------------------------
// 日志页: 推进记录 / 报错报告(两段文本, 用户点了复制就原样带走)
// ---------------------------------------------------------------------------

export interface 尝试项 {
  次: number;
  原文: string | null;
  错误: string | null;
}

/** 一次推进的记录形状(只取拼文本用得到的字段; 与日志仓的 DebugLog 结构兼容) */
export interface 推进记录 {
  time?: number;
  model?: string;
  replyIds?: number[];
  summary?: string;
  addedEvents?: string[];
  updatedEvents?: string[];
  removedEvents?: string[];
  request?: string;
  response?: string;
  error?: string;
  备注?: string[];
  尝试?: 尝试项[];
}

/** 每次尝试各留一份(v2.8.5 D1): 复制出去的报告里也带着失败那次的完整原文 */
export function 尝试段落(尝试?: 尝试项[]): string[] {
  if (!尝试 || 尝试.length <= 1) return [];
  return 尝试.map(项 => `\n── 第 ${项.次} 次尝试${项.错误 ? `（失败: ${项.错误}）` : '（通过）'} ──\n${项.原文 || '(这次没拿到输出)'}`);
}

/**
 * 推进记录文本(日志页「复制记录」)。
 * @param 时间文本 时间戳 → 人话; 由调用方注入, 免得这个 module 依赖界面层的格式化函数
 */
export function 构建推进记录(log: 推进记录 | null | undefined, 时间文本: (t?: number) => string): string {
  if (!log) return '(暂无推进记录)';
  const parts = [
    '[烟火] 推进记录',
    `时间: ${时间文本(log.time)} / 模型: ${log.model || '(未选)'} / 楼层: ${(log.replyIds?.length ?? 0) > 0 ? log.replyIds!.map(id => `#${id}`).join(', ') : '(无)'} / 小结: ${log.summary || '(无)'}`,
    ...((log.addedEvents?.length ?? 0) > 0 ? [`新增事件: ${log.addedEvents!.join('、')}`] : []),
    ...((log.updatedEvents?.length ?? 0) > 0 ? [`推进事件: ${log.updatedEvents!.join('、')}`] : []),
    ...((log.removedEvents?.length ?? 0) > 0 ? [`了结事件: ${log.removedEvents!.join('、')}`] : []),
    ...(log.request ? ['\n── 发送给世界引擎的内容 ──\n' + log.request] : []),
    ...(log.response ? ['\n── 世界引擎输出 ──\n' + log.response] : []),
    ...(log.error ? ['\n── 报错 ──\n' + log.error] : []),
    ...(log.备注 ?? []).map(条 => `备注: ${条}`),
    ...尝试段落(log.尝试),
  ];
  return parts.join('\n');
}

/**
 * 报错报告文本(日志页「复制报错报告」)。
 * 与推进记录的区别: 模型取的是**当前设置**里的接口模型(报错时用户往往刚改过配置),
 * 且没有报错时留一句提示而不是省略。
 */
export function 构建报错报告(
  log: 推进记录 | null | undefined,
  模型: string,
  版本: string,
  时间文本: (t?: number) => string,
): string {
  const parts = [
    `[烟火] 报错报告 · ${版本}`,
    `时间: ${时间文本(log?.time)} / 模型: ${模型 || '(未选)'}`,
    ...((log?.replyIds?.length ?? 0) > 0 ? [`楼层: ${log!.replyIds!.map(id => `#${id}`).join(', ')}`] : []),
    ...(log?.request ? ['\n── 发送给世界引擎的内容 ──\n' + log.request] : []),
    ...(log?.response ? ['\n── 世界引擎输出 ──\n' + log.response] : []),
    ...(log?.error ? ['\n── 报错 ──\n' + log.error] : ['\n(无报错记录——请描述你遇到的问题)']),
    ...(log?.备注 ?? []).map(条 => `备注: ${条}`),
    ...尝试段落(log?.尝试),
  ];
  return parts.join('\n');
}
