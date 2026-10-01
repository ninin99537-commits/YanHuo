// 彼方 · 日志仓: 日志页要显示的三样东西, 外加把彼方自己的 console 输出接进来。
//
// - useDebugStore: 最近一次更新的请求 / 响应 / 错误 / 更新了哪些 NPC / 移除了哪些
// - useMainPromptStore: 最近一次写进世界书的幕后状态内容(与条目内容逐字相同)
// - useConsoleStore + captureConsole: 彼方自己的 console 输出(不改变原始输出, 记录失败也不影响打印)
// 依赖按实际用到的符号具名导入(形态守卫见 tests/no-bundle-artifacts.test.ts)
import { defineStore } from 'pinia';
import { ref } from 'vue';

const useDebugStore = defineStore('bifang-debug', () => {
    const log = ref(null);
    function record(partial) {
        const base = {
            time: 0,
            model: '',
            replyIds: [],
            replyPreview: '',
            updatedNpcs: [],
            removedNpcs: [],
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
/** 记录最近一次彼方写入世界书条目(供主AI及任何读取该世界书的环节读取)的幕后状态内容, 供日志页查看 */
const useMainPromptStore = defineStore('bifang-main-prompt', () => {
    const prompt = ref('');
    const time = ref(0);
    const count = ref(0);
    function record(text) {
        prompt.value = text;
        time.value = Date.now();
        count.value += 1;
    }
    return { prompt, time, count, record };
});
/** 捕获彼方脚本自身的 console 输出，让日志页可见（不再只进控制台） */
const useConsoleStore = defineStore('bifang-console', () => {
    const lines = ref([]);
    function record(type, ...args) {
        const text = args
            .map(a => {
            if (typeof a === 'string')
                return a;
            if (a instanceof Error)
                return a.stack || a.message;
            try {
                return JSON.stringify(a);
            }
            catch {
                return String(a);
            }
        })
            .join(' ');
        lines.value.push({ time: Date.now(), type, text });
        if (lines.value.length > 300)
            lines.value = lines.value.slice(-300);
    }
    function clear() {
        lines.value = [];
    }
    return { lines, record, clear };
});

/** 给彼方脚本的 console 方法挂上记录（不改变原始输出） */
function captureConsole() {
    try {
        const store = useConsoleStore();
        const types = ['log', 'warn', 'error', 'info'];
        for (const type of types) {
            const original = console[type];
            console[type] = (...args) => {
                try {
                    store.record(type, ...args);
                }
                catch {
                    // 记录失败不影响原始输出
                }
                return original.apply(console, args);
            };
        }
    }
    catch {
        // 忽略
    }
}

export { captureConsole, useConsoleStore, useDebugStore, useMainPromptStore };
