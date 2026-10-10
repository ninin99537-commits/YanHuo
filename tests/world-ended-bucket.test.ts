// 烟火 v2.5 · 「已了结」独立成桶(数据侧) —— 不变量: `事件` 数组里永不出现 阶段 === '已结束'
//
// 决策: `事件` 只表示"此刻在发生的事"(全部归 AI), 「已了结」独立成桶(全部归代码)。
// "保留已了结的事"本来就是**存储**而不是判断, 代码早就在管它了(ENDED_EVENT_LIMIT 与裁剪),
// AI 那份"逐字带回"是纯粹的重复劳动, 而且每轮都在提醒它"清单里还有东西"。
//
// 三条写入路径都要守住这条不变量, 本文件逐一钉住:
//   [1] AI 规范化后(世界数据.ts: validateAndNormalize)
//   [2] 快照读回后(保存世界状态.ts: 旧格式分流 —— 用例在 world-state-storage.test.ts 的 [11])
//   [3] 面板手改后(世界数据变更.ts 的那道门)
// 其余: 上限只夹活跃桶 / 换血守卫 / 编辑会话 / 有世界数据 / 面板三档筛选。
// 提示词与注入那一侧在 tests/yanhuo-tombstone.test.ts。
import { createPinia, setActivePinia } from 'pinia';
import type { WorldData, WorldEvent } from '../src/烟火_世界运转/schema';
import { 有世界数据, validateAndNormalize } from '../src/烟火_世界运转/世界数据';
import { 保存事件, 移除事件 } from '../src/烟火_世界运转/世界数据变更';
import { 会话冲突, 提交会话, 打开事件会话 } from '../src/烟火_世界运转/世界编辑会话';
import { emptyData, ENDED_EVENT_LIMIT, EVENT_LIMIT } from '../src/烟火_世界运转/state';
import vueSource from '../src/烟火_世界运转/悬浮球界面.vue?raw';

setActivePinia(createPinia());
(globalThis as any)._ = {
  clamp: (value: number, lower: number, upper: number) => Math.min(Math.max(value, lower), upper),
  cloneDeep: (value: any) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value))),
};
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

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

/** 假环境: 只记账, 不碰酒馆 */
function 假环境(注入世界书条目 = false) {
  const 记 = { 保存: [] as WorldData[], 同步: [] as unknown[] };
  return {
    记,
    环境: {
      注入世界书条目,
      保存: (数据: WorldData) => { 记.保存.push(数据); return true; },
      清空: () => {},
      同步世界书: (数据: WorldData, 写入: boolean) => { 记.同步.push({ 数据, 写入 }); },
      提醒: () => {},
    },
  };
}

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
  };
}

function 世界(部分: Partial<WorldData> = {}): WorldData {
  return { ...emptyData(), ...部分 };
}

/** 不变量本身: 一个桶里只要出现墓碑就算破 */
function 无墓碑(数据: WorldData): boolean {
  return (数据.事件 ?? []).every(e => e.阶段 !== '已结束');
}

function 载荷(部分: Record<string, any> = {}) {
  return { 世界: { 时间: '2025-01-02 10:00' }, 事件: [], 势力: {}, ...部分 };
}

console.log('\n[1] 路径① AI 规范化后: 收尾的搬进墓碑桶, `事件` 里一条墓碑都不留');
{
  const 旧 = 世界({ 事件: [事件({ id: 'e1', 标题: '老事' }), 事件({ id: 'e2', 标题: '另一件' })] });
  const 新 = validateAndNormalize(载荷({
    事件: [
      { id: 'e1', 标题: '老事', 阶段: '已结束', 变化: '了结' },
      { id: 'e2', 标题: '另一件', 变化: '往前一步' },
    ],
  }), 旧);

  ok('不变量: 事件里没有已结束', 无墓碑(新));
  check('活跃桶只剩没被了结的那条', 新.事件.map(e => e.标题), ['另一件']);
  check('了结的进了墓碑桶', 新.已了结.map(e => e.标题), ['老事']);
  check('墓碑的阶段是已结束', 新.已了结[0].阶段, '已结束');
  check('墓碑沿用了旧 id(面板与日志按 id 认)', 新.已了结[0].id, 'e1');

  const 空 = validateAndNormalize(载荷({ 事件: [] }), 世界());
  check('没有墓碑时是空数组(不是 undefined)', 空.已了结, []);
}

