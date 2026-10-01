// 彼方 · 数据仓: 界面读写「当前状态」的那一个 pinia 仓。
//
// 它只是 快照.ts 上面薄薄一层响应式包装(loadData / saveData)。单独成文件是为了让 快照.ts
// 保持"不碰 Vue、不碰 pinia"——那一层可以脱离界面单独测。
// 依赖按实际用到的符号具名导入(形态守卫见 tests/no-bundle-artifacts.test.ts)
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { loadData, saveData } from './快照';

const useStateStore = defineStore('bifang-state', () => {
    const data = ref(loadData());
    function reload() {
        data.value = loadData();
    }
    function save() {
        saveData(data.value);
    }
    return { data, reload, save };
});

export { useStateStore };
