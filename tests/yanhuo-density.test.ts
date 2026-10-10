// 烟火 v2.4 · 运转密度三档 + 世界书素材源
//
// 这一轮只做三件事: ①把"静止授权"从量化改为"静止是结论, 不是默认"(不加任何硬配额);
// ②把世界书从"世界观判据"升级为素材源(接上外部燃料, 且不降低事件合格线);
// ③把每轮配额做成玩家可调的三档(稀疏/正常/密集)。
//
// 用例钉住四件事:
//   [1] 三档产出的 user 消息逐行比较, **只有【运转密度】那一行不同**(其余逐字相同);
//   [2] 配额数字只在 运转密度表 里出现一次, 提示词其余位置一律"见【运转密度】",
//       且旧的量化授权句(「占所有回合的一半以上是正常的」「一件新事件也不许新增」)已删净;
//   [3] 世界书素材段与防退化的纪律句在位;
//   [4] 旧设置里没有 世界密度 → 兜底为「正常」, 且不丢其他设置。
import { createPinia, setActivePinia } from 'pinia';
import { buildTickMessages, SYSTEM_PROMPT, 运转密度表 } from '../src/烟火_世界运转/prompts';
import 提示词源码 from '../src/烟火_世界运转/prompts.ts?raw';
import { SettingsSchema } from '../src/烟火_世界运转/schema';
import { emptyData } from '../src/烟火_世界运转/state';
import 界面源码 from '../src/烟火_世界运转/悬浮球界面.vue?raw';

// prompts/schema/state 用到酒馆注入的 `_`; 给最小替身(node 里没有 lodash)
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

// ---------------------------------------------------------------------------
// 固定输入: 五层有内容 + 世界书有设定, 这样素材段/世界书段都在场
// ---------------------------------------------------------------------------
const world = emptyData();
world.世界.时间 = '元和三年·三月初七';
world.世界.氛围 = '山雨欲来';
world.世界.总览 = '朝局暗涌, 边关未靖';
world.地域.京城 = { 概况: '天下中枢', 局势: '物价渐高', 当权者: '中书令·裴肃', 对外关系: '与北境互市', 前情: '三年大旱后迁都议起' };
world.大势.北境战云 = { 概况: '北狄南侵之势', 进展: '前锋已至雁门外', 走向: '或成大战', 前情: '去岁互市断绝' };
world.伏笔 = [{ 标题: '盐引亏空', 埋设: '盐铁新政', 指向: '朝堂清算', 成熟度: '将熟', 前情: '户部亏空被压了半年' }];
world.节令 = [{ 名称: '春汛', 周期: '每年', 时间: '元和三年·三月十五', 概况: '黄河春汛' }];
world.指标.民怨 = { 值: '62', 趋势: '上升', 说明: '粮价带动' };
world.事件 = [{
  id: 'e1', 标题: '雁门互市断绝', 描述: '边市已闭', 地点: '雁门', 时间: '元和三年·二月初一',
  规模: '要事', 传播: '区域', 渠道: '商旅', 势力: '', 阶段: '进行', 隐秘: '公开',
  代表人物: '守将·韩烈', 前情: '北狄索价过高', 演变: [],
}];
world.势力 = { 北狄王庭: { 目标: '南下掠粮', 动向: '集结骑兵', 前情: '连年雪灾', 势力范围: '漠北', 对外关系: '与中原敌对', 头面人物: '可汗·阿史那' } };

const 基础 = {
  world,
  reply: '【最新回复】\n他推开门, 街上湿漉漉的。',
  replyCount: 1,
  context: '我去街上走走',
  timeJump: null,
  时间约束: '正文未给出新日期, 沿用上次世界时间',
  // 这张卡的世界时间是"元和三年·三月初七"——解析不出来, 所以跨日事实 = 无法判定(v2.8 K 档降级)
  跨日: null,
  worldbook: '【世界书】北狄信奉狼神; 中原设盐铁使掌盐引。',
  playerName: '沈砚',
  playerDesc: '一个书生',
  破限: false,
  头部填充: false,
  头部填充文本: '',
  防截断: false,
  预填充: false,
  节令历法: true,
  世界指标: true,
};
type 密度 = keyof typeof 运转密度表;

/** 取该密度下唯一那条 user(任务)消息: 内容里含【世界当前状态】 */
function user内容(密度: 密度, 跨日: any = null): string {
  const messages = buildTickMessages({ ...基础, 世界密度: 密度, 跨日 });
  const target = messages.filter(message => message.role === 'user' && message.content.includes('【世界当前状态】'));
  check(`密度 ${密度}: 恰好一条任务 user 消息`, target.length, 1);
  return target[0].content;
}
function 逐行差异(a: string, b: string): number[] {
  const la = a.split('\n');
  const lb = b.split('\n');
  const out: number[] = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) out.push(i);
  }
  return out;
}

