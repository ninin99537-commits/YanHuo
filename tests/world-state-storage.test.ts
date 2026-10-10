// 烟火 · 世界状态的存储层(候选 3 的验收线) —— 用假平台跑真实源码
//
// 保存世界状态.ts 通过可替换的宿主访问平台(见 host.ts 顶部), 所以不装酒馆也能把这一层跑一遍:
// 写快照读回 / 落盘的成功与失败两种返回值 / 楼层不存在 / 删楼与重roll的回退 / 快照上限与物理清理 /
// 清空层与快照楼层的变化 / 旧格式快照迁移 / 推进落盘与重推的顺序。
//
// 这些行为以前散在 state.ts 的注释与各个调用点的记忆里, 一条用例都没有(而删楼/重roll/清空层
// 正是事故多发区)。这里按 tests/state-data.test.ts(彼方那份快照用例)的口径把契约钉住;
// 同时钉住"state.ts 转出来的还是同一批函数", 让既有调用方一行都不用改。
import { createPinia, setActivePinia } from 'pinia';
import type { WorldData } from '../src/烟火_世界运转/schema';
import { injectHostForTest } from '../src/烟火_世界运转/host';
import { resetSettingsReadCacheForTest } from '../src/烟火_世界运转/settings';
import {
  clearAllData,
  DATA_VERSION,
  discardSnapshotAt,
  emptyData,
  EVENT_HISTORY_LIMIT,
  loadData,
  saveData,
  SNAPSHOT_LIMIT,
  STORAGE_KEY,
  writeStateSnapshot,
} from '../src/烟火_世界运转/state';
import { 世界状态存档, 保存推进结果, 撤销快照并重读 } from '../src/烟火_世界运转/保存世界状态';
import { buildTickMessages } from '../src/烟火_世界运转/prompts';

setActivePinia(createPinia());

// settings.ts 的 schema 用到酒馆注入的 `_`, 兜底用浏览器 localStorage; 给两个最小替身
// (与 world-pipeline.test.ts / world-mutation.test.ts 同样处理), 否则设置解析失败会回退成默认值,
// 「快照保留份数」那一段就测不到了
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

/** 一份世界状态(缺的字段照 emptyData 补齐) */
function 世界(部分: Partial<WorldData> = {}): WorldData {
  return { ...emptyData(), ...部分 };
}

/**
 * 假平台: 一本聊天楼层 + 变量表 + 一份全局设置, 尽量照酒馆助手的行为来 ——
 * 关键在于"读取不存在的楼层会抛错", 存储层正是靠这个判定楼层已被删除。
 */
function makeFakePlatform(全局设置: Record<string, any> = {}) {
  const floors: Record<string, { role: string; message: string; is_hidden: boolean }> = {};
  const floorVars: Record<string, any> = {};
  const deleted: string[] = [];
  let chatVars: Record<string, any> = {};

  const host: any = {
    vars: {
      get(option: any) {
        if (option.type === 'chat')
          return chatVars;
        if (option.type === 'global')
          return { 烟火_settings: 全局设置 };
        const id = String(option.message_id);
        if (!(id in floors))
          throw new Error(`楼层 #${id} 不存在`);
        return floorVars[id] ?? {};
      },
      update(updater: any, option: any) {
        if (option.type === 'chat') {
          chatVars = updater(chatVars) ?? chatVars;
          return chatVars;
        }
        const id = String(option.message_id);
        if (!(id in floors))
          throw new Error(`楼层 #${id} 不存在`);
        floorVars[id] = updater(floorVars[id] ?? {}) ?? floorVars[id];
        return floorVars[id];
      },
      del(path: string, option: any) {
        if (option.type === 'chat') {
          delete chatVars[path];
          return { variables: chatVars, delete_occurred: true };
        }
        const id = String(option.message_id);
        deleted.push(id);
        if (floorVars[id])
          delete floorVars[id][path];
        return { variables: floorVars[id] ?? {}, delete_occurred: true };
      },
    },
    chat: {
      messages(range: any, options: any = {}) {
        const parts = typeof range === 'number' ? [range] : String(range).split('-').map(Number);
        const [from, to] = parts.length === 2 ? parts : [parts[0], parts[0]];
        const out = [];
        for (let i = from; i <= to; i++) {
          const m = floors[String(i)];
          if (!m)
            continue;
          if (options.role && options.role !== 'all' && m.role !== options.role)
            continue;
          out.push({ message_id: i, name: 'AI', role: m.role, is_hidden: !!m.is_hidden, message: m.message, data: {}, extra: {} });
        }
        return out;
      },
      lastMessageId() {
        const ids = Object.keys(floors).map(Number);
        return ids.length > 0 ? Math.max(...ids) : -1;
      },
    },
  };

  return {
    host,
    floors,
    floorVars,
    deleted,
    chatVars: () => chatVars,
    addFloor(id: number, message = `第${id}楼正文`, role = 'assistant') {
      floors[String(id)] = { role, message, is_hidden: false };
    },
  };
}

