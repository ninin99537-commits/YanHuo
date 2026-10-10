// 烟火 · 世界数据规矩(世界数据.ts) —— 纯函数用例: 直接喂"旧世界 + AI 载荷", 不需要酒馆、不需要假平台
//
// 这条候选的起因: 这些规矩以前长在 update.ts 的 validateAndNormalize 里, 只有 AI 自动推进那条路
// 享有它们; 而且整份实现不可单测——想验证"改名认不认得出"得先搭一台假平台。抽成纯模块后,
// 每条规矩都能这样直接钉住。这里覆盖: 认领(改名/漏带 id)、复读去重、id 签发、占位词、演变流水、
// 换血捞回、各层上限、五层档案的沿用与迁移、节令排序与过期、结构性错误。
//
// ⚠️ [20] 是**记录型**用例(v2.8 §1): 本版决定"规模标定只走提示词, 码里不加门", 所以它记录的是
//    一个**洞**——管线照收巡检级"要事"。若未来有人加规模门, 此断言必须翻红并人工重审, 不许静默改绿。
import { emptyData, ENDED_EVENT_LIMIT, EVENT_HISTORY_LIMIT, EVENT_LIMIT, FACTION_LIMIT, METRIC_LIMIT, OCCASION_LIMIT, REGION_LIMIT, SEED_LIMIT } from '../src/烟火_世界运转/state';
import type { WorldData, WorldEvent } from '../src/烟火_世界运转/schema';
import { 事件账目, normalizeLayer, validateAndNormalize } from '../src/烟火_世界运转/世界数据';
import 世界数据源码 from '../src/烟火_世界运转/世界数据.ts?raw';

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

/** 一条旧事件: 只填用例关心的字段, 其余给最小合法值 */
function 事件(部分: Partial<WorldEvent> & { 标题: string }): WorldEvent {
  return {
    id: '',
    描述: '描述',
    地点: '',
    时间: '2025-01-01 08:00',
    规模: '要事',
    传播: '本埠',
    渠道: '',
    势力: '',
    阶段: '进行',
    隐秘: '公开',
    代表人物: '',
    前情: '',
    演变: [],
    ...部分,
  } as WorldEvent;
}

/** 一份旧世界: 以真正的空数据为底, 免得手写对象缺字段 */
function 旧世界(部分: Partial<WorldData> = {}): WorldData {
  return { ...emptyData(), ...部分 };
}

/** AI 载荷: 校验只硬性要求「世界.时间」与「事件」是数组 */
function 载荷(部分: Record<string, any> = {}) {
  return { 世界: { 时间: '2025-01-02 10:00' }, 事件: [], 势力: {}, ...部分 };
}

console.log('\n[1] 改名靠 id 认领: 标题变了也是同一条, 演变接着记');
{
  const 旧 = 旧世界({
    事件: [事件({ id: 'e1', 标题: '旧名字', 前情: '老前情', 演变: [{ 时间: '2025-01-01 08:00', 变化: '起点' }] })],
  });
  const 新 = validateAndNormalize(载荷({ 事件: [{ id: 'e1', 标题: '新名字', 变化: '又走一步' }] }), 旧);

  check('还是一条', 新.事件.length, 1);
  check('标题换了', 新.事件[0].标题, '新名字');
  check('id 沿用旧的那一条', 新.事件[0].id, 'e1');
  check('演变接着往下记', 新.事件[0].演变.length, 2);
  check('最后一步是这次的变化', 新.事件[0].演变[1].变化, '又走一步');
  check('前情沿用旧值(AI 没带)', 新.事件[0].前情, '老前情');
}

console.log('\n[2] AI 漏带 id 时靠标题兜底认回');
{
  const 旧 = 旧世界({ 事件: [事件({ id: 'e1', 标题: '集市散场', 演变: [{ 时间: '2025-01-01 08:00', 变化: '起点' }] })] });
  const 新 = validateAndNormalize(载荷({ 事件: [{ 标题: '集市散场', 变化: '收摊' }] }), 旧);

  check('靠标题认回旧的那条', 新.事件[0].id, 'e1');
  check('演变接上了', 新.事件[0].演变.length, 2);
}

console.log('\n[3] 复读同一条: 只留第一份');
{
  const 新 = validateAndNormalize(
    载荷({ 事件: [{ id: 'x', 标题: '甲', 变化: '第一次' }, { id: 'x', 标题: '甲', 变化: '第二次' }] }),
    旧世界(),
  );

  check('只留一条', 新.事件.length, 1);
  check('留的是第一份', 新.事件[0].演变[0].变化, '第一次');
}

