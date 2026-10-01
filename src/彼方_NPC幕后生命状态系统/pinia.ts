// 彼方 · 脚本入口(index.ts)与悬浮球界面共用的 pinia 实例: setActivePinia 激活的就是它。
// 依赖按实际用到的符号具名导入(形态守卫见 tests/no-bundle-artifacts.test.ts)。
import { createPinia } from 'pinia';

export const pinia = createPinia();
