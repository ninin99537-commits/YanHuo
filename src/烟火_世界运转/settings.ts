import { klona } from 'klona';
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { useHost } from './host';
import { SettingsSchema, type Settings } from './schema';

const SETTINGS_KEY = '烟火_settings';

/**
 * 全局设置的读取缓存(模块级)。
 * 语义只有两条: **写回即失效**(改完设置马上生效)、**读失败即失效**(不拿旧值充当前值)。
 * 这两条以前都没有——旧写法只在"读成功"时更新缓存与时间, 失败时既不更新时间也不清缓存,
 * 于是全局一旦被清空或读取抛错, 上一次的设置会被一直当成最新值返回
 * (多设备下表现为: 你在别处关掉开关/换了模型, 这台设备照旧用陈旧值, 只有刷新页面才恢复),
 * 而失败期间每次调用还要再打一遍全局存储。
 *
 * ⚠️ 它只是**读取**缓存, 与写回基线无关: 读到的值绝不自动变成"用户改了什么"的依据。
 */
let globalReadCache: Settings | null = null;
let globalReadTime = 0;

/** 丢掉读取缓存: 下一次 getSettings 立刻重读全局 */
function invalidateReadCache() {
  globalReadCache = null;
  globalReadTime = 0;
}

/** 用例用: 清掉读取缓存(写回基线跟着 store 走, 换 pinia 就是新的一份) */
export function resetSettingsReadCacheForTest() {
  invalidateReadCache();
}

