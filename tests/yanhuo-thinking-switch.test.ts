// 烟火 · 历史残留开关「关闭思维链」已删除 —— 假变量表 + 假宿主, 直接跑源码
//
// 这个开关是历史残留(原意是让模型别思考), 已按彼方的做法删除(彼方 tests/api-host.test.ts 的 [5] 是同一件事):
// 请求固定按 OpenAI 兼容格式发出, 不再切 source、不再附自定义请求体。用例钉四件事:
//   1. 老设置里残留的 `接口.关闭思维链: true` 必须被忽略——能正常解析(不抛错), 解析结果里也没有这个键,
//      接口预设里的残留同理(以前存过的设置不能被这次删除搞成"读设置就报错");
//   2. 请求参数里不再出现 thinking / custom_include_body / source: 'custom': 转发那条路真跑一遍,
//      既看实际发出去的请求对象, 也看 api.ts 的源码文本(直连支路已随转发开关一起删除);
//   3. schema.ts / api.ts / 悬浮球界面.vue 里已经没有「关闭思维链」这个字样, README 的配置清单也清掉了
//      (README 只看"当前说明"那一段——末尾的「更新日志」是历史记录, 允许写明删了哪个开关);
//   4. 残留开关为 true 时也不改变任何请求形状(否则等于开关还在)。
// 浏览器 fetch 一律桩成"谁调谁炸"(直连支路已删除, 不该再出网), 请求体仍按源码组装。
import { createPinia, setActivePinia } from 'pinia';
import { injectHostForTest } from '../src/烟火_世界运转/host';
import { getSettings, resetSettingsReadCacheForTest } from '../src/烟火_世界运转/settings';
import { chatCompletion } from '../src/烟火_世界运转/api';
import apiSource from '../src/烟火_世界运转/api.ts?raw';
import schemaSource from '../src/烟火_世界运转/schema.ts?raw';
import vueSource from '../src/烟火_世界运转/悬浮球界面.vue?raw';
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

// 设置表里用到酒馆注入的 `_`(node 里没有); 直连分支还会用 window.setTimeout
(globalThis as any)._ = {
  clamp: (value: number, lower: number, upper: number) => Math.min(Math.max(value, lower), upper),
  cloneDeep: (value: any) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value))),
};
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
(globalThis as any).window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (timer: any) => clearTimeout(timer),
};

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

/** 假宿主: 只实现设置读取(vars)与转发分支用到的 model; fetch 由各用例自己桩 */
function 装(设置: any = {}) {
  resetSettingsReadCacheForTest(); // 清掉 500ms 读取缓存, 免得用例之间串味
  let 全局: any = { [SETTINGS_KEY]: 设置 };
  const 记录 = { raw: [] as any[], fetch: [] as any[] };
  injectHostForTest({
    vars: {
      scriptId: () => 'script-1',
      get: (option: any) => (option?.type === 'global' ? 全局 : {}),
      update: (updater: any, option: any) => {
        if (option?.type === 'global')
          全局 = updater(全局) ?? 全局;
        return 全局;
      },
      del: () => ({ variables: {}, delete_occurred: false }),
      insertOrAssign: () => 全局,
    },
    model: {
      list: async () => ['m1'],
      raw: async (请求: any) => {
        记录.raw.push(请求);
        return '模型回复';
      },
      stop: () => true,
    },
  } as any);
  setActivePinia(createPinia());
  return { 记录, 取全局: () => 全局 };
}

console.log('\n[1] 老设置里残留的开关: 能正常解析, 结果里没有这个键');
{
  装({ 接口: { 地址: 'https://api.example.com', 密钥: 'sk-测试', 模型: 'm1', 关闭思维链: true } });
  let 接口: any = null;
  let 错误 = '';
  try {
    接口 = getSettings().接口;
  }
  catch (error: any) {
    错误 = String(error?.message ?? error);
  }
  check('读设置不抛错', 错误, '');
  check('残留的开关没有被解析进来', 接口?.关闭思维链, undefined);
  check('接口里其它设置照常读到', 接口?.模型, 'm1');
  check('接口地址照常读到', 接口?.地址, 'https://api.example.com');
}