console.log('\n[4] 新事件不许直接"已结束"; 有历史的允许了结(了结的搬进墓碑桶)');
{
  const 无历史 = validateAndNormalize(载荷({ 事件: [{ 标题: '凭空结束', 阶段: '已结束' }] }), 旧世界());
  check('凭空"已结束"被丢弃', 无历史.事件.length, 0);
  check('也没进墓碑桶(没有过程的事不许凭空了结)', 无历史.已了结.length, 0);

  const 旧 = 旧世界({ 事件: [事件({ id: 'e1', 标题: '老事' })] });
  const 有历史 = validateAndNormalize(载荷({ 事件: [{ id: 'e1', 标题: '老事', 阶段: '已结束' }] }), 旧);
  check('认领回来的一条可以了结', 有历史.已了结.length, 1);
  check('阶段是已结束', 有历史.已了结[0].阶段, '已结束');
  check('不变量: 活跃桶里没有它', 有历史.事件.length, 0);
}

console.log('\n[5] id 由脚本独占签发: AI 编的编号不入档');
{
  const 新 = validateAndNormalize(载荷({ 事件: [{ 标题: '新事', id: 'AI编的编号' }] }), 旧世界());

  ok('id 不是 AI 编的那个', 新.事件[0].id !== 'AI编的编号');
  ok('是脚本签发的形状', /^e[a-z0-9]+$/.test(新.事件[0].id));
}

console.log('\n[6] 占位词: 不追加演变, 也不覆盖前情');
{
  const 旧 = 旧世界({
    事件: [事件({ id: 'e1', 标题: '甲', 前情: '好前情', 演变: [{ 时间: '2025-01-01 08:00', 变化: '起点' }] })],
  });
  const 新 = validateAndNormalize(载荷({ 事件: [{ id: 'e1', 标题: '甲', 变化: '无变化', 前情: '同上' }] }), 旧);

  check('占位词没进演变', 新.事件[0].演变.length, 1);
  check('前情没被"同上"覆盖', 新.事件[0].前情, '好前情');
}

console.log(`\n[7] 演变流水只留最近 ${EVENT_HISTORY_LIMIT} 步`);
{
  const 旧演变 = Array.from({ length: EVENT_HISTORY_LIMIT }, (_, i) => ({ 时间: `2025-01-0${i + 1} 08:00`, 变化: `第${i + 1}步` }));
  const 旧 = 旧世界({ 事件: [事件({ id: 'e1', 标题: '甲', 演变: 旧演变 })] });
  const 新 = validateAndNormalize(载荷({ 事件: [{ id: 'e1', 标题: '甲', 变化: '新的一步' }] }), 旧);

  check('还是那么多步', 新.事件[0].演变.length, EVENT_HISTORY_LIMIT);
  check('最后一步是新的', 新.事件[0].演变[EVENT_HISTORY_LIMIT - 1].变化, '新的一步');
  check('最早那步被挤掉', 新.事件[0].演变[0].变化, '第2步');
}

console.log('\n[8] 换血守卫: 未结束的旧事件没被带回就自动捞回(捞回与比例无关, 比例只决定告警)');
{
  const 旧 = 旧世界({ 事件: [事件({ id: 'e1', 标题: '甲' }), 事件({ id: 'e2', 标题: '乙' })] });
  const 全丢 = validateAndNormalize(载荷({ 事件: [] }), 旧);
  check('两条都被捞回', 全丢.事件.map(e => e.标题), ['甲', '乙']);

  const 旧4 = 旧世界({ 事件: ['甲', '乙', '丙', '丁'].map((标题, i) => 事件({ id: `e${i + 1}`, 标题 })) });
  const 少丢 = validateAndNormalize(载荷({ 事件: [1, 2, 3].map(i => ({ id: `e${i}`, 标题: ['甲', '乙', '丙'][i - 1] })) }), 旧4);
  check('只丢一条也捞回(补在末尾)', 少丢.事件.map(e => e.标题), ['甲', '乙', '丙', '丁']);

  const 旧墓碑 = 旧世界({ 已了结: [事件({ id: 'e1', 标题: '了结的事', 阶段: '已结束' })] });
  const 保住 = validateAndNormalize(载荷({ 事件: [] }), 旧墓碑);
  check('墓碑不会被捞回活跃桶(AI 无权让它复活)', 保住.事件.length, 0);
  check('墓碑桶照旧保留(那是存储, 不归 AI 管)', 保住.已了结.map(e => e.标题), ['了结的事']);
}

