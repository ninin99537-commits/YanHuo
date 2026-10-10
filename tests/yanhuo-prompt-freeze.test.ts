// 烟火 v2.7 · 态势字段要写出"动" + 势力推进路径(冻结红线)
//
// 症状(真机 v2.5, 密度=密集): `世界推进完成: 无事 (进行中 0 件 / 已了结 2 件, 新增 0 件)`。
// 根因链的承重一环不是"势力缺推进问句"(大势早就有推进指令, 照样被写成流程复述), 而是
// **【字段不重复】把 局势/进展/动向 亲口定成了状态字段**——模型于是每轮重写一遍"现在怎样",
// 读起来像在推进, 实际什么都没变。没人在受损, 合格线第 3 问就永远没有答案。
//
// 本轮三处改动(全部在 prompts.ts, 见 [0])+ 三条红线:
//   R1 · 注入冻结: `buildInjectionPrompt` 的输出与 v2.5 **逐字节相同**(白名单为空)。
//        注意口径: 势力的 动向/对外关系 本来就在注入列里, 所以"势力推进之后注入内容会变"是
//        **预期的**——R1 冻的是 **formatter + 固定数据**, 不是"注入内容永不改变"(见 [1] 第 3/4 条)。
//   R2 · 请求体冻结: 与 tests/fixtures/yanhuo-tick-v2.5.txt 逐行差分, 差异行集合**恰好等于**声明的
//        白名单(3 删 6 增); 同时冻结新版全量文本为第二个 fixture, 此后恢复纯逐字。
//   R3 · 六条不变量: 别为了写新句子踩到既有断言(配额单点 / 静止口径 / 硬配额 / 墓碑 / 合格线与标尺 / JSON 契约)。
//
// fixture 怎么来(只提交 fixture, 探针不提交):
//   tests/fixtures/yanhuo-freeze-world.json  —— 固定输入(真机那张卡的形状: 2 个机构势力、关联事件全是「—」)
//   tests/fixtures/yanhuo-tick-v2.5.txt      —— 改动**前**跑 buildTickMessages 的全量文本(基线)
//   tests/fixtures/yanhuo-tick-v2.7.txt      —— 改动后同一份输入的全量文本(第二个 fixture)
//   tests/fixtures/yanhuo-inject-v2.5.txt    —— 改动**前**跑 buildInjectionPrompt 的注入文本
// 序列化口径与 update.ts 记日志时一致(面板「日志」页看到的那份请求文本), 见 [2] 最后一条。
import { createPinia, setActivePinia } from 'pinia';
import { buildInjectionPrompt, buildTickMessages, SYSTEM_PROMPT, 运转密度表 } from '../src/烟火_世界运转/prompts';
import 提示词源码 from '../src/烟火_世界运转/prompts.ts?raw';
import update源码 from '../src/烟火_世界运转/update.ts?raw';
import { SettingsSchema, type WorldData } from '../src/烟火_世界运转/schema';
import 卡形JSON from './fixtures/yanhuo-freeze-world.json?raw';
import V25请求 from './fixtures/yanhuo-tick-v2.5.txt?raw';
import V27请求 from './fixtures/yanhuo-tick-v2.7.txt?raw';
import V25注入 from './fixtures/yanhuo-inject-v2.5.txt?raw';

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

/** 行级 LCS 差分(与密度用例里那份按行号对齐的写法不同: 这里有整行新增, 按行号对齐会把后面全判成差异) */
function 行差分(旧: string[], 新: string[]): { 删除: string[]; 新增: string[] } {
  const n = 旧.length; const m = 新.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = 旧[i] === 新[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const 删除: string[] = []; const 新增: string[] = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (旧[i] === 新[j]) { i++; j++; continue; }
    if (dp[i + 1][j] >= dp[i][j + 1]) 删除.push(旧[i++]);
    else 新增.push(新[j++]);
  }
  while (i < n) 删除.push(旧[i++]);
  while (j < m) 新增.push(新[j++]);
  return { 删除, 新增 };
}
function 同集合(label: string, 实际: string[], 声明: string[]) {
  const 排序 = (arr: string[]) => [...arr].sort();
  check(label, 排序(实际), 排序(声明));
}

// ---------------------------------------------------------------------------
// 固定输入: 真机那张卡的形状。世界数据、回话、设置全部来自同一份 fixture,
// 探针与用例读的是它, 所以基线不会因为两边各写一份输入而漂移。
// ---------------------------------------------------------------------------
const 卡 = JSON.parse(卡形JSON);
const world = 卡.世界数据 as WorldData;
const 设置 = SettingsSchema.parse(卡.设置);
function 跑请求(): string {
  const messages = buildTickMessages({ world, ...卡.输入 });
  return messages
    .map((message: any) => `【${message.role === 'system' ? '系统指令' : message.role === 'user' ? '用户' : '助手'}】\n${message.content}`)
    .join('\n\n────────\n\n');
}
const 请求体 = 跑请求();