function 是普通对象(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 两份叶子是否等同(数组按整体比) */
function 同一份(左: any, 右: any): boolean {
  try {
    return JSON.stringify(左) === JSON.stringify(右);
  } catch {
    return 左 === 右;
  }
}

/**
 * 深合并: `prev` 里**本次没提到的子字段**必须原样保留。
 * 旧实现 `{ ...prev, ...settings }` 是**浅合并** —— `接口`/`运转` 都是顶层键, 于是整个对象被内存里
 * 那份(可能陈旧/残缺)覆盖, 地址与密钥一起没了。数组不按元素合并, 当作**一个整体字段**替换。
 */
function 深合并(prev: any, next: any): any {
  if (!是普通对象(prev) || !是普通对象(next)) return klona(next);
  const 结果: Record<string, any> = klona(prev);
  for (const [键, 值] of Object.entries(next)) {
    if (值 === undefined) continue; // undefined = 本次不涉及, 别拿它去清存储里的值
    结果[键] = 是普通对象(结果[键]) && 是普通对象(值) ? 深合并(结果[键], 值) : klona(值);
  }
  return 结果;
}

/**
 * 相对写回基线的差异: 只收集**真正改动过的叶子字段**(递归)。
 * 另外单独收集"基线里有、现在没了"的键路径(`删`) —— 面板会 `delete 接口预设[名字]`,
 * 深合并表达不了删除, 得按路径真删。无变化 → {有:false, 删:[]}。
 */
function 取差异(基线: any, 当前: any, 路径: string[] = []): { 有: boolean; 值: any; 删: string[][] } {
  if (当前 === undefined) return { 有: false, 值: undefined, 删: [] };
  if (是普通对象(基线) && 是普通对象(当前)) {
    const 差: Record<string, any> = {};
    const 删: string[][] = [];
    let 有 = false;
    for (const [键, 值] of Object.entries(当前)) {
      const 子 = 取差异(基线[键], 值, [...路径, 键]);
      if (子.有) {
        差[键] = 子.值;
        有 = true;
      }
      if (子.删.length)
        删.push(...子.删);
    }
    for (const 键 of Object.keys(基线)) {
      if (键 in 当前 || 基线[键] === undefined)
        continue;
      删.push([...路径, 键]);
      有 = true;
    }
    return { 有, 值: 差, 删 };
  }
  return { 有: !同一份(基线, 当前), 值: klona(当前), 删: [] };
}

/** 按路径摘掉键(写进存储与推进基线走同一套动作, 基线才不会留着已被删的键) */
function 应用删除(目标: any, 删: string[][]): any {
  for (const 路径 of 删) {
    let 节点: any = 目标;
    for (let 层 = 0; 层 < 路径.length - 1; 层++)
      节点 = 是普通对象(节点) ? 节点[路径[层]] : undefined;
    if (是普通对象(节点))
      delete 节点[路径[路径.length - 1]];
  }
  return 目标;
}

/**
 * 三方差量: 以"默认值"为底, 判断本地那片叶子到底是不是用户改的。
 *   · 本地 == 默认 → 用户没动过这片: 基线取**本地**(=默认), 写回时不会去碰存储里的真值;
 *   · 本地 != 默认 → 用户确实改了: 基线取**全局**, 于是差异里只剩用户这一片, 按当前请求最后写入。
 *
 * 只在"这个 store 从没成功读到过全局"时用一次 —— 否则"读不到时填的全默认草稿"会被当成
 * 用户改动整份灌进存储(那正是 P0-5 的另一半)。
 */
function 三方基线(默认值: any, 全局: any, 本地: any): any {
  if (是普通对象(默认值) && 是普通对象(全局) && 是普通对象(本地)) {
    const 结果: Record<string, any> = {};
    const 键集 = new Set([...Object.keys(默认值), ...Object.keys(全局), ...Object.keys(本地)]);
    for (const 键 of 键集)
      结果[键] = 三方基线(默认值[键], 全局[键], 本地[键]);
    return 结果;
  }
  return 同一份(本地, 默认值) ? klona(本地) : klona(全局);
}

/**
 * 读全局设置 —— **纯读**: 不碰写回基线、不碰闸门。
 * 四种结局必须分开, 别混成"读不到就当没配置":
 *   · 读到 → 成功;
 *   · **键确实不存在**(首次使用) → 也算成功, 设置=默认值(否则新装用户永远存不下设置);
 *   · 读取抛错 / 格式坏了 / 解析不通过 → 失败, 交一份默认值给调用方兜着(绝不因此落盘)。
 */
function 读全局设置(): { 设置: Settings; 成功: boolean } {
  let 原始: any;
  try {
    原始 = useHost().vars.get({ type: 'global' })?.[SETTINGS_KEY];
  } catch (error) {
    console.warn('[烟火] 读取全局设置失败:', error);
    return { 设置: SettingsSchema.parse({}), 成功: false };
  }
  if (原始 === undefined || 原始 === null)
    return { 设置: SettingsSchema.parse({}), 成功: true }; // 首次使用: 键还不存在
  if (!是普通对象(原始)) {
    console.warn('[烟火] 全局设置格式异常(不是对象), 已暂停写回(保留原数据, 请检查全局变量 烟火_settings):', 原始);
    return { 设置: SettingsSchema.parse({}), 成功: false };
  }
  const 解析 = SettingsSchema.safeParse(原始);
  if (!解析.success) {
    console.warn('[烟火] 全局设置解析失败, 已暂停写回(请检查/清理全局变量 烟火_settings):', 解析.error?.message);
    return { 设置: SettingsSchema.parse({}), 成功: false };
  }
  return { 设置: 解析.data, 成功: true };
}

/**
 * 一个 store 的写回状态。**每个 Pinia store 各一份**(不是模块级), 因为它代表的是
 * "**这个面板**已经读到 / 已经成功提交过的视图", 而不是"这台机器上最新的全局值":
 *   · 读取(包括 getFreshSettings 的强制重读)不推进它 —— 否则"旧面板 + 新全局"会把全局里
 *     刚换好的新接口当成"用户改动"又写回去, 正好覆盖另一窗口的成果;
 *   · 只有**成功写回**才推进它; 写失败不动, 下一次设置变化自然重试;
 *   · `基线 === null` = 这个 store 还没成功读到过全局 → 一律拒绝写回(绝不用默认值覆盖真数据)。
 */
interface 写回状态 {
  基线: Settings | null;
}

function saveToGlobalMerged(settings: Settings, 状态: 写回状态) {
  if (!状态.基线) {
    // 这个 store 创建时没读到全局。现在要写了: **先真读一次**, 再用三方差量决定哪片叶子是用户改的。
    const 读 = 读全局设置();
    if (!读.成功) {
      console.warn('[烟火] 尚未成功读到全局设置, 本次改动不落盘(防止用默认值覆盖已配置的接口地址/密钥)');
      return;
    }
    状态.基线 = 三方基线(SettingsSchema.parse({}), 读.设置, settings);
  }
  const 差 = 取差异(状态.基线, settings);
  if (!差.有) return; // 初始化/解析补默认值这类"看起来变了"的变化不落盘
  let 已写 = false;
  try {
    useHost().vars.update(variables => {
      const prev = variables[SETTINGS_KEY];
      // 存储里那份坏了: 宁可这次不写, 也不拿 {} 当底稿把它连别的字段一起清掉
      if (prev !== undefined && prev !== null && !是普通对象(prev)) {
        console.warn('[烟火] 全局设置当前不是对象, 本次写回已放弃(不会用空对象清掉存储里那份):', prev);
        return variables;
      }
      variables[SETTINGS_KEY] = 应用删除(深合并(是普通对象(prev) ? prev : {}, 差.值), 差.删);
      已写 = true;
      return variables;
    }, { type: 'global' });
  } catch (error) {
    console.warn('[烟火] 保存全局设置失败(改动留在内存里, 下次设置变化时重试):', error);
    return;
  }
  if (!已写) return; // 上面的"存储坏了"分支: 基线不动, 等存储恢复后再写
  状态.基线 = klona(应用删除(深合并(状态.基线, 差.值), 差.删));
  invalidateReadCache();
}

export const useSettingsStore = defineStore('yanhuo-settings', () => {
  const 初读 = 读全局设置();
  const settings = ref<Settings>(初读.设置);
  const 写回: 写回状态 = { 基线: 初读.成功 ? klona(初读.设置) : null };
  // 设置变化时写回全局(服务器端共享)。写回按**基线差异**做: 只动用户真正改过的叶子字段,
  // 另一窗口/另一设备刚改的其它字段原样保留(浅合并会整块覆盖 `接口`, 那就是 P0-5)。
  // 300ms 防抖(对齐彼方那份): 设置对象里有接口预设/模型列表这类大块数据,
  // 每敲一个键就全量 klona + 序列化写回会卡输入; 停手 300ms 再写。
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  watch(
    settings,
    value => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        // 状态显式传进去: 写回的永远是**这个 store** 的基线, 不去猜"当前活动的是哪个 pinia"
        saveToGlobalMerged(klona(value), 写回);
      }, 300);
    },
    { deep: true },
  );
  return { settings, 写回 };
});

