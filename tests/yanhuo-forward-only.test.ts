// 烟火 · 接口只走酒馆服务器转发(那个"要不要转发"的开关已删) —— 假变量表 + 假宿主 + "谁敢浏览器 fetch 就炸"的桩
//
// 以前接口有两条路: 浏览器直连(自己处理 CORS、自己写 SSE 流式解析、固定 120 秒掐超时)与
// 酒馆服务器转发, 靠设置里一个布尔开关切换。照彼方的形状删掉直连那条支路后, 转发成了唯一通路,
// 开关本身也一并删除(用户已批准)。用例钉五件事:
//   1. 老设置里残留的同名字段必须被忽略——能正常解析(不抛错)、解析结果里没有这个键,
//      接口预设里的残留同理(true / false 都不报错, 也不改变请求形状);
//   2. 取模型列表与对话都必须走宿主能力(host.model.list / host.model.raw), 全程不许出现浏览器 fetch;
//   3. 转发请求参数里没有直连残留(顶层 messages / stream / body 是直连请求体的形状, source 也不再按开关切换);
//   4. 转发路径的报错/超时文案一字未改, maskBaseUrl 也留着(update.ts 还在用);
//   5. 源码文本里三个文件已经没有这个开关字样, 直连专属的常量、端点与函数也不在了;
//      第 5 条扫 README 时只看"当前说明"那一段——末尾的「更新日志」是历史记录, 允许写明删了哪个开关。
import { createPinia, setActivePinia } from 'pinia';
import { injectHostForTest } from '../src/烟火_世界运转/host';
import { getSettings, resetSettingsReadCacheForTest } from '../src/烟火_世界运转/settings';
import { chatCompletion, fetchModelList } from '../src/烟火_世界运转/api';
import apiSource from '../src/烟火_世界运转/api.ts?raw';
import schemaSource from '../src/烟火_世界运转/schema.ts?raw';
import vueSource from '../src/烟火_世界运转/悬浮球界面.vue?raw';
import updateSource from '../src/烟火_世界运转/update.ts?raw';
import readmeSource from '../src/烟火_世界运转/README.md?raw';

const SETTINGS_KEY = '烟火_settings';

// README 分两段: 前半是"当前说明"(工作原理 / 配置 / Debug…), 末尾的「更新日志」是历史记录。
// 历史日志本来就要写明"删掉了哪个开关"——它提到旧开关是正常且必须的, 不算残留设置。
// 所以守卫只扫「更新日志」标题之前的内容: 判据本身不放松, 当前说明里留着旧开关照样判红。
// (该文件是新条目在上的倒序结构, 「更新日志」一节一直延续到文件末尾, 切掉标题及其后全部内容即可。)
const 更新日志标题 = /^#\s*更新日志\s*$/m;
function 取当前说明(readme: string): string {
  const m = 更新日志标题.exec(readme); // 无 /g, 不必操心 lastIndex
  return m ? readme.slice(0, m.index) : readme;
}

// 设置表里用到酒馆注入的 `_`(node 里没有)。直连支路删掉后, 已经没有地方再用 window 了
// ——这里特意不补 window, 万一有人把直连写法加回来, 就会当场炸出来。
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

interface 假宿主选项 {
  /** 全局变量表里的整份烟火设置(接口里可以塞残留字段, 用来验证"被忽略") */
  设置?: any;
  /** 酒馆服务器返回的模型列表 */
  模型列表?: string[];
}

/** 装假宿主 + 埋"谁敢浏览器 fetch 就炸"的桩, 返回记账本 */
function 装(选项: 假宿主选项 = {}) {
  resetSettingsReadCacheForTest(); // 清掉 500ms 读取缓存, 免得用例之间串味
  const 全局: any = { [SETTINGS_KEY]: 选项.设置 ?? {} };
  const 记录 = { list: [] as any[], raw: [] as any[], fetch次数: 0 };
  injectHostForTest({
    vars: {
      scriptId: () => 'script-1',
      get: (option: any) => (option?.type === 'global' ? 全局 : {}),
      update: (updater: any, option: any) => {
        if (option?.type === 'global') {
          全局[SETTINGS_KEY] = updater(全局) ?? 全局;
        }
        return 全局;
      },
      del: () => ({ variables: {}, delete_occurred: false }),
      insertOrAssign: () => 全局,
    },
    model: {
      list: async (请求: any) => {
        记录.list.push(请求);
        return 选项.模型列表 ?? ['m1', 'm2'];
      },
      raw: async (请求: any) => {
        记录.raw.push(请求);
        return '模型回复';
      },
      stop: () => true,
    },
  } as any);
  setActivePinia(createPinia());
  // 直连那条路已经删了: 谁再想直接请求接口, 这里当场抛错(而不是悄悄出网)
  (globalThis as any).fetch = () => {
    记录.fetch次数++;
    throw new Error('直连支路已经删掉了, 不该出现浏览器 fetch');
  };
  return { 记录 };
}