/** 每段都从干净的仓开始: 换平台 + 清掉设置读取缓存(免得读到上一段的保留份数) */
function 准备(全局设置: Record<string, any> = {}) {
  const p = makeFakePlatform(全局设置);
  injectHostForTest(p.host);
  setActivePinia(createPinia());
  resetSettingsReadCacheForTest();
  return p;
}

console.log('\n[1] 转出去的还是同一批函数: 既有调用方(state / 界面 / 世界数据变更)一行都不用改');
{
  准备();
  check('保存就是 module 里那一个', saveData === 世界状态存档.保存, true);
  check('读回就是 module 里那一个', loadData === 世界状态存档.读取, true);
  check('清空就是 module 里那一个', clearAllData === 世界状态存档.清空, true);
  check('推进落盘就是 module 里那一个', (保存推进结果 as unknown) === (世界状态存档.推进落盘 as unknown), true);
  check('重推就是 module 里那一个', (撤销快照并重读 as unknown) === (世界状态存档.重推 as unknown), true);
}

console.log('\n[2] 空聊天 → 空状态, 且不往聊天变量里写垃圾');
{
  const p = 准备();
  const d = loadData();
  check('锚点楼层 = -1', d.锚点楼层, -1);
  check('处理到楼层 = 0', d.处理到楼层, 0);
  check('清空层 = 0', d.清空层, 0);
  check('事件为空', d.事件, []);
  check('世界为空', d.世界, { 时间: '', 氛围: '', 总览: '' });
  check('聊天变量原样没动', p.chatVars(), {});
}

console.log('\n[3] 写一份快照 → 读回来的等于写进去的');
{
  const p = 准备();
  p.addFloor(5, '第五楼正文');
  const data = 世界({
    世界: { 时间: '2025-11-15 21:30', 氛围: '夜色渐深', 总览: '小镇安静下来' },
    地域: { 东街: { 概况: '集市所在', 局势: '太平', 当权者: '里正', 对外关系: '与西市通商', 前情: '' } },
    伏笔: [{ 标题: '缺角的玉佩', 埋设: '第一章', 指向: '身世', 成熟度: '酝酿', 前情: '' }],
    事件: [{
      id: 'e1',
      标题: '集市散场',
      描述: '摊贩收摊',
      地点: '东街',
      时间: '2025-11-15 20:00',
      规模: '要事',
      传播: '本埠',
      渠道: '',
      势力: '',
      阶段: '进行',
      隐秘: '公开',
      代表人物: '',
      前情: '',
      演变: [{ 时间: '2025-11-15 20:00', 变化: '人群散去' }],
    }],
    小结: '集市散场, 小镇归于安静',
    统计: { 推进次数: 3, 最后推进: 111 },
    处理到楼层: 5,
    清空层: 4,
  });
  check('写入成功', writeStateSnapshot(data, 5, 5, true), true);
  const back = loadData();
  check('世界读回来一样', back.世界, data.世界);
  check('地域读回来一样', back.地域, data.地域);
  check('伏笔读回来一样', back.伏笔, data.伏笔);
  check('事件读回来一样', back.事件, data.事件);
  check('小结与统计读回来一样', [back.小结, back.统计], [data.小结, data.统计]);
  check('锚点楼层 = 5', back.锚点楼层, 5);
  check('处理到楼层 = 5', back.处理到楼层, 5);
  check('清空层被本次写入消费掉', back.清空层, 0);
  check('快照确实写进了楼层变量', p.floorVars['5'][STORAGE_KEY].楼层, 5);
  check('快照里不带「清空层」(它只在聊天变量里)', '清空层' in p.floorVars['5'][STORAGE_KEY], false);
  check('索引里只有这一层', p.chatVars()[STORAGE_KEY].快照楼层, [5]);
}