console.log('\n[0] 三处改动到位(改动本身没被写丢/写歪)');
{
  ok('改动1: 新段落【态势字段要写出"动"】在位', 提示词源码.includes('【态势字段要写出"动"】'));
  ok('改动1: 反例是从真机数据里抄的原话(有序进行/运行良好/保障到位/客流充足)',
    ['有序进行', '运行良好', '保障到位', '客流充足'].every(词 => 提示词源码.includes(`"${词}"`)));
  ok('改动1: 旧的"只写现在怎样"这句已删净(它是根因)',
    !提示词源码.includes('局势/进展/动向只写"现在怎样"') && !提示词源码.includes('不重复局势/进展/动向已说清的当前状态'));
  ok('改动2: 势力推进问句紧贴字段行(与地域/大势同位置同句式)',
    提示词源码.includes('  字段: 目标 / 动向 / 前情 / 势力范围 / 对外关系 / 头面人物\n  推进时问:'));
  ok('改动2: 摩擦的落点是 动向/对外关系 或 大势/伏笔, 事件是例外', 提示词源码.includes('摩擦先落在 动向 / 对外关系, 或补成一条 大势 / 伏笔 的线头'));
  ok('改动2: 不许为制造摩擦新增势力(L31② 的授权原样保留)',
    提示词源码.includes('**只在已在清单里的势力之间找, 不许为了制造摩擦新增势力**') && 提示词源码.includes('按各层容量上限补进去, 之后从它们身上长事件'));
  check('改动3: 两处来源枚举都补了势力清单', 出现次数(提示词源码, '从五层、势力清单与世界书的推进里'), 2);
  check('fixture 真的带着真机那句废话(否则改动1的反例是空喊)', ['街区巡查有序进行', '正开展日常巡检测试', '客流充足，各大商圈服务保障机制落实到位'].filter(句 => 请求体.includes(句)).length, 3);
}

console.log('\n[1] R1 · 注入给主 AI 的内容与 v2.5 逐字节相同(白名单为空)');
{
  check('注入文本与改动前逐字一致', buildInjectionPrompt(world, 设置), V25注入);
  check('墓碑桶对注入毫无影响', buildInjectionPrompt({ ...world, 已了结: [] }, 设置), V25注入);
  ok('两个机构的行都在注入里', V25注入.includes('市政综合管理署 | ') && V25注入.includes('都市商业联合会 | '));
  ok('势力注入列没有变化(「关联事件」是面板派生的, 不进注入)',
    V25注入.includes('势力 | 头面人物 | 势力范围 | 目标 | 动向 | 对外关系 | 前情') && !V25注入.includes('关联事件'));

  // R1 冻的是 formatter: 数据一动, 注入内容就该跟着动——这是预期的, 不是红线被破坏。
  const 推进后 = JSON.parse(JSON.stringify(world)) as WorldData;
  推进后.势力['市政综合管理署'].动向 = '对夜间占道经营收紧许可口径, 已要求三个区本周内交名单';
  const 注入2 = buildInjectionPrompt(推进后, 设置);
  ok('势力一推进, 注入内容随之变化', 注入2 !== V25注入 && 注入2.includes('收紧许可口径'));
  const 注入差分 = 行差分(V25注入.split('\n'), 注入2.split('\n'));
  check('且只有那一行不同(格式化层没跟着动)', [注入差分.删除.length, 注入差分.新增.length], [1, 1]);
  check('变的是势力那一行', 注入差分.新增[0]?.startsWith('市政综合管理署 | '), true);
}

