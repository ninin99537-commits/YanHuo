// 彼方 · 任务中断登记表: 正在进行中的后台任务(任务名 → 各自的 AbortController)。
//
// 支持多个任务并发: 每个任务独立中断, 互不干扰。界面的"更新中"弹窗与取消按钮都读它;
// update.ts 用它避免"自动重试"在解析进行中重复请求/误中断。
// 依赖按实际用到的符号具名导入(形态守卫见 tests/no-bundle-artifacts.test.ts)
import { defineStore } from 'pinia';
import { ref } from 'vue';

/** 彼方后台任务状态与中断控制（供界面显示弹窗、取消请求）。支持多个任务并发: 每个任务独立中断, 互不干扰。 */
const useUpdatingStore = defineStore('bifang-updating', () => {
    const active = ref(false);
    const message = ref('');
    /** 进行中的任务: 任务名 → 独立的 AbortController(各自可独立取消, 不会误中断其他任务) */
    const tasks = new Map();
    const DEFAULT_TASK = '幕后';
    function start(text, taskName) {
        const name = taskName || text || DEFAULT_TASK;
        const controller = new AbortController();
        // 同一任务重复启动时, 先取消旧的(如用户多次点重新渲染)
        const existing = tasks.get(name);
        if (existing)
            existing.abort();
        tasks.set(name, controller);
        refresh();
        return controller.signal;
    }
    function cancel(taskName) {
        if (taskName) {
            tasks.get(taskName)?.abort();
        }
        else {
            // 兼容旧调用: 取消全部
            tasks.forEach(c => c.abort());
        }
    }
    function stop(taskName) {
        if (taskName) {
            tasks.delete(taskName);
        }
        else {
            // 兼容旧调用: 清空全部(旧的 updatingStore.stop() 语义)
            tasks.clear();
        }
        refresh();
    }
    function refresh() {
        if (tasks.size === 0) {
            active.value = false;
            message.value = '';
        }
        else {
            active.value = true;
            message.value = [...tasks.keys()].join(' + ');
        }
    }
    /** 指定任务是否还在进行(用于避免"自动重试"在解析进行中重复请求/误中断) */
    function isActive(taskName) {
        return taskName ? tasks.has(taskName) : tasks.size > 0;
    }
    return { active, message, start, cancel, stop, isActive, tasks };
});

export { useUpdatingStore };
