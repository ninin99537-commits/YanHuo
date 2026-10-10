// 烟火 v2.5 · 墓碑不进请求体(`已了结` 独立成桶)
//
// 上一版(v2.4.1, 未发布)想让提示词把"只剩墓碑等同于空清单"讲清楚; 真机仍然出问题, 根因是
// **结构**而不是措辞: 墓碑与活跃事混在同一个 `事件` 数组里, 每轮都在提醒模型"清单里还有东西"。
// v2.5 改成: `事件` 只表示"此刻在发生的事"(全部归 AI), 「已了结」独立成桶(全部归代码)。
// 于是唯一的新不变量是: **`事件` 数组里永不出现 阶段 === '已结束'**。
//
// 本文件钉住"世界引擎这一侧"的契约:
//   [1] 请求体里 `事件` 没有墓碑, 且请求体里**没有** `已了结` 这个键(放进去模型会照着输出);
//   [2] 墓碑唯一的去处是一份**只读标题清单**(在 JSON 块之外、层开关之前);
//   [3] 三处契约文字(④ / 事件字段的阶段 / 删净的死文本);
//   [4] 没动的红线;
//   [5] **注入给主 AI 的内容逐字不变**(回归红线, 冻结了改动前跑出来的那一份文本);
//   [6] 日志口径。
// 数据侧(迁移 / 合并 / 上限 / 手改 / 面板)在 tests/world-ended-bucket.test.ts。
import { createPinia, setActivePinia } from 'pinia';
import { buildInjectionPrompt, buildTickMessages, SYSTEM_PROMPT } from '../src/烟火_世界运转/prompts';
import 提示词源码 from '../src/烟火_世界运转/prompts.ts?raw';
import update源码 from '../src/烟火_世界运转/update.ts?raw';
import { SettingsSchema, type WorldData, type WorldEvent } from '../src/烟火_世界运转/schema';
import { emptyData, ENDED_EVENT_LIMIT, EVENT_LIMIT } from '../src/烟火_世界运转/state';