/**
 * 读取设置: 优先实时读全局(其他 iframe 改设置后能立即拿到最新值), 读不到时回退本地 store 那份。
 * 全局读取带 500ms 窗口——成功与失败都算读过, 窗口内不重复打存储; 写回会立刻让窗口失效。
 * **只读**: 读失败只回退, 不影响写回基线(回退的那份不会被当成"最新全局"写回去)。
 */
export function getSettings(): Settings {
  const now = Date.now();
  if (now - globalReadTime <= 500) {
    return globalReadCache ?? useSettingsStore().settings;
  }
  globalReadTime = now;
  const 结果 = 读全局设置();
  if (结果.成功) {
    globalReadCache = 结果.设置;
    return 结果.设置;
  }
  console.warn('[烟火] 读取全局设置失败, 本次回退本地那份(且不会把它写回全局)');
  globalReadCache = null;
  return useSettingsStore().settings;
}

/**
 * 强制重读全局设置(**不看 500ms 窗口**), 给"提交前核对"这类闸门用。
 *
 * 与 getSettings 的区别是**语义严格**: 读不到 / 格式坏了 / 解析不过 → **直接抛错**,
 * 不拿内存里可能过期的副本冒充"我刚读到的全局"(否则提交闸门会拿旧的"启用=true"误判)。
 * 想静默回退的场合用 getSettings。
 *
 * 它只更新读取缓存: **绝不改写任何 store 的写回基线**(否则旧面板会把全局里刚换的新接口
 * 当成用户改动, 又写回旧值), 也**不做任何写入**。
 */
export function getFreshSettings(): Settings {
  const 结果 = 读全局设置();
  globalReadTime = Date.now();
  if (!结果.成功) {
    globalReadCache = null;
    throw Error('读取全局设置失败(或全局设置结构不合法), 无法确认当前配置');
  }
  globalReadCache = 结果.设置;
  return 结果.设置;
}