/** 一份能跑通的接口设置(残留字段各用例自己再塞) */
const 接口设置 = { 地址: 'https://api.example.com', 密钥: 'sk-测试', 模型: 'm1', 最大token: 2048 };
/** 老设置里残留的那个开关字段名(这里只当字符串用, 源码里已经不该有它) */
const 残留字段 = '服务端转发';

console.log('\n[1] 老设置里残留的同名字段: 能正常解析, 结果里没有这个键');
{
  装({ 设置: { 接口: { ...接口设置, [残留字段]: true } } });
  let 接口: any = null;
  let 错误 = '';
  try {
    接口 = getSettings().接口;
  }
  catch (error: any) {
    错误 = String(error?.message ?? error);
  }
  check('读设置不抛错', 错误, '');
  check('残留字段没有被解析进来', 接口?.[残留字段], undefined);
  check('接口里其它设置照常读到', 接口?.模型, 'm1');
  check('接口地址照常读到', 接口?.地址, 'https://api.example.com');
  check('最大token 照常读到', 接口?.最大token, 2048);
}

console.log('\n[2] 接口预设里的残留同理: 一样被忽略, 不连带整份设置读不出来');
{
  装({ 设置: { 接口: 接口设置, 接口预设: { 老预设: { ...接口设置, [残留字段]: false } } } });
  let 预设: any = null;
  let 错误 = '';
  try {
    预设 = (getSettings() as any).接口预设.老预设;
  }
  catch (error: any) {
    错误 = String(error?.message ?? error);
  }
  check('读设置不抛错', 错误, '');
  check('预设里的残留字段被忽略', 预设?.[残留字段], undefined);
  check('预设里其它字段照常读到', 预设?.模型, 'm1');
}

console.log('\n[3] 取模型列表 → 交给酒馆服务器(残留字段为 false 也一样)');
{
  const 假 = 装({ 设置: { 接口: { ...接口设置, [残留字段]: false } } });
  check('拿到的列表', await fetchModelList(), ['m1', 'm2']);
  check('问的是酒馆服务器', 假.记录.list.length, 1);
  check('地址自动补 /v1', 假.记录.list[0]?.apiurl, 'https://api.example.com/v1');
  check('带上密钥', 假.记录.list[0]?.key, 'sk-测试');
  check('没走浏览器 fetch', 假.记录.fetch次数, 0);
}

console.log('\n[4] 对话 → 交给酒馆服务器生成(最后一条 user 消息拆成 user_input)');
{
  const 假 = 装({ 设置: { 接口: { ...接口设置, [残留字段]: false } } });
  const 内容 = await chatCompletion([
    { role: 'system', content: '你是世界引擎' },
    { role: 'user', content: '推进世界' },
  ]);
  check('返回正文', 内容, '模型回复');
  check('走宿主的生成接口', 假.记录.raw.length, 1);
  const 请求: any = 假.记录.raw[0];
  check('custom_api 地址', 请求?.custom_api?.apiurl, 'https://api.example.com/v1');
  check('custom_api 模型', 请求?.custom_api?.model, 'm1');
  check('custom_api 密钥', 请求?.custom_api?.key, 'sk-测试');
  check('最后一条 user 消息作为 user_input', 请求?.user_input, '推进世界');
  check('其余消息作为 ordered_prompts', 请求?.ordered_prompts, [{ role: 'system', content: '你是世界引擎' }]);
  check('不带聊天历史(只用烟火自己的提示词)', 请求?.max_chat_history, 0);
  check('静默生成(不显示在酒馆界面上)', 请求?.should_silence, true);
  check('流式默认关', 请求?.should_stream, false);
  check('带了 generation_id', typeof 请求?.generation_id === 'string' && 请求.generation_id.startsWith('yanhuo_'), true);
  check('source 固定 openai(没有按开关切换的来源)', 请求?.custom_api?.source, 'openai');
  check('不再附自定义请求体', 请求?.custom_api?.custom_include_body, undefined);
  check('顶层没有直连请求体的 messages', 请求?.messages, undefined);
  check('顶层没有直连请求体的 stream', 请求?.stream, undefined);
  check('顶层没有直连请求体的 body', 请求?.body, undefined);
  ok('请求里没有任何 thinking 字段', !JSON.stringify(请求).includes('thinking'));
  check('max_tokens 由转发层按设置带上', 请求?.custom_api?.max_tokens, 2048);
  check('没走浏览器 fetch', 假.记录.fetch次数, 0);
}