console.log('\n[2] 合并: 旧墓碑在前 + 本轮了结在后, 超 6 条裁最旧的');
{
  const 旧 = 世界({
    事件: [事件({ id: 'e1', 标题: '正在推进' })],
    已了结: [事件({ id: 't1', 标题: '旧墓碑1', 阶段: '已结束' }), 事件({ id: 't2', 标题: '旧墓碑2', 阶段: '已结束' })],
  });
  const 新 = validateAndNormalize(载荷({ 事件: [{ id: 'e1', 标题: '正在推进', 阶段: '已结束' }] }), 旧);
  check('活跃清空', 新.事件, []);
  check('墓碑按"旧在前、本轮了结在后"拼', 新.已了结.map(e => e.标题), ['旧墓碑1', '旧墓碑2', '正在推进']);

  const 七条 = Array.from({ length: ENDED_EVENT_LIMIT + 1 }, (_, i) => 事件({ id: `t${i + 1}`, 标题: `旧墓碑${i + 1}`, 阶段: '已结束' }));
  const 旧2 = 世界({ 事件: [事件({ id: 'e9', 标题: '刚了结的事' })], 已了结: 七条 });
  const 新2 = validateAndNormalize(载荷({ 事件: [{ id: 'e9', 标题: '刚了结的事', 阶段: '已结束' }] }), 旧2);
  check(`墓碑只留最近 ${ENDED_EVENT_LIMIT} 条`, 新2.已了结.length, ENDED_EVENT_LIMIT);
  check('最旧的两条被挤掉', 新2.已了结[0].标题, '旧墓碑3');
  check('刚了结的那条在最末(不会被自己挤掉)', 新2.已了结[ENDED_EVENT_LIMIT - 1].标题, '刚了结的事');
}

console.log(`\n[3] 上限: \`事件\` 的 ${EVENT_LIMIT} 条只夹活跃桶, 墓碑按 ${ENDED_EVENT_LIMIT} 条单独夹`);
{
  const 墓碑 = Array.from({ length: ENDED_EVENT_LIMIT }, (_, i) => 事件({ id: `t${i + 1}`, 标题: `旧墓碑${i + 1}`, 阶段: '已结束' }));
  const 很多 = Array.from({ length: EVENT_LIMIT + 3 }, (_, i) => ({ 标题: `新事${i + 1}`, 阶段: '进行' }));
  const 新 = validateAndNormalize(载荷({ 事件: 很多 }), 世界({ 已了结: 墓碑 }));

  check(`活跃裁到 ${EVENT_LIMIT} 条`, 新.事件.length, EVENT_LIMIT);
  check('墓碑一条都没动(以前会被这 30 条一起挤掉)', 新.已了结.length, ENDED_EVENT_LIMIT);
  ok('不变量: 事件里没有已结束', 无墓碑(新));
}

console.log('\n[4] 换血守卫: 活跃的照旧捞回, 墓碑既不捞回活跃桶也不丢');
{
  const 旧 = 世界({
    事件: [事件({ id: 'e1', 标题: '甲' })],
    已了结: [事件({ id: 't1', 标题: '旧墓碑', 阶段: '已结束' })],
  });
  const 全丢 = validateAndNormalize(载荷({ 事件: [] }), 旧);
  check('未结束的旧事件照旧捞回', 全丢.事件.map(e => e.标题), ['甲']);
  check('墓碑不进活跃桶', 全丢.事件.some(e => e.标题 === '旧墓碑'), false);
  check('墓碑仍留在墓碑桶', 全丢.已了结.map(e => e.标题), ['旧墓碑']);
}

console.log('\n[5] 路径③ 面板手改: 改阶段 = 换桶; 移除两个桶都能删');
{
  const 数据 = 世界({ 事件: [事件({ id: 'e1', 标题: '甲' })], 已了结: [事件({ id: 't1', 标题: '乙', 阶段: '已结束' })] });

  const 了结 = 保存事件(数据, { ...数据.事件[0], 阶段: '已结束' }, 假环境().环境);
  ok('没被拒绝', !了结.拒绝);
  ok('不变量: 事件里没有已结束', 无墓碑(了结.数据));
  check('搬出了活跃桶', 了结.数据.事件, []);
  check('搬进了墓碑桶', 了结.数据.已了结.map(e => e.标题), ['乙', '甲']);
  check('id 沿用', 了结.数据.已了结[1].id, 'e1');

  const 复活 = 保存事件(了结.数据, { ...了结.数据.已了结[0], 阶段: '进行' }, 假环境().环境);
  ok('墓碑能被改回进行(重新开张)', !复活.拒绝);
  ok('不变量: 事件里没有已结束', 无墓碑(复活.数据));
  check('乙搬回了活跃桶', 复活.数据.事件.map(e => e.标题), ['乙']);
  check('墓碑桶里只剩甲', 复活.数据.已了结.map(e => e.标题), ['甲']);

  const 删活跃 = 移除事件(复活.数据, 't1', 假环境().环境);
  check('活跃桶按 id 删掉(刚从墓碑搬回来的那条)', 删活跃.数据.事件, []);
  check('另一个桶没受影响', 删活跃.数据.已了结.map(e => e.标题), ['甲']);

  const 删墓碑 = 移除事件(复活.数据, 'e1', 假环境().环境);
  check('墓碑也能按 id 删掉', 删墓碑.数据.已了结, []);
  check('活跃桶没受影响', 删墓碑.数据.事件.map(e => e.标题), ['乙']);

  const 没这条 = 移除事件(复活.数据, '不存在', 假环境().环境);
  check('两个桶都没有就直说', 没这条.说明, '这条事件已经不在清单里了');
}

