// 烟火 · 世界推进主流程(候选5 的安全网) —— 用假平台 + 假模型把整条推进跑通
//
// 烟火这条流程以前一条用例都没有: 它要聊天楼层、变量表、世界书、模型接口四样东西齐备才能跑。
// 现在平台调用已经收进 host.ts(与彼方同一个形状), 测试里塞一个假宿主就能端到端驱动它:
//   成功一轮 → 世界时间/小结/事件落进状态与新楼层快照;
//   模型第一次输出坏 JSON → 原样重试一次就成功(第二次请求里不再有回喂);
//   三次都坏 → 报错, 且"处理到楼层"与旧数据一个字段都不许动;
//   接口没配置 / 没有可分析的回复 → 提前退出, 一次模型都不调;
//   读取世界书 + 注入世界书条目 → 世界书真的被读、条目真的被写(经接缝)。
//   v2.5 [7]: 两件都收尾后, 完成日志报「进行中 0 件 / 已了结 2 件」, 且墓碑不再进请求体(只在只读清单里)。
import { createPinia, setActivePinia } from 'pinia';
import { injectHostForTest } from '../src/烟火_世界运转/host';
import { emptyData, loadData, useStateStore, useDebugStore, WORLDBOOK_ENTRY_NAME } from '../src/烟火_世界运转/state';
import { SettingsSchema } from '../src/烟火_世界运转/schema';
import { updateWorld } from '../src/烟火_世界运转/update';

const SETTINGS_KEY = '烟火_settings';

// settings.ts 用酒馆注入的 `_` 与浏览器 localStorage 兜底; 给两个最小替身
(globalThis as any)._ = {
  clamp: (value: number, lower: number, upper: number) => Math.min(Math.max(value, lower), upper),
  cloneDeep: (value: any) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value))),
};
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
// api.ts 用 window.setTimeout 做请求超时计时; node 里没有 window, 给个最小替身
(globalThis as any).window = { setTimeout, clearTimeout };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

/** 一份能跑通的烟火模型输出: 「世界」对象带时间, 「事件」是数组(校验只要求这两样) */
const 正常输出 = JSON.stringify({
  世界: { 时间: '2025-11-15 21:30', 氛围: '夜色渐深', 总览: '小镇安静下来' },
  事件: [{ 标题: '集市散场', 阶段: '进行', 概述: '摊贩开始收摊', 变化: '人群散去' }],
  小结: '集市散场, 小镇归于安静',
});

/** 默认设置: 走真正的 schema(缺的字段由默认值补齐), 免得手写的对象过不了校验被回退成空接口 */
function 默认设置() {
  return SettingsSchema.parse({
    接口: { 地址: 'https://example.invalid/v1', 模型: 'test-model', 密钥: 'k', 最大token: 2048, 服务端转发: true },
    运转: { 读取最近回复数: 3, 读取世界书: false, 注入世界书条目: false },
  });
}

interface 造平台选项 {
  设置?: any;
  /** 模型逐次返回的内容; 用完就重复最后一个。放 { 抛错: '...' } 表示这次请求直接失败 */
  生成序列?: string[];
  /** 聊天楼层; 默认给一层 AI 回复 */
  楼层?: Record<string, any>;
}

/** 假平台: 聊天楼层 + 变量表 + 人设 + 世界书 + 模型接口, 全部记账, 不碰酒馆。
 *  提示条不在这里断言(它是往父窗口文档里画 DOM 的, node 里没有那个文档, 会被静默丢弃),
 *  所以用户可见的结果改用"日志页记录 + 数据本身"来观察。 */