console.log('\n[4] saveData(界面手动保存): 以最新楼层为锚点, 返回落盘结果, 不动进度也不消费清空层');
{
  const p = 准备();
  p.addFloor(1);
  p.addFloor(3);
  p.addFloor(7);
  // 先造一份"清空过"的元数据(清空层 = 3)
  writeStateSnapshot(世界({ 小结: '清空前' }), 3, 3, false);
  p.chatVars()[STORAGE_KEY].清空层 = 3;

  check('落盘成功 → 返回 true', saveData(世界({ 小结: '手改的', 处理到楼层: 4 })), true);
  const back = loadData();
  check('锚点 = 最新楼层', back.锚点楼层, 7);
  check('内容已保存', back.小结, '手改的');
  check('进度保持传入值, 不取最新楼层', back.处理到楼层, 4);
  check('saveData 不消费清空层(只有推进成功才清零)', back.清空层, 3);
}

console.log('\n[5] 落盘失败的三种情况: 一律返回 false, 索引与楼层变量都不许动');
{
  const p = 准备();
  p.addFloor(3);

  check('楼层不存在 → 落盘失败', writeStateSnapshot(世界({ 小结: '写不进去' }), 9, 9, false), false);
  check('失败不留索引', p.chatVars()[STORAGE_KEY], undefined);

  const 真update = p.host.vars.update;
  p.host.vars.update = (updater: any, option: any) => {
    if (option.type === 'message')
      throw new Error('写楼层失败');
    return 真update(updater, option);
  };
  check('写入抛异常 → 落盘失败', writeStateSnapshot(世界({ 小结: '写不进去' }), 3, 3, false), false);
  p.host.vars.update = 真update;
  check('异常后不留索引', p.chatVars()[STORAGE_KEY], undefined);
  check('异常后楼层里没有快照', (p.floorVars['3'] ?? {})[STORAGE_KEY], undefined);

  const 真末层 = p.host.chat.lastMessageId;
  p.host.chat.lastMessageId = () => {
    throw new Error('聊天还没就绪');
  };
  check('取不到锚点 → saveData 返回 false(不能报"已保存")', saveData(世界({ 小结: 'x' })), false);
  p.host.chat.lastMessageId = 真末层;
  check('锚点恢复后照旧能保存', saveData(世界({ 小结: '恢复后' })), true);
}

