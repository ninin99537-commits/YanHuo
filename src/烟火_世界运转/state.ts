import { defineStore } from 'pinia';
import { ref } from 'vue';
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
} from './保存世界状态';
import type { WorldData, WorldInfo } from './schema';

// ---------------------------------------------------------------------------
// 世界状态的存储细节(怎么落盘 / 怎么读回 / 旧格式怎么迁移 / 怎么清空 / 重推的顺序)已整段搬进
// ./保存世界状态.ts(候选 3)。以前 state.ts 既是"存储层"又是"响应式仓", 于是"世界状态是怎么存的"
// 要跨文件把注释与调用点拼起来看; 现在这里只剩: 常量、日志/中断仓、界面要的那份响应式副本
// (useStateStore), 以及交给其它模块的辅助函数。
//
// 存储函数仍旧从这里原样转出去(见下面的 export): 界面 / 世界数据变更.ts / index.ts 与用例都是
// 从 state 取它们, 签名与语义一个字都没变 —— 尤其 saveData 仍返回"是否真的写进了楼层"。
// ---------------------------------------------------------------------------

/** 烟火写入角色卡主世界书的常驻条目名(用于识别、更新与排除)。
 * 注意: 数据库脚本(ACU)剧情推进会屏蔽名字含"状态/规则/变量/检定/叙事"等关键词的条目, 条目名必须避开这些词 */
export const WORLDBOOK_ENTRY_NAME = '【烟火】世界动向';
/** 悬浮球位置/主题等界面偏好(全局变量键) */
export const UI_KEY = '烟火_界面';
/** 事件清单与势力清单的容量上限 */
export const EVENT_LIMIT = 30;
/** 已结束事件的保留条数(超出后丢最旧的): 注入只发未结束事件, 但面板与快照会被旧事件越拖越长 */
export const ENDED_EVENT_LIMIT = 6;
/** 五层常驻档案(地域/大势/伏笔/节令/指标)与势力的容量上限现在只在 世界字段表.ts 里写一处(候选 4),
 *  这里原样转出去给原有调用方(世界数据.ts / 世界数据变更.ts / prompts.ts / 用例都从 state 取) */
export { FACTION_LIMIT, METRIC_LIMIT, OCCASION_LIMIT, REGION_LIMIT, SEED_LIMIT, TREND_LIMIT } from './世界字段表';
/** 世界状态的存储接口(候选 3): 实现在 ./保存世界状态.ts, 这里原样转出去, 既有调用方一行都不用改。
 *  转的是同一批函数对象本身(不是包一层), 所以"建世界数据环境().保存 === saveData"这类身份断言照旧成立。 */
export { clearAllData, DATA_VERSION, discardSnapshotAt, emptyData, EVENT_HISTORY_LIMIT, loadData, saveData, SNAPSHOT_LIMIT, STORAGE_KEY, writeStateSnapshot };

// ---------------------------------------------------------------------------
// Pinia stores
// ---------------------------------------------------------------------------

export const useStateStore = defineStore('yanhuo-state', () => {
  const data = ref<WorldData>(loadData());
  function reload() {
    data.value = loadData();
  }
  function save() {
    saveData(data.value);
  }
  return { data, reload, save };
});

export interface DebugLog {
  time: number;
  model: string;
  replyIds: number[];
  replyPreview: string;
  addedEvents: string[];
  updatedEvents: string[];
  removedEvents: string[];
  summary: string;
  request: string;
  response: string;
  error: string;
}

export const useDebugStore = defineStore('yanhuo-debug', () => {
  const log = ref<DebugLog | null>(null);
  function record(partial: Partial<DebugLog>) {
    const base = {
      time: 0,
      model: '',
      replyIds: [] as number[],
      replyPreview: '',
      addedEvents: [] as string[],
      updatedEvents: [] as string[],
      removedEvents: [] as string[],
      summary: '',
      request: '',
      response: '',
      error: '',
    };
    log.value = { ...base, ...(log.value ?? {}), ...partial, time: partial.time ?? Date.now() };
  }
  function clear() {
    log.value = null;
  }
  return { log, record, clear };
});

/** 捕获烟火脚本自身的 console 输出, 让日志页可见(不再只进控制台) */
export const useConsoleStore = defineStore('yanhuo-console', () => {
  const lines = ref<{ time: number; type: string; text: string }[]>([]);
  function record(type: string, ...args: unknown[]) {
    const text = args
      .map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    lines.value.push({ time: Date.now(), type, text });
    if (lines.value.length > 300) lines.value = lines.value.slice(-300);
  }
  function clear() {
    lines.value = [];
  }
  return { lines, record, clear };
});

/** 给烟火脚本的 console 方法挂上记录(不改变原始输出) */
export function captureConsole() {
  try {
    const store = useConsoleStore();
    const types = ['log', 'warn', 'error', 'info'] as const;
    for (const type of types) {
      const original = console[type];
      console[type] = (...args: unknown[]) => {
        try {
          store.record(type, ...args);
        } catch {
          // 记录失败不影响原始输出
        }
        return original.apply(console, args);
      };
    }
  } catch {
    // 忽略
  }
}

/** 烟火后台任务状态与中断控制(供界面显示弹窗、取消请求) */
export const useUpdatingStore = defineStore('yanhuo-updating', () => {
  const active = ref(false);
  const message = ref('');
  const controller = ref<AbortController | null>(null);
  function start(text: string): AbortSignal {
    const abort = new AbortController();
    if (controller.value) controller.value.abort();
    controller.value = abort;
    active.value = true;
    message.value = text;
    return abort.signal;
  }
  function cancel() {
    controller.value?.abort();
  }
  function stop() {
    controller.value = null;
    active.value = false;
    message.value = '';
  }
  return { active, message, start, cancel, stop };
});

// ---------------------------------------------------------------------------
// 世界信息辅助
// ---------------------------------------------------------------------------

export function emptyWorldInfo(): WorldInfo {
  return { 时间: '', 氛围: '', 总览: '' };
}
