import { klona } from 'klona';
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { useHost } from './host';
import { SettingsSchema, type Settings } from './schema';

const SETTINGS_KEY = '烟火_settings';

/** 设置写入全局变量(存在服务器端): 局域网各设备共享同一份, 不随脚本导出——导出脚本不会携带接口密钥等敏感信息 */
function saveToGlobal(settings: Settings) {
  try {
    useHost().vars.update(variables => {
      variables[SETTINGS_KEY] = klona(settings);
      return variables;
    }, { type: 'global' });
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
  // 设置变化时写回全局(服务器端共享)。合并写回保留全局中不存在的字段, 防多 iframe 丢数据
  watch(
    settings,
    value => {
      saveToGlobalMerged(klona(value));
    },
    { deep: true },
  );
  return { settings };
});

/**
 * 读取设置: 优先实时读全局(其他 iframe 改设置后能立即拿到最新值), 读失败回退 store 缓存。
 * 全局读取带 500ms 缓存。
 */
let globalReadCache: Settings | null = null;
let globalReadTime = 0;
export function getSettings(): Settings {
  try {
    const now = Date.now();
    if (!globalReadCache || now - globalReadTime > 500) {
      const global = useHost().vars.get({ type: 'global' })?.[SETTINGS_KEY];
      if (global && typeof global === 'object' && !Array.isArray(global)) {
        globalReadCache = SettingsSchema.parse(global);
        globalReadTime = now;
      }
    }
    if (globalReadCache) return globalReadCache;
  } catch {
    // 全局读取失败, 回退 store
  }
  return useSettingsStore().settings;
}
