import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { 往返尝试 } from '../共用/模型往返';
import {
  clearAllData,
  DATA_VERSION,
  discardSnapshotAt,
  emptyData,
  loadData,
  saveData,
  SNAPSHOT_LIMIT,
  STORAGE_KEY,
  writeStateSnapshot,
} from './保存世界状态';
import type { WorldData } from './schema';

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
// 容量上限不再从这里转发: 属主是 世界字段表.ts(见那里的「容量上限」一段), 调用方直接去属主取。
// 以前这里转了一手, 于是"这个符号谁拥有"有两条 import 路径, 领域模块(世界数据.ts)也顺着
// state → 保存世界状态 这条链把 pinia 拖进了自己的依赖里。
/** 世界状态的存储接口(候选 3): 实现在 ./保存世界状态.ts, 这里原样转出去, 既有调用方一行都不用改。
 *  转的是同一批函数对象本身(不是包一层), 所以"建世界数据环境().保存 === saveData"这类身份断言照旧成立。 */
export { clearAllData, DATA_VERSION, discardSnapshotAt, emptyData, loadData, saveData, SNAPSHOT_LIMIT, STORAGE_KEY, writeStateSnapshot };

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
  /** 本轮正文时间约束, 便于日志确认烟火为何允许/拒绝某个日期 */
  timeConstraint?: string;
  addedEvents: string[];
  updatedEvents: string[];
  removedEvents: string[];
  summary: string;
  request: string;
  response: string;
  error: string;
  /** 每次尝试各留一份(含失败那次的完整原文, v2.8.5 D1): 线上失败据此回放 */
  尝试?: 往返尝试[];
  /** 这一轮是哪个版本的 bundle 跑的(v2.8.5 D2): 版本漂移事后可查 */
  版本?: string;
  /** 非失败的交代(如"用户中断了本次推进", v2.8.5 D7): 不写进 error, 免得训练人忽略报错 */
  备注?: string[];
  /** 本次独立重扫得到的完整世界书记录及来源；不代表主请求最终激活集合。 */
  输入来源?: unknown[];
  /** 模型校验、快照提交、世界书同步分别交代，不混为一个成功。 */
  提交状态?: string;
  工作事件?: string[];
  请求统计?: { 次数: number; 毫秒: number };
}

function 空记录(): DebugLog {
  return {
    time: 0,
    model: '',
    replyIds: [],
    replyPreview: '',
    addedEvents: [],
    updatedEvents: [],
    removedEvents: [],
    summary: '',
    request: '',
    response: '',
    error: '',
    尝试: [],
    版本: '',
    备注: [],
  };
}

export const useDebugStore = defineStore('yanhuo-debug', () => {
  const log = ref<DebugLog | null>(null);
  /** 同一轮里各步补记(合并) */
  function record(partial: Partial<DebugLog>) {
    log.value = { ...空记录(), ...(log.value ?? {}), ...partial, time: partial.time ?? Date.now() };
  }
  /**
   * 新一轮开始: **不与上一轮合并**。
   *
   * 以前这里也是 `record`(合并), 于是上一轮的字段会挂到这一轮头上——v2.8.5 D7 的"假红"就是这么来的:
   * 某次中断记下 `error: 推进已中断` 之后, 后面四轮明明全部落盘成功, 日志页上却轮轮都写着"推进已中断"
   * (同理, 上一轮的输出/事件/小结也会串到这一轮)。开新一轮时先把旧的一把清掉。
   */
  function 开始新记录(partial: Partial<DebugLog>) {
    log.value = { ...空记录(), ...partial, time: partial.time ?? Date.now() };
  }
  function clear() {
    log.value = null;
  }
  return { log, record, 开始新记录, clear };
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

/** 本轮推进变更标记(内存态, 供简报面板高亮「新 / 变」徽标, 零存档开销) */
export const useDiffStore = defineStore('yanhuo-diff', () => {
  const 新增事件 = ref<Set<string>>(new Set());
  const 变更事件 = ref<Set<string>>(new Set());
  const 变更组织 = ref<Set<string>>(new Set());
  const 变更地区 = ref<Set<string>>(new Set());

  function record(前: WorldData, 后: WorldData) {
    const 旧事件 = new Map((前.事件 ?? []).map(e => [e.id, e]));
    const 新建 = new Set<string>();
    const 变动 = new Set<string>();
    for (const e of 后.事件 ?? []) {
      const 旧 = 旧事件.get(e.id);
      if (!旧) {
        if (e.id) 新建.add(e.id);
      } else if (
        旧.阶段 !== e.阶段
        || 旧.描述 !== e.描述
        || 旧.时间 !== e.时间
        || (旧.演变?.length ?? 0) !== (e.演变?.length ?? 0)
      ) {
        if (e.id) 变动.add(e.id);
      }
    }
    const 旧已结束 = new Set((前.已结束 ?? []).map(e => e.id));
    for (const e of 后.已结束 ?? []) {
      if (e.id && !旧已结束.has(e.id)) 变动.add(e.id);
    }

    const 变组织 = new Set<string>();
    for (const [名, 值] of Object.entries(后.组织 ?? {})) {
      const 旧 = 前.组织?.[名];
      if (!旧 || JSON.stringify(旧) !== JSON.stringify(值)) 变组织.add(名);
    }

    const 变地区 = new Set<string>();
    for (const [名, 值] of Object.entries(后.地区 ?? {})) {
      const 旧 = 前.地区?.[名];
      if (!旧 || JSON.stringify(旧) !== JSON.stringify(值)) 变地区.add(名);
    }

    新增事件.value = 新建;
    变更事件.value = 变动;
    变更组织.value = 变组织;
    变更地区.value = 变地区;
  }

  function clear() {
    新增事件.value = new Set();
    变更事件.value = new Set();
    变更组织.value = new Set();
    变更地区.value = new Set();
  }

  return { 新增事件, 变更事件, 变更组织, 变更地区, record, clear };
});