console.log(`\n[6] 快照上限: 默认保留 ${SNAPSHOT_LIMIT} 份, 超额的最早楼层被物理删除`);
{
  const p = 准备();
  for (let i = 1; i <= 12; i++)
    p.addFloor(i);
  for (let i = 1; i <= 12; i++)
    writeStateSnapshot(世界({ 小结: `第${i}轮` }), i, i, false);
  const meta = p.chatVars()[STORAGE_KEY];
  check('索引只留上限份数', meta.快照楼层.length, SNAPSHOT_LIMIT);
  check('留下的是最新的 10 层', meta.快照楼层, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  check('超额楼层被物理删除', p.deleted, ['1', '2']);
  check('最早那份快照键已删除', p.floorVars['1'][STORAGE_KEY], undefined);
  check('读回仍是最新那份', loadData().小结, '第12轮');
}

console.log('\n[7] 保留份数由 module 内部读设置决定(设置「运转.快照保留份数」)');
{
  const p = 准备({ 运转: { 快照保留份数: 2 } });
  for (let i = 1; i <= 5; i++)
    p.addFloor(i);
  for (let i = 1; i <= 5; i++)
    writeStateSnapshot(世界({ 小结: `第${i}轮` }), i, i, false);
  check('只留设置里说的 2 份', p.chatVars()[STORAGE_KEY].快照楼层, [4, 5]);
  check('裁掉的 3 层被物理删除', p.deleted, ['1', '2', '3']);
  check('读回仍是最新那份', loadData().小结, '第5轮');
}

console.log('\n[8] 楼层被删(或重roll) → 自动回退到更早快照, 并清掉失效索引');
{
  const p = 准备();
  p.addFloor(3);
  p.addFloor(7);
  writeStateSnapshot(世界({ 小结: '老状态' }), 3, 3, false);
  writeStateSnapshot(世界({ 小结: '新状态' }), 7, 7, false);
  check('当前读到的是最新快照', loadData().小结, '新状态');
  delete p.floors['7'];
  const rolled = loadData();
  check('回退到更早快照', rolled.小结, '老状态');
  check('锚点楼层跟着回退', rolled.锚点楼层, 3);
  check('失效楼层已从索引清掉', p.chatVars()[STORAGE_KEY].快照楼层, [3]);
}

console.log('\n[9] 楼层还在但快照键没了(重roll出新页) → 回退, 但索引保留');
{
  const p = 准备();
  p.addFloor(3);
  p.addFloor(7);
  writeStateSnapshot(世界({ 小结: '老状态' }), 3, 3, false);
  writeStateSnapshot(世界({ 小结: '新状态' }), 7, 7, false);
  delete p.floorVars['7'];
  const back = loadData();
  check('回退到更早快照', back.小结, '老状态');
  check('索引保留 7(切回该 swipe 页时快照会回来)', p.chatVars()[STORAGE_KEY].快照楼层, [3, 7]);
}

console.log('\n[10] 元数据坏掉时的兜底: 索引过滤坏值 / 结构不对也要救回清空层');
{
  const p = 准备();
  p.addFloor(3);
  p.chatVars()[STORAGE_KEY] = { 版本: DATA_VERSION, 快照楼层: [3, 'x', Number.NaN, null], 清空层: 2 };
  const d = loadData();
  check('读不到快照就是空状态', d.小结, '');
  check('清空层照旧生效', d.清空层, 2);

  p.chatVars()[STORAGE_KEY] = { 版本: 2, 快照楼层: '坏的', 清空层: 3 };
  check('索引结构坏掉 → 按空索引处理', loadData().锚点楼层, -1);
  check('清空层被救回来', loadData().清空层, 3);
}

console.log('\n[11] 旧格式快照 → 读回时迁移(旧字段名 / 废弃字段 / 枚举越界 / 流水裁剪)');
{
  const p = 准备();
  p.addFloor(4, '第四楼正文');
  p.floorVars['4'] = {
    [STORAGE_KEY]: {
      版本: DATA_VERSION,
      楼层: 4,
      处理到楼层: 4,
      // 旧快照的「世界.大势」是一句话, 现在叫「总览」
      世界: { 时间: '2020-01-01 08:00', 氛围: '旧', 大势: '旧的一句话大势' },
      // 旧势力缺 前情/对外关系, 用旧名「领地」写势力范围, 还带着已废弃的「对主角态度」
      势力: { 商会: { 目标: '赚钱', 动向: '守成', 领地: '东街', 对主角态度: '亲近' } },
      // 旧事件带已废弃的「知晓/迫近」, 枚举越界, 演变超出保留条数
      事件: [{
        id: 'e1',
        标题: '旧事',
        知晓: '隐秘',
        迫近: '大事',
        演变: Array.from({ length: 10 }, (_, i) => ({ 时间: `t${i + 1}`, 变化: `变${i + 1}` })),
      }],
      伏笔: [{ 标题: '旧伏笔' }],
      统计: { 推进次数: 2, 最后推进: 5 },
      小结: '旧世界',
    },
  };
  p.chatVars()[STORAGE_KEY] = { 版本: DATA_VERSION, 快照楼层: [4], 清空层: 0 };
  const d = loadData();
  check('旧「大势」迁移成「总览」', d.世界.总览, '旧的一句话大势');
  check('势力旧名「领地」迁移到「势力范围」', d.势力.商会.势力范围, '东街');
  check('废弃字段「对主角态度」不带进新结构', '对主角态度' in d.势力.商会, false);
  check('势力缺的字段补空串', [d.势力.商会.前情, d.势力.商会.对外关系], ['', '']);
  check('事件废弃字段「知晓/迫近」不带进新结构', ['知晓' in d.事件[0], '迫近' in d.事件[0]], [false, false]);
  check('事件枚举缺省/越界一律纠偏', [d.事件[0].规模, d.事件[0].传播, d.事件[0].阶段, d.事件[0].隐秘], ['要事', '本埠', '进行', '公开']);
  check(`演变只留最近 ${EVENT_HISTORY_LIMIT} 条`, d.事件[0].演变.length, EVENT_HISTORY_LIMIT);
  check('留的是最新的那几条', [d.事件[0].演变[0].变化, d.事件[0].演变[EVENT_HISTORY_LIMIT - 1].变化], ['变3', '变10']);
  check('伏笔缺的字段补空串', d.伏笔[0].前情, '');
  check('锚点楼层按有效快照给', d.锚点楼层, 4);
  check('处理到楼层照 payload 读回来', d.处理到楼层, 4);
  check('小结照旧', d.小结, '旧世界');

  // v2.5: 旧快照的墓碑混在「事件」里, 读回时按阶段分流到 `已了结`
  // (不迁移的话, 它们下一轮会被当成活跃事件发给世界引擎, 于是"世界还有两件事在跑")
  const p2 = 准备();
  p2.addFloor(6, '第六楼正文');
  p2.floorVars['6'] = {
    [STORAGE_KEY]: {
      版本: DATA_VERSION,
      楼层: 6,
      处理到楼层: 6,
      世界: { 时间: '2025-03-01 09:00', 氛围: '旧', 总览: '旧' },
      事件: [
        { id: 'e1', 标题: '还在酝酿的事', 阶段: '酝酿' },
        { id: 't1', 标题: '已经了结的事', 阶段: '已结束' },
        { id: 'e2', 标题: '正在推进的事', 阶段: '进行' },
        { id: 't2', 标题: '另一件了结的事', 阶段: '已结束' },
      ],
      统计: { 推进次数: 1, 最后推进: 1 },
      小结: '旧世界(含墓碑)',
    },
  };
  p2.chatVars()[STORAGE_KEY] = { 版本: DATA_VERSION, 快照楼层: [6], 清空层: 0 };
  const d2 = loadData();
  check('旧格式: 墓碑搬进 `已了结`', d2.已了结.map(e => e.标题), ['已经了结的事', '另一件了结的事']);
  check('旧格式: `事件` 只剩活跃的', d2.事件.map(e => e.标题), ['还在酝酿的事', '正在推进的事']);
  ok('不变量: `事件` 里没有已结束', d2.事件.every(e => e.阶段 !== '已结束'));
  check('墓碑的字段照旧重建', [d2.已了结[0].阶段, d2.已了结[0].规模, d2.已了结[0].标题], ['已结束', '要事', '已经了结的事']);
  check('墓碑原样落回快照(写出去读回来还是两个桶)', (() => {
    if (!saveData({ ...d2, 世界: { ...d2.世界 } })) return '保存失败';
    const 再读 = loadData();
    return [再读.已了结.length, 再读.事件.length];
  })(), [2, 2]);

  // 端到端: 迁移之后, 下一轮发给世界引擎的请求体里一条墓碑标题都不许出现
  const 请求 = buildTickMessages({
    world: d2,
    reply: '【最新回复】\n他推开门。',
    replyCount: 1,
    context: '我去街上走走',
    timeJump: null,
    时间约束: '正文未给出新日期, 沿用上次世界时间',
    worldbook: '',
    playerName: '沈砚',
    playerDesc: '',
    破限: false,
    头部填充: false,
    头部填充文本: '',
    防截断: false,
    预填充: false,
    节令历法: true,
    世界指标: true,
    世界密度: '正常',
  }).filter(m => m.role === 'user')[0].content;
  const JSON块 = 请求.split('\n')[1];
  ok('【世界当前状态】的 JSON 里没有第一件墓碑', !JSON块.includes('已经了结的事'));
  ok('【世界当前状态】的 JSON 里没有第二件墓碑', !JSON块.includes('另一件了结的事'));
  ok('活跃的照旧在请求体里', 请求.includes('还在酝酿的事') && 请求.includes('正在推进的事'));
  ok('墓碑只在只读清单里露面', 请求.includes('【已经了结的事(只读)】已经了结的事、另一件了结的事'));
}

console.log('\n[12] 推进落盘: 锚点/处理到楼层/清空层/内存那一份由 module 一次交代');
{
  const p = 准备();
  p.addFloor(3);
  p.addFloor(9);
  writeStateSnapshot(世界({ 小结: '老状态' }), 3, 3, false);
  p.chatVars()[STORAGE_KEY].清空层 = 3;

  const 结果 = 世界状态存档.推进落盘(世界({ 小结: '新状态', 处理到楼层: 1, 清空层: 5 }), 9);
  check('落盘成功', 结果.落盘, true);
  check('锚点楼层 = 本次分析的最后一条回复', 结果.锚点楼层, 9);
  check('交回的内存那份补上了锚点楼层', 结果.数据.锚点楼层, 9);
  check('处理到楼层取自锚点, 不是 data 自己的值', 结果.数据.处理到楼层, 9);
  check('内存那份的清空层归零', 结果.数据.清空层, 0);
  check('元数据里的清空层被消费掉', p.chatVars()[STORAGE_KEY].清空层, 0);
  check('索引变成两层', p.chatVars()[STORAGE_KEY].快照楼层, [3, 9]);
  check('读回来是新的那份', loadData().小结, '新状态');
  ok('说明里讲了落到哪一层', 结果.说明.includes('#9'));

  const 失败 = 世界状态存档.推进落盘(世界({ 小结: '写不进去' }), 99);
  check('楼层不存在 → 落盘失败', 失败.落盘, false);
  check('失败时锚点楼层 = -1', 失败.锚点楼层, -1);
  check('失败时交回的仍是传进去那一份', 失败.数据.小结, '写不进去');
  ok('失败时说明如实讲"写不进去"', 失败.说明.includes('写不进去'));
  check('失败不动索引', p.chatVars()[STORAGE_KEY].快照楼层, [3, 9]);
}

console.log('\n[13] 重推: 撤销锚点快照并重新读回(顺序收在 module 里)');
{
  const p = 准备();
  p.addFloor(3);
  p.addFloor(9);
  writeStateSnapshot(世界({ 小结: '老状态' }), 3, 3, false);
  writeStateSnapshot(世界({ 小结: '新状态' }), 9, 9, false);

  const 重推后 = 世界状态存档.重推(9);
  check('重推后回落到更早快照', 重推后.小结, '老状态');
  check('重推后锚点跟着回落', 重推后.锚点楼层, 3);
  check('重推后索引只剩更早那层', p.chatVars()[STORAGE_KEY].快照楼层, [3]);
  check('撤销的楼层变量被物理删除', p.deleted, ['9']);
  check('撤销不存在的楼层 → false', discardSnapshotAt(999), false);
  check('重推落空(没有锚点快照)时读到空状态', 撤销快照并重读(999).小结, '老状态');
}

console.log('\n[14] 清空: 快照物理删除 + 元数据重置 + 记录清空层');
{
  const p = 准备();
  p.addFloor(2);
  p.addFloor(9);
  writeStateSnapshot(世界({ 小结: '甲' }), 2, 2, false);
  writeStateSnapshot(世界({ 小结: '乙' }), 9, 9, false);
  const layer = clearAllData();
  check('清空层 = 清空时的最后一个楼层', layer, 9);
  check('所有楼层快照被物理删除', p.deleted, ['2', '9']);
  check('元数据重置', p.chatVars()[STORAGE_KEY], { 版本: DATA_VERSION, 快照楼层: [], 清空层: 9 });
  check('清空后读到空状态', loadData().小结, '');
  check('清空层对新状态仍生效', loadData().清空层, 9);
  check('清空后还能照常存新的', saveData(世界({ 小结: '清空之后' })), true);
  check('新快照的索引只有最新那层', p.chatVars()[STORAGE_KEY].快照楼层, [9]);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0)
  process.exit(1);