console.log('\n[2] R2 · 请求体冻结: 差异行恰好等于声明的白名单(3 删 6 增)');
{
  // 白名单逐字声明"允许不一样的每一行"。删=改动前的旧句子, 增=改动后的新句子。
  const 白名单 = {
    删除: [
      '【字段不重复】概况只写"它是什么"的静态身份(短, 不写历史、不写当前动态); 局势/进展/动向只写"现在怎样"; 前情只写"怎么走到今天"的演变因果, 不复述概况、不重复局势/进展/动向已说清的当前状态。',
      'Step 3 生事件: 从五层与世界书的推进里挑出够格(过事件合格线且达到世界观标尺)的长成本轮事件; 也可从正文大事的世界级后续(可选)与合理的新动向里出。宁少而真, 不编凑数。**静止是结论, 不是默认**: 先主动找可推进之处(五层里哪一层的状态已经与上一轮不同? 世界书里哪条结构性矛盾正在发酵?), 确实找不到实质推进, 才把事件清单原样带回。新增上限见【运转密度】。',
      '3. 从五层与世界书的推进里长出够格的公共事件(过事件合格线且达到世界观标尺); 维护事件清单与势力清单(增量维护, 无变化原样带回)。**静止是结论, 不是默认**: 先主动找可推进之处, 确实找不到才原样带回。新增上限见【运转密度】。',
    ],
    新增: [
      '【字段不重复】概况只写"它是什么"的静态身份(短, 不写历史、不写当前动态); 前情只写"怎么走到今天"的演变因果, 不复述概况、不重复当前态势。',
      '【态势字段要写出"动"】局势 / 进展 / 动向 / 对外关系 写的是**此刻的态势**, 不是此刻的景色: 必须让读者看出**与上一轮相比什么不一样了**——多了什么压力、少了什么余地、谁的态度变了、哪一步比上一步更难走。照实写"仍在僵持""这轮没有推进"是可以的, 那是**判断**; 但复述现状("有序进行""运行良好""保障到位""客流充足")等于什么都没说, 这一轮就是白过。确实一动没动时, 整条原样带回。',
      '  推进时问: 这个势力的**目标**这一轮往哪儿挪了一格? 谁挡了它、它让谁难受了? 写进"动向"; 因此警觉或受损的一方, 写进另一方的"对外关系"。两个势力的目标若正在互相挤压(一个要放、一个要管), 那条挤压线就是最该动的地方。**只在已在清单里的势力之间找, 不许为了制造摩擦新增势力**; 目标不相抵就是不相抵, 整条原样带回。',
      '  摩擦先落在 动向 / 对外关系, 或补成一条 大势 / 伏笔 的线头——**只有走到能过【事件合格线】与【世界观标尺】的公共层动作才长成事件**; 部门级的联合督查、专项整治、例行检查不是事件。',
      'Step 3 生事件: 从五层、势力清单与世界书的推进里挑出够格(过事件合格线且达到世界观标尺)的长成本轮事件; 也可从正文大事的世界级后续(可选)与合理的新动向里出。宁少而真, 不编凑数。**静止是结论, 不是默认**: 先主动找可推进之处(五层里哪一层的状态已经与上一轮不同? 世界书里哪条结构性矛盾正在发酵?), 确实找不到实质推进, 才把事件清单原样带回。新增上限见【运转密度】。',
      '3. 从五层、势力清单与世界书的推进里长出够格的公共事件(过事件合格线且达到世界观标尺); 维护事件清单与势力清单(增量维护, 无变化原样带回)。**静止是结论, 不是默认**: 先主动找可推进之处, 确实找不到才原样带回。新增上限见【运转密度】。',
    ],
  };
  const 差分 = 行差分(V25请求.split('\n'), 请求体.split('\n'));
  同集合('删除行集合恰好等于白名单(不多不少)', 差分.删除, 白名单.删除);
  同集合('新增行集合恰好等于白名单(不多不少)', 差分.新增, 白名单.新增);
  check('白名单规模: 3 删 6 增(整行新增, 行数 +3)', [白名单.删除.length, 白名单.新增.length, 请求体.split('\n').length - V25请求.split('\n').length], [3, 6, 3]);
  check('新版全量文本与第二个 fixture 逐字节相同(此后恢复纯逐字)', 请求体, V27请求);
  ok('世界状态 JSON 那一行不在白名单里(数据面一个字没动)',
    ![...白名单.删除, ...白名单.新增].some(行 => 行.startsWith('{"世界":')));
  ok('探针的序列化与 update.ts 记日志的口径一致(否则冻结的不是面板看到的那份文本)',
    update源码.includes("'系统指令' : message.role === 'user' ? '用户' : '助手'"));
}

console.log('\n[3] R3 · 六条不变量(写给"下一个人"的护栏)');
{
  check('配额单点: SYSTEM_PROMPT 里 3 处"见【运转密度】"', 出现次数(SYSTEM_PROMPT, '见【运转密度】'), 3);
  check('静止口径: "静止是结论, 不是默认"仍是 2 处', 出现次数(提示词源码, '静止是结论, 不是默认'), 2);
  ok('没有硬配额/强制节奏("连续 N 轮"一次都不出现)', !提示词源码.includes('连续 N 轮'));
  ok('没有顺手解释墓碑(请求体与 SYSTEM_PROMPT 里都没有 `已了结` 这个键)',
    !请求体.includes('已了结') && !SYSTEM_PROMPT.includes('已了结'));
  ok('合格线三问与标尺规模门槛逐字在位',
    SYSTEM_PROMPT.includes('【事件合格线】三问全过才算事件:') && SYSTEM_PROMPT.includes('3. 对格局或某方处境有可累积的后果吗?') && SYSTEM_PROMPT.includes('规模看"影响半径"——影响半径不足一城/一域/一方的, 无论当事人级别多高都不算要事。'));
  ok('JSON 输出契约模板逐字照旧(势力段原样, 没多字段)',
    SYSTEM_PROMPT.includes('"势力":{"势力名":{"目标":"...","动向":"...","前情":"...","势力范围":"...","对外关系":"...","头面人物":"..."}}'));
  check('三档配额数字仍是单点来源(本轮没动密度表)', [运转密度表.稀疏.每轮新增, 运转密度表.正常.每轮新增, 运转密度表.密集.每轮新增], [1, 2, 3]);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