(globalThis as any)._ = {
  clamp: (value: number, lower: number, upper: number) => Math.min(Math.max(value, lower), upper),
  cloneDeep: (value: any) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value))),
};
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
setActivePinia(createPinia());

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  PASS  ${label}`);
  }
  else {
    fail++;
    console.log(`  FAIL  ${label}\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`);
  }
}
function ok(label: string, cond: boolean) {
  check(label, !!cond, true);
}
function 出现次数(文本: string, 片段: string): number {
  return 文本.split(片段).length - 1;
}

function 事件(部分: Partial<WorldEvent>): WorldEvent {
  return {
    id: '', 标题: '', 描述: '', 地点: '', 时间: '', 规模: '要事', 传播: '本埠',
    渠道: '公告', 势力: '', 阶段: '进行', 隐秘: '公开', 代表人物: '', 前情: '', 演变: [],
    ...部分,
  };
}

// 新格式: 活跃的在 `事件`, 墓碑在 `已了结`
const 两件墓碑 = [
  事件({ id: 'e1', 标题: '盐引亏空案结案', 描述: '户部追缴完毕', 阶段: '已结束', 时间: '元和三年·二月' }),
  事件({ id: 'e2', 标题: '雁门互市重开', 描述: '边市复市', 阶段: '已结束', 时间: '元和三年·三月初一' }),
];
const 一件活跃 = 事件({ id: 'e3', 标题: '北境骑兵集结', 描述: '前锋已至雁门外', 阶段: '进行', 时间: '元和三年·三月初七' });

const world: WorldData = { ...emptyData(), 事件: [一件活跃], 已了结: [...两件墓碑] };
world.世界.时间 = '元和三年·三月初七';
world.世界.氛围 = '山雨欲来';
world.世界.总览 = '朝局暗涌';

const 设置 = SettingsSchema.parse({});

const 基础输入 = {
  world,
  reply: '【最新回复】\n他推开门, 街上湿漉漉的。',
  replyCount: 1,
  context: '我去街上走走',
  timeJump: null,
  时间约束: '正文未给出新日期, 沿用上次世界时间',
  worldbook: '',
  playerName: '沈砚',
  playerDesc: '一个书生',
  破限: false,
  头部填充: false,
  头部填充文本: '',
  防截断: false,
  预填充: false,
  节令历法: true,
  世界指标: true,
  世界密度: '正常' as const,
};
const 任务消息 = buildTickMessages(基础输入).filter(m => m.role === 'user')[0].content;
/** 【世界当前状态】那一段就是块里第二行的一整份 JSON */
const 状态快照 = JSON.parse(任务消息.split('\n')[1]);
/** 只读清单那一行 */
const 只读行 = 任务消息.split('\n').find(line => line.startsWith('【已经了结的事(只读)】')) ?? '';

console.log('\n[1] 请求体: `事件` 里没有墓碑, 也没有 `已了结` 这个键');
{
  check('事件只有活跃的那 1 条', 状态快照.事件.length, 1);
  check('事件里没有墓碑', 状态快照.事件.filter((e: any) => e.阶段 === '已结束').length, 0);
  ok('JSON 块里没有 已了结 这个键(放进去模型会照着输出)', !('已了结' in 状态快照));
  const JSON块 = 任务消息.split('\n')[1];
  ok('JSON 块里没有第一件墓碑', !JSON块.includes('盐引亏空案结案'));
  ok('JSON 块里没有第二件墓碑', !JSON块.includes('雁门互市重开'));
  check('整个请求体里 已了结 这个键一次都不出现', 出现次数(任务消息, '已了结'), 0);
}

console.log('\n[2] 墓碑唯一的去处: 一份只读标题清单(在 JSON 块之外)');
{
  check('只读行存在', 只读行.startsWith('【已经了结的事(只读)】'), true);
  ok('两件墓碑的标题都在', 只读行.includes('盐引亏空案结案') && 只读行.includes('雁门互市重开'));
  ok('用、连接', 只读行.includes('盐引亏空案结案、雁门互市重开'));
  ok('写明只读纪律', 只读行.includes('仅供你避免把同一件事重开一遍; 不要维护它们, 不要在输出里出现, 也不要把它们带回。'));
  const 行 = 任务消息.split('\n');
  const JSON行号 = 行.findIndex(line => line.startsWith('{"世界"'));
  const 只读行号 = 行.findIndex(line => line.startsWith('【已经了结的事(只读)】'));
  const 层开关键行号 = 行.findIndex(line => line.startsWith('【层开关】'));
  ok('排在【世界当前状态】的 JSON 之后、层开关之前', JSON行号 >= 0 && JSON行号 < 只读行号 && 只读行号 < 层开关键行号);

  const 无墓碑 = buildTickMessages({ ...基础输入, world: { ...world, 已了结: [] } }).filter(m => m.role === 'user')[0].content;
  ok('没有墓碑时写 (无)', 无墓碑.includes('【已经了结的事(只读)】(无)'));
}

console.log('\n[3] 契约文字: ④ 重写 / 事件字段的阶段 / 两句死文本删净');
{
  ok('④ 写明"了结就是把阶段改成已结束"', 提示词源码.includes('了结就是把它的 阶段 改成"已结束"——脚本会把它搬出清单, 另外替你保留最近 6 条供面板回顾。'));
  ok('④ 写明已了结的事不许出现在输出里', 提示词源码.includes('**已经了结的事不要出现在你的输出里**: 你带回的清单里只该有还在酝酿/进行/尾声的事。'));
  ok('事件字段的阶段改成了"本轮了结它才填"', 提示词源码.includes('阶段(酝酿/进行/尾声; 本轮了结它才填 已结束)'));
  const 视同空 = '(清单里只剩"已结束"条目时, 视同空清单。)';
  check('上一版那句死文本已删净(全提示词 0 处)', 出现次数(提示词源码, 视同空), 0);
  check('SYSTEM_PROMPT 里也没有', 出现次数(SYSTEM_PROMPT, 视同空), 0);
  check('任务指令里也没有', 出现次数(任务消息, 视同空), 0);
  ok('输出契约(SYSTEM_PROMPT)里没有 `已了结` 这个键', !SYSTEM_PROMPT.includes('已了结'));
}

console.log('\n[4] 没动的红线');
{
  check('EVENT_LIMIT 仍是 30', EVENT_LIMIT, 30);
  check('ENDED_EVENT_LIMIT 仍是 6', ENDED_EVENT_LIMIT, 6);
  ok('事件上限定语仍是"见【运转密度】"(配额单点没被这轮破坏)', 提示词源码.includes('④ 进行中(酝酿/进行/尾声)总数上限见【运转密度】'));
  ok('合格线与标尺没动', 提示词源码.includes('【事件合格线】三问全过才算事件:') && 提示词源码.includes('影响半径不足一城/一域/一方的, 无论当事人级别多高都不算要事'));
  ok('请求体仍保留 `事件` 这个键(解析契约依赖它)', 状态快照.事件 !== undefined && 提示词源码.includes('事件: currentEvents'));
}

console.log('\n[5] 注入给主 AI 的内容逐字不变(回归红线)');
{
  // 这一份是**改动前**(HEAD 的 prompts.ts)对下面同一份世界的注入输出, 由 .tmp 里的临时脚本跑出来后冻结;
  // 改动后 `事件` 里不再有墓碑, 所以喂进去的是"活跃在 事件 / 墓碑在 已了结"的新格式
  const 冻结注入 = "[烟火 · 世界动向]\n以下是这个世界正在发生的动向——世界自己的事, 大多与主角无关。角色只能通过合理渠道(亲历/听说/告示/报道/情报)得知, 不许全知; 不要把所有动向都塞进主角的见闻里。\n时间: 2025-03-01 09:00\n氛围: 寒意未消\n总览: 镇上不太平\n势力暗流(幕后组织的当前盘算与动向, 大多与主角无关):\n势力 | 头面人物 | 势力范围 | 目标 | 动向 | 对外关系 | 前情\n商会 | 王掌柜 | 东街 | 赚钱 | 守成 | — | 老字号\n世界事件(公共层动态, 大多与主角无关, 可自然衔接但不要整段播报):\n标题 | 时间 | 地点 | 描述 | 前情 | 渠道 | 势力 | 代表人物\n北境骑兵集结 | 2025-01-01 08:00 | 北境 | 边军调动 | — | 军报 | — | —\n(以上是世界动向: 它们是世界自己的事, 大多与主角无关; 角色只能通过合理渠道得知, 不要写成全员皆知, 也不要主动大段播报。)";
  const 新格式 = {
    ...emptyData(),
    世界: { 时间: '2025-03-01 09:00', 氛围: '寒意未消', 总览: '镇上不太平' },
    事件: [
      事件({ id: 'e1', 标题: '北境骑兵集结', 描述: '边军调动', 地点: '北境', 时间: '2025-01-01 08:00', 阶段: '进行', 规模: '大事', 传播: '天下', 渠道: '军报' }),
      事件({ id: 'e2', 标题: '互市重开', 描述: '边市复市', 时间: '2025-01-01 08:00', 阶段: '酝酿', 隐秘: '隐秘', 势力: '商会' }),
    ],
    已了结: [
      事件({ id: 't1', 标题: '盐引亏空案结案', 描述: '户部追缴完毕', 阶段: '已结束' }),
      事件({ id: 't2', 标题: '老桥塌了', 描述: '无人伤亡', 阶段: '已结束' }),
    ],
    势力: {
      商会: { 目标: '赚钱', 动向: '守成', 前情: '老字号', 势力范围: '东街', 对外关系: '', 头面人物: '王掌柜' },
    },
  } as WorldData;
  const 注入 = buildInjectionPrompt(新格式, 设置);
  check('注入文本与改动前逐字一致', 注入, 冻结注入);
  ok('注入里没有墓碑', !注入.includes('盐引亏空案结案') && !注入.includes('老桥塌了'));
  check('墓碑桶对注入毫无影响(有墓碑 / 没墓碑, 注入一模一样)', buildInjectionPrompt({ ...新格式, 已了结: [] }, 设置), 注入);
  ok('注入过滤器只按标题(不再按阶段——事件里本就没有墓碑)', 提示词源码.includes('const events = (data.事件 ?? []).filter(event => event.标题).reverse();'));
}

console.log('\n[6] 日志口径: 两个桶各报各的(行为级断言见 world-pipeline.test.ts 的 [7])');
{
  ok('直接读两个桶', update源码.includes('(进行中 ${newData.事件.length} 件 / 已了结 ${(newData.已了结 ?? []).length} 件'));
  ok('旧的「事件 N 件」口径已删干净', !update源码.includes('const eventCount') && !update源码.includes('(事件 ${eventCount} 件'));
  ok('上一版的"从事件里数"也删干净了', !update源码.includes("newData.事件.filter(event => event.阶段 !== '已结束').length"));
  ok('新增计数仍保留', update源码.includes('新增 ${diff.added.length} 件'));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0)
  process.exit(1);