console.log('\n[1] 三档只差【运转密度】一行: 其余逐行逐字相同');
{
  const 行 = { 稀疏: user内容('稀疏'), 正常: user内容('正常'), 密集: user内容('密集') };
  const 正常行 = 行.正常.split('\n');
  for (const 密度 of ['稀疏', '密集'] as const) {
    const 差异 = 逐行差异(行.正常, 行[密度]);
    check(`${密度} vs 正常: 只有一行不同`, 差异.length, 1);
    const 该行 = 正常行[差异[0]] ?? '';
    ok(`${密度} vs 正常: 差异行是【运转密度】行`, 该行.startsWith('【运转密度】'));
    // 行数也必须一致(不能多出/少掉空行以外的东西)
    check(`${密度} vs 正常: 行数一致`, 行[密度].split('\n').length, 正常行.length);
  }
  ok('正常档行含 2 件 / ≤10 条, 且未跨日那轮不提大跳', 行.正常.includes('每轮新增上限 2 件; 进行中(酝酿/进行/尾声)总数 ≤10 条') && !行.正常.includes('大跳'));
  ok('稀疏档行含 1 件 / ≤8 条, 且未跨日那轮不提大跳', 行.稀疏.includes('每轮新增上限 1 件; 进行中(酝酿/进行/尾声)总数 ≤8 条') && !行.稀疏.includes('大跳'));
  ok('密集档行含 3 件 / ≤14 条, 且未跨日那轮不提大跳', 行.密集.includes('每轮新增上限 3 件; 进行中(酝酿/进行/尾声)总数 ≤14 条') && !行.密集.includes('大跳'));
  ok('古代卡(无法判定)整条降级: 事实行如实说, 不按世界日计时', 行.正常.includes('无法判定(上次世界时间的日期解析不出来, 本插件不按世界日计时)'));
  // 跨日那轮才给大跳额度(v2.8 J): 数字仍全部来自 运转密度表
  ok('跨日那轮: 正常档给 2 件(大跳 4 件)', user内容('正常', { 最少: 3, 最多: 3 }).includes('每轮新增上限 2 件(时间大跳跃放宽到 4 件); 进行中(酝酿/进行/尾声)总数 ≤10 条'));
  ok('跨日那轮: 稀疏档给 2 件(大跳 2 件)', user内容('稀疏', { 最少: 1, 最多: 1 }).includes('每轮新增上限 1 件(时间大跳跃放宽到 2 件)'));
  ok('跨日那轮: 密集档给 6 件(大跳 6 件)', user内容('密集', { 最少: 1, 最多: 1 }).includes('每轮新增上限 3 件(时间大跳跃放宽到 6 件)'));
  ok('正常档倾向句', 行.正常.includes('每轮先主动找可推进之处, 找到够格的才新增, 找不到才原样带回。'));
  ok('稀疏档允许连续多轮零新增', 行.稀疏.includes('允许连续多轮零新增'));
  ok('密集档仍受合格线与标尺约束', 行.密集.includes('但仍受事件合格线与世界观标尺约束——不许为凑数把不够格的事入账。'));
  ok('世界当前状态快照在三档里都原样在场', (['稀疏', '正常', '密集'] as const).every(d => 行[d].includes('"世界":{"时间":"元和三年·三月初七"')));
}

console.log('\n[2] 配额数字只在 运转密度表 里; 提示词其余位置写"见【运转密度】"; 量化授权句已删净');
{
  check('表: 稀疏', [运转密度表.稀疏.每轮新增, 运转密度表.稀疏.大跳新增, 运转密度表.稀疏.进行中上限], [1, 2, 8]);
  check('表: 正常', [运转密度表.正常.每轮新增, 运转密度表.正常.大跳新增, 运转密度表.正常.进行中上限], [2, 4, 10]);
  check('表: 密集', [运转密度表.密集.每轮新增, 运转密度表.密集.大跳新增, 运转密度表.密集.进行中上限], [3, 6, 14]);

  const 正常任务 = user内容('正常');
  check('SYSTEM_PROMPT 里 3 处"见【运转密度】"(事件清单②④ + Step 3)', 出现次数(SYSTEM_PROMPT, '见【运转密度】'), 3);
  check('任务指令里 1 处"见【运转密度】"', 出现次数(正常任务.slice(正常任务.indexOf('请推进世界:')), '见【运转密度】'), 1);

  ok('无「不超过 2 件」', !提示词源码.includes('不超过 2 件'));
  ok('无「放宽到 4 件」', !提示词源码.includes('放宽到 4 件'));
  ok('无「总数 ≤10」', !提示词源码.includes('总数 ≤10'));
  ok('无「占所有回合的一半以上是正常的」', !提示词源码.includes('占所有回合的一半以上是正常的'));
  ok('无「一件新事件也不许新增」', !提示词源码.includes('一件新事件也不许新增'));
  ok('旧的量化静止授权句「纯带旧账的回合是合法且常见的」已删', !提示词源码.includes('纯带旧账的回合是合法且常见的'));
  ok('新口径「静止是结论, 不是默认」在位(Step 3 + 任务指令 3)', 出现次数(提示词源码, '静止是结论, 不是默认') === 2);
  ok('最高原则改为「静止合法, 但不是默认」', 提示词源码.includes('**静止合法, 但不是默认**'));
  ok('没有硬配额措辞「连续」轮强制产出', !提示词源码.includes('连续 N 轮'));
}