console.log('\n[5] 残留字段为 true 与 false: 发出的请求形状完全一样(开关真的不生效了)');
{
  const 真 = 装({ 设置: { 接口: { ...接口设置, [残留字段]: true } } });
  await chatCompletion([{ role: 'user', content: '推进世界' }]);
  const 假 = 装({ 设置: { 接口: { ...接口设置, [残留字段]: false } } });
  await chatCompletion([{ role: 'user', content: '推进世界' }]);
  // generation_id 里有时间戳与随机数, 比较形状时先抹平
  const 抹平 = (请求: any) => ({ ...请求, generation_id: '(忽略)' });
  check('两次请求形状一致', 抹平(假.记录.raw[0]), 抹平(真.记录.raw[0]));
  check('两次都走了宿主', 真.记录.raw.length + 假.记录.raw.length, 2);
  check('两次都没走浏览器 fetch', 真.记录.fetch次数 + 假.记录.fetch次数, 0);
}

console.log('\n[6] 转发路径的文案一字未改, 直连专属的文案与端点已随之删除');
{
  ok('超时文案原样保留', apiSource.includes('生成超时(可能是模型思维链/推理过长或接口负载高)。调小「最大输出Token」后重试。原始错误: '));
  ok('转发失败文案原样保留', apiSource.includes('通过酒馆服务器请求失败('));
  ok('取模型列表失败文案原样保留', apiSource.includes('通过酒馆服务器获取模型列表失败, 请检查地址与密钥'));
  ok('maskBaseUrl 留着(update.ts 还在用)', /export function maskBaseUrl\(/.test(apiSource));
  ok('直连的"请求超时"文案随分支删除', !apiSource.includes("'请求超时'"));
  ok('直连的 CORS 报错文案随分支删除', !apiSource.includes('是否允许跨域(CORS)'));
  ok('直连的"获取模型列表失败("文案随分支删除', !apiSource.includes('获取模型列表失败 ('));
}

console.log('\n[7] 源码里已经没有这个开关, 直连专属的常量/端点/函数也不在了');
{
  ok('api.ts 里没有这个开关字样', !apiSource.includes(残留字段));
  ok('schema.ts 里没有这个开关字样', !schemaSource.includes(残留字段));
  ok('悬浮球界面.vue 里没有这个开关字样', !vueSource.includes(残留字段));
  ok('界面上的开关说明文字也删掉了', !vueSource.includes('接口不支持浏览器跨域(CORS)时开启'));
  ok('update.ts 的报错详情里也不再有这个字段', !updateSource.includes(残留字段));
  ok('README 的当前说明里不再提这个开关', !取当前说明(readmeSource).includes(残留字段));
  // 钉子①: 更新日志里写明"删掉了这个开关"是历史记录, 判定范围必须把它排除在外
  ok('README 更新日志里提到旧开关(历史记录)不算残留',
    !取当前说明(`- 当前: 流式 / 预填充 / 温度\n\n# 更新日志\n\n- 删掉「${残留字段}」开关\n`).includes(残留字段));
  // 钉子②: 范围只是收窄, 判据没被削弱——当前说明里留着旧开关仍要判红
  ok('README 当前说明里留着旧开关仍会被抓到',
    取当前说明(`- 当前接口清单: 流式 / 预填充 / ${残留字段}\n\n# 更新日志\n\n- 删掉「${残留字段}」开关\n`).includes(残留字段));
  ok('api.ts 里没有 REQUEST_TIMEOUT(直连专属的固定超时)', !apiSource.includes('REQUEST_TIMEOUT'));
  ok('api.ts 里没有直连的 /chat/completions 端点', !apiSource.includes('/chat/completions'));
  ok('api.ts 里没有直连的 ${base}/models 端点', !apiSource.includes('`${base}/models`'));
  ok('api.ts 里不再直接调用浏览器 fetch', !/\bfetch\s*\(/.test(apiSource));
  ok('api.ts 里没有手写 SSE 解析的残留(TextDecoder)', !apiSource.includes('TextDecoder'));
  ok('api.ts 里没有直连专属的 buildHeaders', !apiSource.includes('buildHeaders'));
  ok('api.ts 里没有直连专属的 readableError', !apiSource.includes('readableError'));
  ok('api.ts 里没有直连专属的 extractTextContent', !apiSource.includes('extractTextContent'));
  ok('api.ts 里没有直连专属的 describeEmptyContent', !apiSource.includes('describeEmptyContent'));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0)
  process.exit(1);