console.log('\n[9] 事件清单总数上限');
{
  const 很多 = Array.from({ length: EVENT_LIMIT + 5 }, (_, i) => ({ 标题: `事件${i + 1}`, 阶段: '进行' }));
  const 新 = validateAndNormalize(载荷({ 事件: 很多 }), 旧世界());

  check('裁到上限', 新.事件.length, EVENT_LIMIT);
  check('留下的是最新的', 新.事件[EVENT_LIMIT - 1].标题, `事件${EVENT_LIMIT + 5}`);
}

console.log('\n[10] 墓碑桶只留最近几条(活跃桶不参与这把尺)');
{
  const 旧墓碑 = Array.from({ length: ENDED_EVENT_LIMIT + 1 }, (_, i) => 事件({ id: `t${i + 1}`, 标题: `旧事${i + 1}`, 阶段: '已结束' }));
  const 旧 = 旧世界({ 事件: [事件({ id: 'e9', 标题: '刚了结' })], 已了结: 旧墓碑 });
  const 新 = validateAndNormalize(载荷({ 事件: [{ id: 'e9', 标题: '刚了结', 阶段: '已结束' }] }), 旧);

  check('裁到上限', 新.已了结.length, ENDED_EVENT_LIMIT);
  check('留的是最近的', 新.已了结[ENDED_EVENT_LIMIT - 1].标题, '刚了结');
  check('最旧的被挤掉', 新.已了结[0].标题, '旧事3');
}

console.log('\n[11] 势力: 过滤非势力名 / 沿用旧字段 / 上限 / 被整体清空时捞回');
{
  const 过滤 = validateAndNormalize(载荷({ 势力: { 姐妹俩: { 动向: 'x' }, 商会: { 动向: 'y' } } }), 旧世界());
  check('人物组合不是势力', Object.keys(过滤.势力), ['商会']);

  const 旧 = 旧世界({ 势力: { 商会: { 目标: '赚钱', 动向: '守成', 前情: '', 势力范围: '东街', 对外关系: '', 头面人物: '' } } });
  const 沿用 = validateAndNormalize(载荷({ 势力: { 商会: { 动向: '扩张' } } }), 旧);
  check('新动向写进去了', 沿用.势力.商会.动向, '扩张');
  check('没带的字段沿用旧值', 沿用.势力.商会.目标, '赚钱');

  const 多 = Object.fromEntries(Array.from({ length: FACTION_LIMIT + 3 }, (_, i) => [`势力${i + 1}`, { 动向: 'x' }]));
  check('裁到上限', Object.keys(validateAndNormalize(载荷({ 势力: 多 }), 旧世界()).势力).length, FACTION_LIMIT);

  const 清空 = validateAndNormalize(载荷({ 势力: {} }), 旧);
  check('被整体清空时捞回既有势力', Object.keys(清空.势力), ['商会']);
}

console.log('\n[12] 地域(通用层): 沿用旧字段 + 上限');
{
  const 旧 = 旧世界({ 地域: { 东街: { 概况: '旧概况', 局势: '', 当权者: '', 对外关系: '', 前情: '' } } });
  const 新 = validateAndNormalize(载荷({ 地域: { 东街: { 局势: '新局势' } } }), 旧);
  check('新局势写进去了', 新.地域.东街.局势, '新局势');
  check('概况沿用旧值', 新.地域.东街.概况, '旧概况');

  const 多 = Object.fromEntries(Array.from({ length: REGION_LIMIT + 3 }, (_, i) => [`地方${i + 1}`, { 概况: 'x' }]));
  check('裁到上限', Object.keys(validateAndNormalize(载荷({ 地域: 多 }), 旧世界()).地域).length, REGION_LIMIT);
}

console.log('\n[13] 指标: 趋势枚举纠偏 + 上限');
{
  const 新 = validateAndNormalize(载荷({ 指标: { 物价: { 值: '高', 趋势: '乱写的趋势', 说明: 'x' } } }), 旧世界());
  check('非法趋势纠回平稳', 新.指标.物价.趋势, '平稳');

  const 多 = Object.fromEntries(Array.from({ length: METRIC_LIMIT + 2 }, (_, i) => [`指标${i + 1}`, { 值: '1' }]));
  check('裁到上限', Object.keys(validateAndNormalize(载荷({ 指标: 多 }), 旧世界()).指标).length, METRIC_LIMIT);
}

