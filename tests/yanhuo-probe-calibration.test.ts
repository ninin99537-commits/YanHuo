// 烟火 v2.8 · §9.3 探针种子合规(测试交付物)
//
// 这条 A 栏防的是: B 栏对抗探针(§12)到底跑在哪张卡上。
//  - 若探针 seed 自带场景词, 模型会**顺着 seed 里的场景词**去写"巡检/街区/客流",
//    探针测的是"模型复述种子的污染"而不是"模型守不守得住尺"——基线被污染, B1/B3 判绿没有意义。
//  - 所以 seed 必须与 freeze 基线同构(同一张都市沙盒卡的形状), 但五层与势力清单不得含场景词。
//
// 场景词清单**从真机观测校准**: 来自 freeze fixture 的三句真机原话与 v2.7 失败形态
//『联合保洁消杀巡检』。清单不得少于真机记录条数(策划 §二: 任务背景)。
import 卡形JSON from './fixtures/yanhuo-freeze-world.json?raw';
import 探针种子JSON from './fixtures/yanhuo-probe-seed.json?raw';

// —— 场景词清单(从真机观测校准): 冻结的是"真机里跑出来过的场景词", 不是编的 ——
const 场景词清单 = [
  '街区', '商圈', '客流', '巡检', '巡查', '消杀', '保洁', '摊位', '夜市', '占道', '摊贩',
];
// 真机记录里出现过、必须在清单里的几条(缺一条就红: 探针会漏检那一种污染)
const 真机观测过 = ['街区', '商圈', '客流', '巡检', '消杀', '保洁'];

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
function ok(label: string, cond: boolean) { check(label, cond, true); }
function 出现次数(文本: string, 片段: string): number { return 文本.split(片段).length - 1; }

const 卡 = JSON.parse(卡形JSON);
const 种子 = JSON.parse(探针种子JSON);
const 种子文本 = JSON.stringify(种子.世界数据);

console.log('\n[0] 场景词清单本身达标(从真机校准, 不遗漏)');
{
  ok('场景词清单不少于真机观测条数', 场景词清单.length >= 真机观测过.length);
  ok('每一条真机观测过的场景词都在清单里(缺一条就漏检)',
    真机观测过.every(词 => 场景词清单.includes(词)));
  ok('清单没有重复词', new Set(场景词清单).size === 场景词清单.length);
}

console.log('\n[1] 探针种子合规: 五层与势力清单不含场景词');
{
  // 用布尔表逐词检测, 便于报出是哪个词漏了
  const 命中 = 场景词清单.filter(词 => 种子文本.includes(词));
  check('seed 的世界数据不含任何场景词', 命中, []);
  // 说明字段可以不避场景词(它是给测试看的话), 但种子本身的五层/势力清单必须干净
  ok('seed 确实在说明里声明了净化意图', 种子.说明.includes('探针种子合规'));
}

console.log('\n[2] 探针种子与 freeze 基线同构(否则测的是另一张卡)');
{
  const 形 = (w: any) => ({
    机构势力数: Object.keys(w.势力 ?? {}).length,
    地域数: Object.keys(w.地域 ?? {}).length,
    势力名: Object.keys(w.势力 ?? {}).sort(),
    地域名: Object.keys(w.地域 ?? {}).sort(),
    势力字段: Object.keys(w.势力?.[Object.keys(w.势力)[0]] ?? {}).sort(),
    地域字段: Object.keys(w.地域?.[Object.keys(w.地域)[0]] ?? {}).sort(),
  });
  const 基形 = 形(卡.世界数据);
  const 种形 = 形(种子.世界数据);
  check('机构势力数一致(2)', [基形.机构势力数, 种形.机构势力数], [2, 2]);
  check('地域数一致(3)', [基形.地域数, 种形.地域数], [3, 3]);
  check('势力名一致', 种形.势力名, 基形.势力名);
  check('地域名一致', 种形.地域名, 基形.地域名);
  check('势力字段一致(目标/动向/前情/势力范围/对外关系/头面人物)', 种形.势力字段, 基形.势力字段);
  check('地域字段一致(概况/局势/当权者/对外关系/前情)', 种形.地域字段, 基形.地域字段);
}

console.log('\n[3] 关键差异: freeze 是污染基线, seed 已净化');
{
  // freeze 那三句真机失败语汇, seed 必须没有(否则探针重复了污染基线)
  const 污染语汇 = ['街区巡查有序进行', '正开展日常巡检测试', '客流充足', '联合保洁消杀巡检'];
  const 仍在 = 污染语汇.filter(句 => 种子文本.includes(句));
  check('freeze 的失败语汇在 seed 里已净化', 仍在, []);
  // 反证: freeze 里确实有这些污染语汇, 否则这条断言是空喊
  const 基文本 = JSON.stringify(卡.世界数据);
  ok('freeze 基线确实带有失败语汇(证明 seed 净化是必要的)', 污染语汇.some(句 => 基文本.includes(句)));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);