console.log('\n[3] 世界书是素材源: 段落 + 防退化纪律句在位');
{
  ok('最高原则素材源已含世界书', SYSTEM_PROMPT.includes('每回合的素材优先从下面五层常驻档案与【世界书/设定】里长出来'));
  ok('新增小节标题', SYSTEM_PROMPT.includes('【世界书是素材源, 不只是世界观判据】'));
  ok('① 结构性矛盾', SYSTEM_PROMPT.includes('**结构性矛盾**') && SYSTEM_PROMPT.includes('尚未入账的') && SYSTEM_PROMPT.includes('补进 大势 或 伏笔'));
  ok('② 尚未入账的实体', SYSTEM_PROMPT.includes('**尚未入账的实体**') && SYSTEM_PROMPT.includes('按各层容量上限补进去'));
  ok('纪律句: 动态推演而非设定本身', SYSTEM_PROMPT.includes('**动态推演**') && SYSTEM_PROMPT.includes('不是设定本身'));
  ok('纪律句: 禁止复述世界书原文', SYSTEM_PROMPT.includes('禁止复述世界书原文'));
  ok('纪律句: 禁止把静态设定直接当事件入账', SYSTEM_PROMPT.includes('禁止把静态设定直接当事件入账'));
  ok('纪律句带正例(火神)', SYSTEM_PROMPT.includes('"火神教廷与王室因神谕解释权分裂"才是'));
  ok('已入账线头不重复补', SYSTEM_PROMPT.includes('已入账的线头按增量维护规则原样带回, 不要重复补'));
  ok('原有【世界观: 不预设, 从世界书推断】整节未被改动', SYSTEM_PROMPT.includes('先读【世界书/设定】与最近正文, 判断这是什么世界') && SYSTEM_PROMPT.includes('世界书是最高权威。'));
  ok('【事件合格线】三问逐字未动', SYSTEM_PROMPT.includes('【事件合格线】三问全过才算事件:') && SYSTEM_PROMPT.includes('3. 对格局或某方处境有可累积的后果吗?'));
  ok('【世界观标尺】规模门槛逐字未动', SYSTEM_PROMPT.includes('规模看"影响半径"——影响半径不足一城/一域/一方的, 无论当事人级别多高都不算要事。'));
}

console.log('\n[4] 旧设置兜底: 没有 世界密度 → 「正常」, 且不丢其他设置');
{
  check('空设置 → 正常', SettingsSchema.parse({}).运转.世界密度, '正常');
  const 旧设置 = SettingsSchema.parse({ 运转: { 更新频率: 5, 破限: true, 节令历法: false }, 启用运转: false });
  check('旧设置缺键 → 正常', 旧设置.运转.世界密度, '正常');
  check('旧设置其余字段不丢', [旧设置.运转.更新频率, 旧设置.运转.破限, 旧设置.运转.节令历法, 旧设置.启用运转], [5, true, false, false]);
  check('三档都能解析', (['稀疏', '正常', '密集'] as const).map(d => SettingsSchema.parse({ 运转: { 世界密度: d } }).运转.世界密度), ['稀疏', '正常', '密集']);
  let 拒绝 = false;
  try {
    SettingsSchema.parse({ 运转: { 世界密度: '超密' } });
  }
  catch {
    拒绝 = true;
  }
  ok('非法档位被拒', 拒绝);
}

console.log('\n[5] 面板: 三档下拉绑定 settings.运转.世界密度, 挂在更新频率下面');
{
  ok('下拉已绑定', 界面源码.includes('v-model="settings.运转.世界密度"'));
  ok('三个档位选项都在', (['稀疏', '正常', '密集'] as const).every(d => 界面源码.includes(`<option value="${d}">`)));
  ok('说明文案在位', 界面源码.includes('稀疏=允许长时间没有新事件；正常=每轮主动找，找不到才静止；密集=每轮尽量都有产出。只调配额，不改事件合格线。'));
  ok('位置在「更新频率」之后', 界面源码.indexOf('运转密度') > 界面源码.indexOf('更新频率'));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