console.log('\n[14] 伏笔: 已爆发的不捞回 + 上限');
{
  const 伏笔 = (标题: string, 成熟度: string) => ({ 标题, 埋设: '', 指向: '', 成熟度, 前情: '' });
  const 旧 = 旧世界({ 伏笔: [伏笔('已爆', '已爆发'), 伏笔('活着', '酝酿')] as any });
  const 新 = validateAndNormalize(载荷({ 伏笔: [] }), 旧);
  check('已爆发的不捞回', 新.伏笔.map(s => s.标题), ['活着']);

  const 多 = Array.from({ length: SEED_LIMIT + 3 }, (_, i) => ({ 标题: `伏笔${i + 1}` }));
  check('裁到上限', validateAndNormalize(载荷({ 伏笔: 多 }), 旧世界()).伏笔.length, SEED_LIMIT);
}

console.log('\n[15] 节令: 过期丢弃 + 按时间排序 + 上限');
{
  const 新 = validateAndNormalize(
    载荷({
      节令: [
        { 名称: '过期节', 时间: '2025-01-01' },
        { 名称: '晚节', 时间: '2025-12-01' },
        { 名称: '早节', 时间: '2025-02-01' },
        { 名称: '没日期' },
      ],
    }),
    旧世界(),
  );
  check('过期的被丢掉', 新.节令.some(o => o.名称 === '过期节'), false);
  check('按时间从近到远排, 没日期的垫底', 新.节令.map(o => o.名称), ['早节', '晚节', '没日期']);

  const 多 = Array.from({ length: OCCASION_LIMIT + 3 }, (_, i) => ({ 名称: `节${i + 1}`, 时间: `2025-0${(i % 9) + 1}-15` }));
  check('裁到上限', validateAndNormalize(载荷({ 节令: 多 }), 旧世界()).节令.length, OCCASION_LIMIT);
}

console.log('\n[16] 世界字段兜底 + 旧字段「大势」迁移成总览');
{
  const 旧 = 旧世界({ 世界: { 时间: '2025-01-01 08:00', 氛围: '旧氛围', 总览: '旧总览' } });
  const 漏带 = validateAndNormalize(载荷({ 世界: { 时间: '2025-01-02 10:00' } }), 旧);
  check('氛围沿用旧值', 漏带.世界.氛围, '旧氛围');
  check('总览沿用旧值', 漏带.世界.总览, '旧总览');

  const 迁移 = validateAndNormalize(载荷({ 世界: { 时间: '2025-01-02 10:00', 大势: '老字段名' } }), 旧);
  check('旧字段被迁移成总览', 迁移.世界.总览, '老字段名');
}

console.log('\n[17] 结构性错误 → 抛错(交给往返去重试)');
{
  const 抛错 = (载荷值: any) => {
    try {
      validateAndNormalize(载荷值, 旧世界());
      return '';
    }
    catch (error) {
      return (error as Error).message;
    }
  };

  ok('顶层不是对象', 抛错('一段散文').includes('顶层不是对象'));
  ok('缺「世界」', 抛错({ 事件: [] }).includes('缺少「世界」'));
  ok('时间为空', 抛错({ 世界: { 时间: '' }, 事件: [] }).includes('「世界.时间」为空'));
  ok('事件不是数组', 抛错({ 世界: { 时间: 'x' }, 事件: {} }).includes('「事件」必须是数组'));
  ok('势力是数组', 抛错({ 世界: { 时间: 'x' }, 事件: [], 势力: [] }).includes('「势力」必须是对象'));
}

console.log('\n[18] 通用层单独用: 越界就停、坏条目跳过');
{
  const 十个 = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`名字${i + 1}`, { 概况: 'x' }]));
  check('超过上限就停', Object.keys(normalizeLayer(十个, {}, 3, ['概况'])).length, 3);
  check('非对象条目被跳过', Object.keys(normalizeLayer({ 好的: { 概况: 'a' }, 坏的: '字符串' }, {}, 5, ['概况'])), ['好的']);
}

console.log('\n[19] 账目按 id 认: 改名了但 id 没变, 不许报成"移除 + 新增"');
{
  const 旧 = [事件({ id: 'e1', 标题: '旧名字' }), 事件({ id: 'e2', 标题: '真要删的事' })];
  const 新 = [事件({ id: 'e1', 标题: '新名字' })];
  const 账 = 事件账目(旧, 新);

  check('改名不算新增', 账.added, []);
  check('只有真删的那条算移除', 账.removed, ['真要删的事']);
  check('阶段/描述没变也不该算推进', 账.updated, []);

  check('了结记成推进', 事件账目([事件({ id: 'e1', 标题: '甲' })], [事件({ id: 'e1', 标题: '甲', 阶段: '已结束' })]).updated, ['甲']);
  check('全新的一条算新增', 事件账目([], [事件({ id: 'e9', 标题: '新事' })]).added, ['新事']);

  const 老快照 = 事件({ 标题: '老快照里没有 id 的事' });
  check('没 id 的老事件退回按标题认(不算新增)', 事件账目([老快照], [{ ...老快照 }]).added, []);
}