console.log('\n[2] 接口预设里的残留同理: 一样被忽略, 不连带整份设置读不出来');
{
  装({ 接口预设: { 老预设: { 地址: 'https://p.example.com', 密钥: 'k', 模型: 'p1', 关闭思维链: true } } });
  let 预设: any = null;
  let 错误 = '';
  try {
    预设 = (getSettings() as any).接口预设.老预设;
  }
  catch (error: any) {
    错误 = String(error?.message ?? error);
  }
  check('读设置不抛错', 错误, '');
  check('预设里的残留开关也被忽略', 预设?.关闭思维链, undefined);
  check('预设里其它字段照常读到', 预设?.模型, 'p1');
}

console.log('\n[3] 转发路径: source 固定 openai, 不再附自定义请求体(残留开关为 true 也一样)');
{
  const 假 = 装({ 接口: { 地址: 'https://api.example.com', 密钥: 'sk-测试', 模型: 'm1', 服务端转发: true, 关闭思维链: true } });
  const 内容 = await chatCompletion([{ role: 'system', content: '你是世界引擎' }, { role: 'user', content: '推进世界' }]);
  check('返回正文', 内容, '模型回复');
  const 请求: any = 假.记录.raw[0];
  check('source 固定 openai', 请求.custom_api.source, 'openai');
  check('不再附自定义请求体', 请求.custom_api.custom_include_body, undefined);
  ok('整个请求里没有 thinking 字段', !JSON.stringify(请求).includes('thinking'));
  check('请求照常发给接口地址', 请求.custom_api.apiurl, 'https://api.example.com/v1');
  check('最后一条 user 消息照常作为 user_input', 请求.user_input, '推进世界');
}

console.log('\n[4] 直连那条路已经删掉: 残留开关为 false 也不许出现浏览器 fetch');
{
  // 这一格原先是"直连路径: 请求体里也没有 thinking"。直连支路与那个转发开关一起删除后, 浏览器
  // fetch 不该再被用到(开关为 false 也一样——字段已由 schema 忽略), 所以这里改成: 谁调 fetch 就
  // 当场炸, 并断言请求仍由酒馆服务器转发。关闭思维链那件事的断言原样保留。
  const 假 = 装({ 接口: { 地址: 'https://api.example.com', 密钥: 'sk-测试', 模型: 'm1', 服务端转发: false, 关闭思维链: true } });
  (globalThis as any).fetch = () => {
    假.记录.fetch.push({ url: '不该出现' });
    throw new Error('直连支路已经删掉了, 不该出现浏览器 fetch');
  };
  const 内容 = await chatCompletion([{ role: 'user', content: '推进世界' }]);
  check('返回正文', 内容, '模型回复');
  check('照常发给接口地址', 假.记录.raw[0].custom_api.apiurl, 'https://api.example.com/v1');
  check('请求里没有 thinking', 假.记录.raw[0].custom_api.thinking, undefined);
  check('模型照常带上', 假.记录.raw[0].custom_api.model, 'm1');
  check('没走浏览器 fetch', 假.记录.fetch.length, 0);
}

console.log('\n[5] 源码里已经没有这个开关(请求参数 / 设置表 / 界面 / README)');
{
  ok('api.ts 里没有思维链注入参数', !/thinking|custom_include_body/i.test(apiSource));
  ok('api.ts 里没有 custom 源', !apiSource.includes("'custom'"));
  ok('api.ts 里没有「关闭思维链」字样', !apiSource.includes('关闭思维链'));
  ok('schema.ts 里没有「关闭思维链」字样', !schemaSource.includes('关闭思维链'));
  ok('悬浮球界面.vue 里没有「关闭思维链」字样', !vueSource.includes('关闭思维链'));
  ok('界面上那行开关说明文字也删掉了', !vueSource.includes('关闭模型思维链'));
  ok('README 的当前说明里没有「关闭思维链」', !取当前说明(readmeSource).includes('关闭思维链'));
  // 钉子①: 更新日志里写明"删掉了这个开关"是历史记录, 判定范围必须把它排除在外
  ok('README 更新日志里提到旧开关(历史记录)不算残留',
    !取当前说明(`- 当前接口清单: 流式 / 预填充 / 温度\n\n# 更新日志\n\n- 删掉「关闭思维链」开关\n`).includes('关闭思维链'));
  // 钉子②: 范围只是收窄, 判据没被削弱——当前说明里留着旧开关仍要判红
  ok('README 当前说明里留着「关闭思维链」仍会被抓到',
    取当前说明(`- 当前接口清单: 流式 / 预填充 / 关闭思维链\n\n# 更新日志\n\n- 删掉「关闭思维链」开关\n`).includes('关闭思维链'));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0)
  process.exit(1);