console.log('\n[6] 手改的上限与同名: 两把尺各管自己那个桶');
{
  const 墓碑满 = Array.from({ length: ENDED_EVENT_LIMIT }, (_, i) => 事件({ id: `t${i + 1}`, 标题: `旧墓碑${i + 1}`, 阶段: '已结束' }));
  const 数据 = 世界({ 事件: [事件({ id: 'e1', 标题: '进行中的事' })], 已了结: 墓碑满 });

  const 超限 = 保存事件(数据, { ...数据.事件[0], 阶段: '已结束' }, 假环境().环境);
  check('墓碑桶满了就不让再了结', 超限.拒绝, `已结束的事件最多 ${ENDED_EVENT_LIMIT} 条, 请先删掉一条再了结`);

  const 满活跃 = 世界({
    事件: Array.from({ length: EVENT_LIMIT }, (_, i) => 事件({ id: `e${i + 1}`, 标题: `事${i + 1}` })),
    已了结: 墓碑满,
  });
  const 加一条 = 保存事件(满活跃, 事件({ 标题: '再来一条' }), 假环境().环境);
  check('活跃桶满了才拦新增(墓碑不占这个名额)', 加一条.拒绝, `事件最多 ${EVENT_LIMIT} 条, 请先删掉一条再添加`);
  const 改墓碑 = 保存事件(满活跃, { ...墓碑满[0], 描述: '改个描述' }, 假环境().环境);
  ok('活跃桶满的时候, 墓碑照样能改', !改墓碑.拒绝);
  check('墓碑改完还留在墓碑桶', 改墓碑.数据.已了结.find(e => e.id === 't1')?.描述, '改个描述');
  check('就地改, 不挪到末尾(清单按时间从早到晚排)', 改墓碑.数据.已了结[0].id, 't1');
}

console.log('\n[7] 编辑会话: 墓碑也算"还在清单里"');
{
  const 墓碑 = 事件({ id: 't1', 标题: '乙', 阶段: '已结束' });
  const 数据 = 世界({ 事件: [], 已了结: [墓碑] });
  const 会话 = 打开事件会话(墓碑);
  check('打开墓碑没有冲突', 会话冲突(会话, 数据), null);

  const 提交 = 提交会话(会话, 数据, 假环境().环境);
  ok('提交墓碑能走通那道门', !!提交 && !提交.拒绝);
  check('没改动 → 不换桶', 提交?.数据.已了结.map(e => e.标题), ['乙']);

  const 被删了 = 世界({ 事件: [], 已了结: [] });
  check('两个桶都找不到才算冲突', 会话冲突(会话, 被删了), '这条事件已经不在清单里了, 请重新打开再改');
}

console.log('\n[8] `有世界数据` 的口径: 只剩墓碑 = 世界没有内容(策划确认这是对的)');
{
  const 只有墓碑 = 世界({ 已了结: [事件({ id: 't1', 标题: '乙', 阶段: '已结束' })] });
  check('只剩墓碑 → 没有世界数据', 有世界数据(只有墓碑), false);
  ok('墓碑不再被当成"世界有内容"', 只有墓碑.事件.length === 0);

  const 有活跃 = 世界({ 事件: [事件({ id: 'e1', 标题: '甲' })] });
  check('有活跃事件 → 有世界数据', 有世界数据(有活跃), true);
  const 有时间 = 世界({ 世界: { 时间: '2025-01-01 08:00', 氛围: '', 总览: '' } });
  check('只有时间也算有(照旧)', 有世界数据(有时间), true);
}

console.log('\n[9] 面板: 三档筛选各读对桶, 「全部」两个桶都在且活跃在上');
{
  ok('活跃桶取自 `事件`', vueSource.includes('const 活跃 = [...world.value.事件].reverse();'));
  ok('墓碑桶取自 `已了结`', vueSource.includes('const 墓碑 = [...(world.value.已了结 ?? [])].reverse();'));
  ok('三档各读对桶, 且「全部」是活跃在前', vueSource.includes("const events = stageFilter.value === '进行中' ? 活跃 : stageFilter.value === '已结束' ? 墓碑 : [...活跃, ...墓碑];"));
  ok('活跃事件列表不再自己过滤阶段', vueSource.includes('const activeEvents = computed(() =>\n  world.value.事件\n    .slice(-4)'));
  ok('势力关联事件只读 `事件`', vueSource.includes('world.value.事件\n    .filter(event => event.势力 === selectedFaction.value)'));
  ok('面板里再没有"阶段 !== 已结束"这种就地过滤', (vueSource.split("阶段 !== '已结束'").length - 1) === 0);
  ok('徽章还在(两个桶的事件都带着阶段)', vueSource.includes('<span v-if="event.阶段 === \'已结束\'" class="yh-badge yh-badge-done">已了结</span>'));
  ok('移除按钮照旧走那道门(两个桶都找)', vueSource.includes('@click="removeEvent(event)"'));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0)
  process.exit(1);