console.log('\n[20] §1 规模标定: 管线里没有规模门(记录型 —— 这是记录了一个洞, 不是规模对了)');
{
  // 记录型：这是记录了一个洞，不是规模对了
  //
  // §1 的决定是"规模标定只走提示词, 码里不加门"(关键词门一绕就过: S1b 就是那个绕法)。
  // 所以下面这些断言冻结的是**今天的行为**, 用途不是"证明对", 而是**将来有人加规模门时翻红**,
  // 逼他回来人工重审这条产品决策。
  // 若未来有人加规模门，此断言必须翻红并人工重审，不许静默改绿。
  const 巡检 = validateAndNormalize(载荷({
    事件: [{
      标题: '联合保洁消杀巡检',
      规模: '要事',
      描述: '两部门联合对夜间场所开展保洁消杀与例行巡检',
      阶段: '进行',
      势力: '市政综合管理署',
    }],
  }), 旧世界());
  check('S1a(洞): 管线照收"联合保洁消杀巡检"', 巡检.事件.map(e => e.标题), ['联合保洁消杀巡检']);
  check('S1a(洞): 规模不被改写(码里没有第二把尺子)', 巡检.事件[0].规模, '要事');
  check('S1a(洞): 账目把它记为新增', 事件账目([], 巡检.事件).added, ['联合保洁消杀巡检']);

  const 换措辞 = validateAndNormalize(载荷({ 事件: [{ 标题: '市容秩序联合整治行动', 规模: '要事', 阶段: '进行' }] }), 旧世界());
  check('S1b(绕): 换个措辞照样进(所以码门只能做成关键词过滤 = 不做)', 换措辞.事件.map(e => e.标题), ['市容秩序联合整治行动']);

  const 正向 = validateAndNormalize(载荷({
    事件: [
      { 标题: '跨区票制并轨听证', 规模: '要事', 阶段: '酝酿' },
      { 标题: '全国性行业洗牌', 规模: '大事', 阶段: '进行' },
    ],
  }), 旧世界());
  check('S1c: 真·要事与真·大事照常入账, 规模不被改写',
    正向.事件.map(e => [e.标题, e.规模]), [['跨区票制并轨听证', '要事'], ['全国性行业洗牌', '大事']]);
}

console.log('\n[21] §4 阶段口径: 管线不自动翻阶段(恒真契约; "该翻时翻"是行为面, 在 B 栏)');
{
  const 旧 = 旧世界({ 事件: [事件({ id: 'e1', 标题: '甲', 阶段: '进行' })] });
  check('原样带回: 阶段不动', validateAndNormalize(载荷({ 事件: [{ id: 'e1', 标题: '甲', 阶段: '进行' }] }), 旧).事件[0].阶段, '进行');
  let 连跑 = 旧;
  for (let i = 0; i < 4; i++)
    连跑 = validateAndNormalize(载荷({ 事件: [{ id: 'e1', 标题: '甲', 阶段: '进行' }] }), 连跑);
  check('连续 4 轮原样带回 → 阶段一直是 进行(没有"按轮次往前推"这回事)', 连跑.事件[0].阶段, '进行');
  check('世界时间跨了一年也不自动翻阶段(时间跨度不是管线的理由)',
    validateAndNormalize(载荷({ 世界: { 时间: '2027-01-01 10:00' }, 事件: [{ id: 'e1', 标题: '甲', 阶段: '进行' }] }), 旧).事件[0].阶段, '进行');
  check('模型没提 阶段 → 落回声明值(进行), 管线不擅自补成 尾声/已结束',
    validateAndNormalize(载荷({ 事件: [{ id: 'e1', 标题: '甲' }] }), 旧).事件[0].阶段, '进行');
  check('只有模型说出口"已结束", 才真的了结',
    validateAndNormalize(载荷({ 事件: [{ id: 'e1', 标题: '甲', 阶段: '已结束' }] }), 旧).已了结.map(e => e.标题), ['甲']);

  const 出现次数 = (文本: string, 片段: string) => 文本.split(片段).length - 1;
  check('阶段 在管线里只有一处被决定(模型字段原样过一遍)', 出现次数(世界数据源码, '阶段: '), 1);
  ok('"已结束"只被用来判桶, 从不被代码写进事件(翻转只能由模型说出口)',
    出现次数(世界数据源码, "条目.阶段 === '已结束'") === 1 && !世界数据源码.includes("阶段: '已结束'") && !世界数据源码.includes("阶段 = '已结束'"));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0)
  process.exit(1);