function 造平台(选项: 造平台选项 = {}) {
  const 记录 = { raw: [] as any[], 读过的世界书: [] as string[] };
  const floors: Record<string, any> = 选项.楼层 ?? {
    '1': { role: 'user', message: '第一楼: 主角在集市上逛。', is_hidden: false },
    '3': { role: 'assistant', message: '第三楼: 集市散了, 主角往家走。', is_hidden: false },
  };
  const floorVars: Record<string, any> = {};
  const 世界书: any[] = [];
  let chatVars: Record<string, any> = {};
  let 全局设置: any = 选项.设置 ?? 默认设置();
  let 第几次 = 0;

  const host: any = {
    vars: {
      scriptId: () => 'script-1',
      get(option: any) {
        if (option.type === 'chat')
          return chatVars;
        if (option.type === 'global')
          return { [SETTINGS_KEY]: 全局设置 };
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
        if (option.type === 'global') {
          全局设置 = updater({ [SETTINGS_KEY]: 全局设置 })?.[SETTINGS_KEY] ?? 全局设置;
          return { [SETTINGS_KEY]: 全局设置 };
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
        if (floorVars[id])
          delete floorVars[id][path];
        return { variables: floorVars[id] ?? {}, delete_occurred: true };
      },
      insertOrAssign(variables: Record<string, any>, option: any) {
        if (option.type === 'chat') {
          chatVars = { ...chatVars, ...variables };
          return chatVars;
        }
        if (option.type === 'global') {
          全局设置 = { ...全局设置, ...variables[SETTINGS_KEY] };
          return { [SETTINGS_KEY]: 全局设置 };
        }
        const id = String(option.message_id);
        floorVars[id] = { ...(floorVars[id] ?? {}), ...variables };
        return floorVars[id];
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
      currentChatId: () => 'chat-1',
    },
    events: {
      onMessageReceived: () => ({ stop: () => {} }),
      onMessageDeleted: () => ({ stop: () => {} }),
      onMessageSwiped: () => ({ stop: () => {} }),
      onChatChanged: () => ({ stop: () => {} }),
    },
    persona: {
      name: () => '主角',
      description: () => '主角设定描述',
    },
    model: {
      list: async () => ['test-model'],
      raw: async (配置: any) => {
        记录.raw.push(配置);
        const 序列 = 选项.生成序列 ?? [正常输出];
        const 项: any = 序列[Math.min(第几次, 序列.length - 1)];
        第几次++;
        if (项 && typeof 项 === 'object')
          throw new Error(String(项.抛错));
        return 项;
      },
      stop: () => true,
    },
    macros: {
      expand: (text: string) => text,
    },
    ejs: {
      prepareContext: async () => ({}),
      evaluate: async () => null,
      syntaxError: async () => '',
    },
    worldbook: {
      boundNames: () => ({ primary: '测试世界书', additional: [] }),
      chatName: () => null,
      globalNames: () => [],
      entries: async (name: string) => {
        记录.读过的世界书.push(name);
        return name === '测试世界书' ? 世界书 : [];
      },
      update: async (name: string, updater: any) => {
        if (name !== '测试世界书')
          return;
        const 新 = updater([...世界书]);
        世界书.length = 0;
        世界书.push(...新);
      },
      create: async (name: string, entries: any[]) => {
        if (name !== '测试世界书')
          return;
        世界书.push(...entries);
      },
      remove: async (name: string, predicate: any) => {
        if (name !== '测试世界书')
          return;
        for (let i = 世界书.length - 1; i >= 0; i--) {
          if (predicate(世界书[i]))
            世界书.splice(i, 1);
        }
      },
    },
  };

  return { host, 记录, floors, floorVars, 世界书, 设置: () => 全局设置 };
}

const 取状态 = () => useStateStore().data as any;
const 取日志 = () => useDebugStore().log as any;

/** 每段都从干净的仓开始: pinia 重来一份, 平台换成新的假的。
 *  getSettings 有 500ms 缓存, 换平台(换设置)前先等它过期, 否则会读到上一段的设置。 */
async function 准备(选项: 造平台选项 = {}) {
  await sleep(600);
  const p = 造平台(选项);
  injectHostForTest(p.host);
  setActivePinia(createPinia());
  return p;
}

console.log('\n[1] 成功一轮: 世界时间/小结/事件落到状态与新楼层快照');
{
  const p = await 准备();
  await updateWorld(true);

  const 状态 = 取状态();
  check('世界时间按模型输出推进', 状态.世界.时间, '2025-11-15 21:30');
  check('小结入库', 状态.小结, '集市散场, 小镇归于安静');
  check('事件收下一条', 状态.事件.map((e: any) => e.标题), ['集市散场']);
  check('处理到楼层 = 本次锚点楼层', 状态.处理到楼层, 3);
  check('清空层归零', 状态.清空层, 0);
  ok('锚点楼层的快照真的写进了楼层变量', Object.keys(p.floorVars['3'] ?? {}).length > 0);
  ok('快照里就是新状态', JSON.stringify(p.floorVars['3'] ?? {}).includes('集市散场'));
  check('只调了一次模型', p.记录.raw.length, 1);
  ok('日志页记下了模型输出', String(取日志()?.response ?? '').includes('集市散场'));
  check('重新读回来也是新状态', loadData().世界.时间, '2025-11-15 21:30');
}

/** 是合法 JSON、但结构不合格(「世界.时间」为空): 校验这一关会拒掉它 */
const 结构不合格 = JSON.stringify({ 世界: { 时间: '' }, 事件: [], 小结: '坏输出标记' });

console.log('\n[2] 结构不合格一次 → 原样重试一次就成功');
{
  const p = await 准备({ 生成序列: [结构不合格, 正常输出] });
  await updateWorld(true);

  check('模型被调了两次', p.记录.raw.length, 2);
  ok('第二次请求里不再回喂「上次输出不符合要求」', !JSON.stringify(p.记录.raw[1]).includes('上次输出不符合要求'));
  ok('也不再回喂上次的坏输出片段', !JSON.stringify(p.记录.raw[1]).includes('坏输出标记'));
  ok('第二次请求与第一次完全一样(原样重发; 只有每次自动生成的 generation_id 不同)',
    JSON.stringify(p.记录.raw[1]).replace(/"generation_id":"[^"]*"/g, '') === JSON.stringify(p.记录.raw[0]).replace(/"generation_id":"[^"]*"/g, ''));
  check('重试后数据是对的', 取状态().小结, '集市散场, 小镇归于安静');
}

console.log('\n[2b] 模型输出根本不是 JSON → 当场失败, 不重试(烟火现行行为: 只对"结构不合格"回喂重试)');
{
  const p = await 准备({ 生成序列: ['我认为这个剧情应该这样发展……(整段散文)', 正常输出] });
  await updateWorld(true);

  check('只调了一次, 没有重试', p.记录.raw.length, 1);
  ok('日志页记下了失败', JSON.stringify(取日志()).includes('世界推进失败'));
  check('数据没动', 取状态().处理到楼层, 0);
}

console.log('\n[2c] 输出被接口砍断(左括号比右括号多) → 原样重推一次(2026-10-01 真机上遇到的截断)');
{
  // 从中间往后找一个"切下去确实不配平"的位置, 保证样本就是截断的样子
  const 不配平 = (t: string) => (t.match(/\{/g) ?? []).length > (t.match(/\}/g) ?? []).length;
  let 切到 = Math.floor(正常输出.length / 2);
  while (切到 < 正常输出.length && !不配平(正常输出.slice(0, 切到)))
    切到++;
  const 截断输出 = 正常输出.slice(0, 切到);
  ok('截断样本确实不配平(前提)', 不配平(截断输出));
  const p = await 准备({ 生成序列: [截断输出, 正常输出] });
  await updateWorld(true);

  check('模型被调了两次(截断不再当场失败)', p.记录.raw.length, 2);
  ok('重推时不再回喂「上次输出不符合要求」', !JSON.stringify(p.记录.raw[1]).includes('上次输出不符合要求'));
  ok('也不再带上"能切出来的那半截"', !JSON.stringify(p.记录.raw[1]).includes('夜色渐深'));
  ok('重推的请求与第一次完全一样(原样重发; 只有每次自动生成的 generation_id 不同)',
    JSON.stringify(p.记录.raw[1]).replace(/"generation_id":"[^"]*"/g, '') === JSON.stringify(p.记录.raw[0]).replace(/"generation_id":"[^"]*"/g, ''));
  check('重试后数据是对的', 取状态().小结, '集市散场, 小镇归于安静');
}

console.log('\n[3] 结构连着三次不合格 → 报错, 数据一个字段都不许动');
{
  const p = await 准备({ 生成序列: [结构不合格, 结构不合格, 结构不合格] });
  await updateWorld(true);

  check('模型被调了三次(不无限重试)', p.记录.raw.length, 3);
  check('处理到楼层没动', 取状态().处理到楼层, 0);
  check('世界时间没动', 取状态().世界.时间, '');
  check('小结没动', 取状态().小结, '');
  ok('日志页记下了失败', JSON.stringify(取日志()).includes('世界推进失败'));
  // 失败路径上状态仓的落盘链路也会摸一下楼层变量(留个空壳), 所以只断言"没有把这次的世界写进去"
  ok('失败时楼层里没有这次的世界状态', !JSON.stringify(p.floorVars).includes('集市散场'));
}

console.log('\n[4] 接口没配置 → 一次模型都不调, 数据不动');
{
  const p = await 准备({ 设置: { 接口: { 地址: '', 模型: '', 服务端转发: true }, 运转: { 读取最近回复数: 3 } } });
  await updateWorld(true);

  check('一次都没调', p.记录.raw.length, 0);
  check('处理到楼层没动', 取状态().处理到楼层, 0);
}

console.log('\n[5] 没有可分析的 AI 回复 → 一次模型都不调');
{
  const p = await 准备({ 楼层: { '1': { role: 'user', message: '只有用户楼层', is_hidden: false } } });
  await updateWorld(true);

  check('一次都没调', p.记录.raw.length, 0);
  check('处理到楼层没动', 取状态().处理到楼层, 0);
}

console.log('\n[6] 读取世界书 + 注入世界书条目: 世界书真的被读、条目真的被写');
{
  await sleep(600); // getSettings 有 500ms 缓存, 换设置前等它过期
  const p = await 准备({
    设置: {
      接口: { 地址: 'https://example.invalid/v1', 模型: 'test-model', 密钥: 'k', 最大token: 2048, 服务端转发: true },
      运转: { 读取最近回复数: 3, 读取世界书: true, 读取全局世界书: false, 注入世界书条目: true },
    },
  });
  await updateWorld(true);

  ok('读世界书时经过了接缝(读的是角色卡主世界书)', p.记录.读过的世界书.includes('测试世界书'));
  ok('角色卡主世界书里多了烟火的常驻条目', p.世界书.some((e: any) => e.name === WORLDBOOK_ENTRY_NAME));
  ok('条目内容带着这次的小结', JSON.stringify(p.世界书).includes('集市散场'));
  check('流程本身照常成功', 取状态().小结, '集市散场, 小镇归于安静');
}

console.log('\n[7] v2.5: 清单里只剩墓碑(2 已了结 / 0 进行中)时, 日志分开报, 且墓碑不再进请求体');
{
  // 墓碑不能凭空"生"出来(新事件直接以"已结束"生成会被丢弃), 所以老实地走三步:
  //   ① 先起两件事(进行) → ② 下一轮把两件都收尾(它们搬进 `已了结`) → ③ 再一轮原样带回。
  const 起步 = (阶段: string, 件: { id: string; 标题: string }[]) => JSON.stringify({
    世界: { 时间: '2025-11-15 21:30', 氛围: '夜色渐深', 总览: '小镇安静下来' },
    事件: 件.map(e => ({ id: e.id, 标题: e.标题, 阶段, 描述: 阶段 === '已结束' ? '已了结' : '正在推进' })),
    小结: 阶段 === '已结束' ? '无事' : '两件事起了',
  });
  const 两件 = [{ id: '', 标题: '盐引亏空案结案' }, { id: '', 标题: '互市重开' }];
  // 生成序列按引用传给假模型的每一次调用, 所以可以先占位、跑完一轮再按真实 id 回填
  const 序列 = [起步('进行', 两件), '', ''];
  const p = await 准备({ 生成序列: 序列 });

  await updateWorld(false); // ① 起两件
  const ids = 取状态().事件.map((e: any) => ({ id: e.id, 标题: e.标题 }));
  check('前提: 两件都起来了', ids.length, 2);
  ok('前提: 新事件拿得到脚本签发的 id', ids.every((e: any) => !!e.id));

  // ② 下一轮把两件都收尾(正文不含任何时间线索, 世界时间沿用上一轮)
  序列[1] = 起步('已结束', ids);
  p.floors['5'] = { role: 'assistant', message: '第五楼: 风停了, 街上的旗子垂下来。', is_hidden: false };
  await updateWorld(false);
  check('前提: 活跃桶清空(墓碑搬走了)', 取状态().事件, []);
  check('前提: 两件都成了墓碑', 取状态().已了结.map((e: any) => e.阶段), ['已结束', '已结束']);
  check('前提: 墓碑的标题照旧', 取状态().已了结.map((e: any) => e.标题), ['盐引亏空案结案', '互市重开']);

  // ③ 再一轮原样带回 → 这一轮的完成日志与请求体就是被观察对象
  序列[2] = 序列[1];
  p.floors['7'] = { role: 'assistant', message: '第七楼: 街上人多了些。', is_hidden: false };
  const 行: string[] = [];
  const 原info = console.info;
  console.info = (...args: any[]) => { 行.push(args.map(String).join(' ')); };
  try {
    await updateWorld(false);
  }
  finally {
    console.info = 原info;
  }

  const 完成行 = 行.filter(line => line.includes('世界推进完成'));
  check('恰好报了一行完成日志', 完成行.length, 1);
  ok('活跃与墓碑分开报', String(完成行[0] ?? '').includes('进行中 0 件 / 已了结 2 件'));
  ok('不再把墓碑报成「事件 2 件」', !String(完成行[0] ?? '').includes('事件 2 件'));
  check('模型被调了三次(每轮一次, 没有重试)', p.记录.raw.length, 3);

  // 请求体: 墓碑既不在【世界当前状态】的 JSON 里, 又在只读清单里
  const 请求 = JSON.stringify(p.记录.raw[2]);
  const 状态行 = 请求.split('\\n').find(line => line.startsWith('{\\"世界\\"')) ?? '';
  ok('墓碑不在【世界当前状态】的 JSON 里', !状态行.includes('盐引亏空案结案') && !状态行.includes('互市重开'));
  ok('墓碑只在只读清单里露面', 请求.includes('【已经了结的事(只读)】盐引亏空案结案、互市重开'));
}

console.log('\n[8] v2.8 §2: 完成日志报的是世界时钟的三态(用户原先分不清"本来就没事"与"卡住了")');
{
  // 三种形态各自的**事实**与**授权**必须一致: 跨了几天 → 事实说跨了几天 + 给大跳额度;
  // 未跨日 / 时间不可解析 → 事实如实说, 且一个字都不提"大跳"(否则请求体自相矛盾)。
  const 输出 = (时间: string, 小结 = '无事') => JSON.stringify({ 世界: { 时间, 氛围: '夜深了', 总览: '世界照常' }, 事件: [], 小结 });
  async function 观察(做: () => Promise<void>) {
    const 行: string[] = [];
    const 原info = console.info;
    console.info = (...args: any[]) => { 行.push(args.map(String).join(' ')); };
    try {
      await 做();
    }
    finally {
      console.info = 原info;
    }
    const 完成行 = 行.filter(line => line.includes('世界推进完成'));
    check('恰好一行完成日志', 完成行.length, 1);
    return String(完成行[0] ?? '');
  }

  // ① 跨日: 正文写"三天后", 世界时间跟着跨 3 天。开局那一轮单列"首次推进"
  {
    const p = await 准备({ 生成序列: [输出('2025-11-15 21:30', '起手'), 输出('2025-11-18 21:30')] });
    const 首轮 = await 观察(() => updateWorld(false));
    ok('开局第一轮: 单列"首次推进"(不是误报成"时间不可解析")', 首轮.includes('世界推进完成: 首次推进（无上轮世界时间, 不计跨日）'));
    const 首轮请求 = JSON.stringify(p.记录.raw[0]);
    ok('开局第一轮: 请求体说的是"没有上轮世界时间", 且不给大跳',
      首轮请求.includes('首次推进(没有上轮世界时间, 本轮不计跨日)') && !首轮请求.includes('大跳'));

    p.floors['5'] = { role: 'assistant', message: '第五楼: 三天后, 集市又开张了。', is_hidden: false };
    const 行 = await 观察(() => updateWorld(false));
    ok('跨日: 日志首段就是世界时钟(跨了 3 世界日)', 行.includes('世界推进完成: 跨了 3 世界日'));
    ok('跨日: 小结与两个桶照旧在后半段', 行.includes('(进行中 0 件 / 已了结 0 件, 新增 0 件)'));
    const 请求 = JSON.stringify(p.记录.raw[1]);
    ok('跨日: 请求体里的事实与授权一致(跨了 3 世界日 + 大跳额度生效)',
      请求.includes('本轮跨日(脚本算出, 与上面那份时间约束同一规则): 跨 3 世界日') && 请求.includes('时间大跳跃放宽到 4 件'));
  }

  // ② 未跨日: 正文没有时间线索, 世界时间原样沿用
  {
    const p = await 准备({ 生成序列: [输出('2025-11-15 21:30', '起手'), 输出('2025-11-15 21:30')] });
    await updateWorld(false);
    p.floors['5'] = { role: 'assistant', message: '第五楼: 街上人多了些。', is_hidden: false };
    const 行 = await 观察(() => updateWorld(false));
    ok('未跨日: 日志说"未跨日（沿用上轮日期）"', 行.includes('世界推进完成: 未跨日（沿用上轮日期）'));
    const 请求 = JSON.stringify(p.记录.raw[1]);
    ok('未跨日: 请求体给出事实, 但不给大跳额度(不自动享有)', 请求.includes('本轮跨日(脚本算出') && 请求.includes('未跨日——世界.时间的日期必须沿用上次日期') && !请求.includes('大跳'));
  }

  // ③ 古代卡: 旧世界时间"元和三年·三月初七"解析不出来 → 整条降级成纯提示, 不许报成"未推进"
  {
    const p = await 准备({ 生成序列: [输出('元和三年·三月初七', '起手'), 输出('元和三年·三月初十')] });
    await updateWorld(false);
    p.floors['5'] = { role: 'assistant', message: '第五楼: 三天后, 城门开了。', is_hidden: false };
    const 行 = await 观察(() => updateWorld(false));
    ok('古代卡: 日志落第三态"时间不可解析, 无法判定"(不落成"未推进")', 行.includes('世界推进完成: 时间不可解析, 无法判定'));
    ok('古代卡: 世界时间照旧落盘(推进本身没失败)', 取状态().世界.时间 === '元和三年·三月初十');
    const 请求 = JSON.stringify(p.记录.raw[1]);
    ok('古代卡: 请求体退回纯提示(无法判定 + 不提大跳)',
      请求.includes('无法判定(上次世界时间的日期解析不出来, 本插件不按世界日计时)') && !请求.includes('大跳'));
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0)
  process.exit(1);
