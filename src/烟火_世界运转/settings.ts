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
 */
let globalReadCache: Settings | null = null;
let globalReadTime = 0;

/** 丢掉读取缓存: 下一次 getSettings 立刻重读全局 */
function invalidateReadCache() {
  globalReadCache = null;
  globalReadTime = 0;
}

/** 用例用: 清掉读取缓存, 免得每个用例都要 sleep(500) 绕开它 */
export function resetSettingsReadCacheForTest() {
  invalidateReadCache();
}

/** 设置写入全局变量(存在服务器端): 局域网各设备共享同一份, 不随脚本导出——导出脚本不会携带接口密钥等敏感信息 */
function saveToGlobal(settings: Settings) {
  try {
    useHost().vars.update(variables => {
      variables[SETTINGS_KEY] = klona(settings);
      return variables;
    }, { type: 'global' });
    invalidateReadCache();
  } catch (error) {
    console.warn('[烟火] 保存全局设置失败:', error);
  }
}

/** 合并写回全局: 保留全局中烟火 store 里没有的顶层字段, 避免多 iframe/多设备互相覆盖时丢字段 */
function saveToGlobalMerged(settings: Settings) {
  try {
    useHost().vars.update(variables => {
      const prev = variables[SETTINGS_KEY];
      if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
        variables[SETTINGS_KEY] = { ...prev, ...klona(settings) };
      } else {
        variables[SETTINGS_KEY] = klona(settings);
      }
      return variables;
    }, { type: 'global' });
    invalidateReadCache();
  } catch (error) {
    console.warn('[烟火] 保存全局设置失败:', error);
  }
}

function loadSettings(): Settings {
  try {
    const global = useHost().vars.get({ type: 'global' })?.[SETTINGS_KEY];
    if (global && typeof global === 'object' && !Array.isArray(global)) {
      return SettingsSchema.parse(global);
    }
  } catch (error) {
    console.warn('[烟火] 读取全局设置失败:', error);
  }
  return SettingsSchema.parse({});
}

export const useSettingsStore = defineStore('yanhuo-settings', () => {
  const settings = ref<Settings>(loadSettings());
  // 设置变化时写回全局(服务器端共享)。合并写回保留全局中不存在的字段, 防多 iframe 丢数据。
  // 300ms 防抖(对齐彼方那份): 设置对象里有接口预设/模型列表这类大块数据,
  // 每敲一个键就全量 klona + 序列化写回会卡输入; 停手 300ms 再写。
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  watch(
    settings,
    value => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        saveToGlobalMerged(klona(value));
      }, 300);
    },
    { deep: true },
  );
  return { settings };
});

/**
 * 读取设置: 优先实时读全局(其他 iframe 改设置后能立即拿到最新值), 读不到时回退本地 store 那份。
 * 全局读取带 500ms 窗口——**成功与失败都算读过**, 窗口内不重复打存储; 写回会立刻让窗口失效。
 */
export function getSettings(): Settings {
  const now = Date.now();
  if (now - globalReadTime <= 500) {
    return globalReadCache ?? useSettingsStore().settings;
  }
  globalReadTime = now;
  try {
    const global = useHost().vars.get({ type: 'global' })?.[SETTINGS_KEY];
    if (global && typeof global === 'object' && !Array.isArray(global)) {
      globalReadCache = SettingsSchema.parse(global);
      return globalReadCache;
    }
  } catch (error) {
    console.warn('[烟火] 读取全局设置失败, 本次回退本地那份:', error);
  }
  globalReadCache = null;
  return useSettingsStore().settings;
}
