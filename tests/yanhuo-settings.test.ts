// 烟火 · 设置的读写与读取缓存 —— 假变量表 + 假时钟, 直接跑源码
//
// 钉住候选 6 那条真实缺陷的回归(旧写法: 只有"读成功"才更新缓存与时间, 失败时旧缓存照返):
//   1. 全局被清空 / 读取抛错 → 不能拿上一次的全局值充当前值, 要回退本地那份;
//   2. 写回之后读取立刻失效(否则"改完设置 500ms 内推进/保存仍用旧值");
//   3. 500ms 窗口内不重复打存储, 失败也一样(旧写法失败时每次调用都要再打一遍)。
// 时间用假时钟推进, 所以这里没有 sleep(500) 绕缓存; 只有防抖那条要等真实的 300ms。
import { createPinia, setActivePinia } from 'pinia';
import { injectHostForTest } from '../src/烟火_世界运转/host';
import { getSettings, resetSettingsReadCacheForTest, useSettingsStore } from '../src/烟火_世界运转/settings';

const SETTINGS_KEY = '烟火_settings';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 设置表里用到酒馆注入的 `_`(node 里没有): 给最小替身, 用到未替身的方法会明确报错
(globalThis as any)._ = {
  clamp: (value: number, lower: number, upper: number) => Math.min(Math.max(value, lower), upper),
  cloneDeep: (value: any) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value))),
};
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// 假时钟: 500ms 窗口可以用推进时间的方式跨过, 不必真的等
let 假现在 = Date.now();
Date.now = () => 假现在;

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

/** 假全局变量表: 只实现设置读取用到的 get/update */
function makeFakeVars(初始全局: any = {}) {
  const 记 = { 读全局: 0, 写全局: 0 };
  let 全局 = 初始全局;
  let 读就抛错 = false;
  const host: any = {
    vars: {
      scriptId: () => 'script-1',
      get: (option: any) => {
        if (option?.type !== 'global') return {};
        记.读全局++;
        if (读就抛错) throw new Error('全局变量表读不到');
        return 全局;
      },
      update: (updater: any, option: any) => {
        if (option?.type !== 'global') return {};
        全局 = updater(全局) ?? 全局;
        记.写全局++;
        return 全局;
      },
      del: () => ({}),
      insertOrAssign: () => ({}),
    },
  };
  return { host, 记, 取全局: () => 全局, 设全局: (v: any) => { 全局 = v; }, 设读抛错: (v: boolean) => { 读就抛错 = v; } };
}

/** 每个用例换一份变量表与一个干净的 pinia; 顺手清掉读取缓存(不必再 sleep 绕它) */
function 装(初始全局: any = {}) {
  resetSettingsReadCacheForTest();
  const 假 = makeFakeVars(初始全局);
  injectHostForTest(假.host as any);
  setActivePinia(createPinia());
  return 假;
}

console.log('\n[1] 全局里存过 → 以它为准, 没存过的字段补默认值');
{
  装({ [SETTINGS_KEY]: { 启用运转: false } });
  const s = getSettings();
  check('读到全局里的值', s.启用运转, false);
  ok('没存过的字段有默认值', typeof s.运转.注入世界书条目 === 'boolean');
}

console.log('\n[2] 500ms 窗口内: 连续读只打一次存储');
{
  const 假 = 装({ [SETTINGS_KEY]: { 启用运转: true } });
  const 一 = getSettings();
  const 前 = 假.记.读全局;
  const 二 = getSettings();
  check('两次拿到同一份', 二 === 一, true);
  check('窗口内没再打存储', 假.记.读全局 - 前, 0);
}

console.log('\n[3] 全局被清空 → 回退本地那份, 不拿旧值充当前值(旧写法会返回旧值)');
{
  const 假 = 装({ [SETTINGS_KEY]: { 启用运转: false } });
  const store = useSettingsStore();
  check('先读到全局的关闭状态', getSettings().启用运转, false);
  store.settings.启用运转 = true; // 本地那份变了(300ms 内还没写回全局)
  假.设全局({}); // 全局被清空: 别的设备清了 / 服务器那份丢了
  假现在 += 600; // 跨过 500ms 窗口
  check('全局没了 → 用本地那份', getSettings().启用运转, true);
}

console.log('\n[4] 读取抛错 → 同样回退本地那份, 且失败期间不反复打存储');
{
  const 假 = 装({ [SETTINGS_KEY]: { 启用运转: false } });
  const store = useSettingsStore();
  getSettings();
  store.settings.启用运转 = true;
  假.设读抛错(true);
  假现在 += 600;
  check('读全局抛错 → 用本地那份', getSettings().启用运转, true);
  const 前 = 假.记.读全局;
  getSettings();
  check('失败也在窗口内, 不再重复打存储', 假.记.读全局 - 前, 0);
  假现在 += 600;
  const 前2 = 假.记.读全局;
  getSettings();
  check('出了窗口会再试一次', 假.记.读全局 - 前2, 1);
}

console.log('\n[5] 写回之后读取立刻失效(旧写法在 500ms 内还会给旧值)');
{
  const 假 = 装({ [SETTINGS_KEY]: { 启用运转: false } });
  const store = useSettingsStore();
  check('先拿到旧值', getSettings().启用运转, false);
  store.settings.启用运转 = true;
  await sleep(350); // 等 300ms 防抖真的写回
  假现在 += 100; // 仍在 500ms 窗口内
  check('写回后读到新值', getSettings().启用运转, true);
  check('确实写进了全局', 假.取全局()[SETTINGS_KEY].启用运转, true);
}

console.log('\n[6] 写回带 300ms 防抖: 连改三次只写一次');
{
  const 假 = 装({ [SETTINGS_KEY]: {} });
  const store = useSettingsStore();
  check('起始没写回过', 假.记.写全局, 0);
  store.settings.启用运转 = false;
  await sleep(60);
  store.settings.启用运转 = true;
  await sleep(60);
  store.settings.运转.注入世界书条目 = false;
  await sleep(420);
  check('连改三次只写一次', 假.记.写全局, 1);
  check('写回的是最后一次的值', 假.取全局()[SETTINGS_KEY].运转.注入世界书条目, false);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0)
  process.exit(1);
