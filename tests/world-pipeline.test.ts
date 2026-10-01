// 烟火 · 世界推进主流程(候选5 的安全网) —— 用假平台 + 假模型把整条推进跑通
//
// 烟火这条流程以前一条用例都没有: 它要聊天楼层、变量表、世界书、模型接口四样东西齐备才能跑。
// 现在平台调用已经收进 host.ts(与彼方同一个形状), 测试里塞一个假宿主就能端到端驱动它:
//   成功一轮 → 世界时间/小结/事件落进状态与新楼层快照;
//   模型第一次输出坏 JSON → 带着错误原因重试一次就成功(第二次请求里能看到回喂);
//   三次都坏 → 报错, 且"处理到楼层"与旧数据一个字段都不许动;
//   接口没配置 / 没有可分析的回复 → 提前退出, 一次模型都不调;
//   读取世界书 + 注入世界书条目 → 世界书真的被读、条目真的被写(经接缝)。
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

console.log('\n[2] 结构不合格一次 → 带着错误原因重试一次就成功');
{
  const p = await 准备({ 生成序列: [结构不合格, 正常输出] });
  await updateWorld(true);

  check('模型被调了两次', p.记录.raw.length, 2);
  ok('第二次请求里回喂了「上次输出不符合要求」', JSON.stringify(p.记录.raw[1]).includes('上次输出不符合要求'));
  ok('第二次请求里说明了错在哪', JSON.stringify(p.记录.raw[1]).includes('「世界.时间」'));
  ok('第二次请求里带上了上次输出的 JSON 片段', JSON.stringify(p.记录.raw[1]).includes('坏输出标记'));
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

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0)
  process.exit(1);
