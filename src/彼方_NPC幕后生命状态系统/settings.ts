// 依赖按实际用到的符号具名导入(形态守卫见 tests/no-bundle-artifacts.test.ts)
import { z } from 'zod';
import { klona } from 'klona';
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { useHost } from './host';

/** 一套完整的接口配置(当前配置与预设共用同一结构) */
const ApiConfigSchema = z
    .object({
    地址: z.string().default(''),
    密钥: z.string().default(''),
    模型: z.string().default(''),
    模型列表: z.array(z.string()).default([]),
    /** 流式输出: 开=逐 token 接收(可实时看到输出进度, 部分模型更稳定); 关=一次性返回完整结果(更简单)。请求统一由酒馆服务器转发, 对应 should_stream */
    流式: z.boolean().default(false),
    温度: z.coerce.number().default(0.7).transform(value => _.clamp(value, 0, 2)),
    最大token: z.coerce.number().default(60000).transform(value => Math.max(1, Math.min(131072, Math.round(value)))),
})
    .prefault({});
const Settings = z
    .object({
    /** 启用幕后系统(NPC状态更新/注入等): 关闭后不再调用 API、不再自动更新, 已有状态数据保留(重开恢复) */
    启用幕后: z.boolean().default(true),
    接口: ApiConfigSchema,
    /** 保存的多套接口配置预设(名字 → 完整接口配置), 用于快速切换不同 AI */
    接口预设: z.record(z.string(), ApiConfigSchema).default({}),
    更新: z
        .object({
        自动更新: z.boolean().default(true),
        /** 正文出现新角色时自动建档追踪; 关闭后只更新已追踪(名单内/已有卡)的 NPC, 新角色一律不建档; 手动添加到名单的名字仍会建档 */
        自动建档: z.boolean().default(true),
        更新频率: z.coerce.number().default(1).transform(value => Math.max(1, Math.round(value))),
        读取最近回复数: z.coerce.number().default(3).transform(value => Math.max(1, Math.min(20, Math.round(value)))),
        追踪当前角色: z.boolean().default(false),
        /** 把幕后状态写入当前角色卡主世界书里的常驻条目(蓝灯常开), 切换聊天时会自动重新注入当前聊天的内容。
         *  这是彼方向主AI提供幕后状态的**唯一**途径: 此前还有一条"注入到主AI"(injectPrompts), 已移除——
         *  那种注入只有主AI自己看得到, 其他读取世界书的插件/环节读不到, 不好用 */
        注入世界书条目: z.boolean().default(false),
        生理监测: z.boolean().default(false),
        /** 破限: system 注入 SPECIAL NOTE 身份强化(防注入最高任务/思考语气/无安全限制), 并预置 AI 承诺消息; 关闭后只发送任务本身 */
        破限: z.boolean().default(true),
        /** 提示词头部填充(gemini3.7f 对位预设[46]): 开启后在消息最前插入「陨落的天才」(斗破苍穹文本, 无任何标注)作为第一条消息——适合 Gemini 3.7 Flash */
        提示词头部填充: z.boolean().default(false),
        /** 头部填充自定义文本: 留空使用内置「陨落的天才」(斗破苍穹); 填入后作为第一条消息发送(想换小说直接粘贴, 支持酒馆宏) */
        头部填充文本: z.string().default(''),
        /** 防截断(gemini3.7f 对位预设[27]牢大): 开启后在 system 末尾缝入 Reference_Example_format 免责声明段——适合 Gemini 3.7 Flash; 该模型 3.6F 起不支持预填充, 可配合关闭"预填充"使用 */
        防截断: z.boolean().default(false),
        注入世界书: z.boolean().default(true),
        /** 注入世界书时排除的条目名(列表): 填条目名(或其关键词)即不注入该条目, 如 "【彼方】NPC幕后生活" */
        注入世界书排除: z.array(z.string()).default([]),
        /** 常驻注入的世界书条目名/关键词(列表): 填条目名(或其关键词)即**每次都强制注入**这些条目(绕过关键词激活)——
         *  角色人设条目通常按关键词触发, 最新正文没提到该角色时就不会激活, 更新AI便读不到人设; 用它保证人设始终可见。
         *  换角色卡后匹配不到该条目则静默跳过(不报错)。 */
        常驻世界书条目: z.array(z.string()).default([]),
        /** 预填充(prefill): 在最后追加一条 assistant 消息引导模型直接从 JSON 开头开始输出, 减少格式失败/废话; 依赖模型是否支持(DeepSeek/GLM/Qwen/Claude 大多支持) */
        预填充: z.boolean().default(false),
    })
        .prefault({}),
    标签: z
        .object({
        模式: z.enum(['排除', '只读']).default('排除'),
        列表: z.array(z.string()).default(['aftertalk']),
    })
        .prefault({}),
})
    .prefault({});
const SETTINGS_KEY = '彼方_settings';
/** 旧设置迁移: gemini37f破限 单开关 → 提示词头部填充/防截断 双开关(两者继承原开关值) */
function migrateSettings(raw) {
    if (!raw || typeof raw !== 'object')
        return raw;
    const 更新 = raw.更新;
    if (更新 && typeof 更新 === 'object' && !Array.isArray(更新) && typeof 更新.gemini37f破限 === 'boolean') {
        if (更新.提示词头部填充 === undefined)
            更新.提示词头部填充 = 更新.gemini37f破限;
        if (更新.防截断 === undefined)
            更新.防截断 = 更新.gemini37f破限;
        delete 更新.gemini37f破限;
    }
    return raw;
}
/** 设置写入全局变量(存在服务器端): 局域网各设备共享同一份, 不随脚本导出, 不在脚本变量列表 */
function saveToGlobal(settings) {
    try {
        useHost().vars.update(variables => {
            variables[SETTINGS_KEY] = klona(settings);
            return variables;
        }, { type: 'global' });
        invalidateReadCache();
    }
    catch (error) {
        console.warn('[彼方] 保存全局设置失败:', error);
    }
}
/** 合并写回全局: 保留全局中彼方 store 里没有的顶层字段, 避免多 iframe/多设备互相覆盖时丢字段 */
function saveToGlobalMerged(settings) {
    try {
        useHost().vars.update(variables => {
            const prev = variables[SETTINGS_KEY];
            if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
                variables[SETTINGS_KEY] = { ...prev, ...klona(settings) };
            }
            else {
                variables[SETTINGS_KEY] = klona(settings);
            }
            return variables;
        }, { type: 'global' });
        invalidateReadCache();
    }
    catch (error) {
        console.warn('[彼方] 保存全局设置失败:', error);
    }
}
function loadSettings() {
    // 1. 优先读全局变量(服务器端共享, 局域网各设备共用)
    try {
        const global = useHost().vars.get({ type: 'global' })?.[SETTINGS_KEY];
        if (global && typeof global === 'object' && !Array.isArray(global)) {
            return Settings.parse(migrateSettings(global));
        }
    }
    catch (error) {
        console.warn('[彼方] 读取全局设置失败:', error);
    }
    // 2. 兼容 localStorage(上一版, 浏览器本地)
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
            const migrated = Settings.parse(migrateSettings(JSON.parse(raw)));
            saveToGlobal(migrated);
            return migrated;
        }
    }
    catch (error) {
        console.warn('[彼方] 读取本地设置失败:', error);
    }
    // 3. 兼容更早版本: 设置存在酒馆助手脚本变量里(含接口地址/密钥), 迁移到全局变量后清空脚本变量
    try {
        const old = useHost().vars.get({ type: 'script', script_id: useHost().vars.scriptId() });
        if (old && typeof old === 'object' && !Array.isArray(old)) {
            const migrated = Settings.parse(migrateSettings(old));
            saveToGlobal(migrated);
            useHost().vars.update(() => ({}), { type: 'script' });
            return migrated;
        }
    }
    catch (error) {
        console.warn('[彼方] 迁移旧设置失败:', error);
    }
    return Settings.parse({});
}
const useSettingsStore = defineStore('bifang-settings', () => {
    const settings = ref(loadSettings());
    // 设置变化时写回全局(服务器端共享)。注意:
    // - debounce 300ms: 设置对象含大量数据(接口预设/模型列表), 每敲一个键就全量
    //   klona+序列化写回会造成输入卡顿; 停止输入 300ms 后才真正写。
    // - 合并写回: 保留全局中彼方 store 里不存在的字段(多 iframe/多设备下防止丢字段),
    //   同名顶层字段用 store 值(用户当前看到的最新值)。
    let saveTimer = null;
    watch(settings, value => {
        if (saveTimer !== null)
            clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            saveToGlobalMerged(klona(value));
        }, 300);
    }, { deep: true });
    return { settings };
});

/**
 * 读取设置: 优先实时读全局(悬浮球/其他 iframe 改设置后, 能立即拿到最新值,
 * 避免 store 缓存旧设置不生效); 读失败回退 store 缓存。
 * 全局读取带 500ms 缓存, 避免频繁调用时反复序列化大设置; 窗口内读失败也记着(照样回退 store),
 * 设置写回后立即失效。
 * 2026-10-01 与烟火同一处缺陷: 以前缓存没有失效语义 —— 写回后 500ms 窗口里仍按旧值走,
 * 且"全局被清空/读取报错"会永久返回上一次的值, 只有刷新页面才恢复。
 */
let globalReadCache = null;
let globalReadTime = 0;
/** 写回成功后清掉读缓存 */
function invalidateReadCache() {
    globalReadCache = null;
}
function getSettings() {
    const now = Date.now();
    if (now - globalReadTime <= 500)
        return globalReadCache ?? useSettingsStore().settings;
    globalReadTime = now;
    try {
        const global = useHost().vars.get({ type: 'global' })?.[SETTINGS_KEY];
        if (global && typeof global === 'object' && !Array.isArray(global))
            globalReadCache = Settings.parse(global);
        else
            globalReadCache = null; // 全局被清空 → 回退 store, 不拿上一次的值充数
    }
    catch {
        // 全局读取失败 → 同样清缓存: 窗口内不反复摸存储, 窗口外再试
        globalReadCache = null;
    }
    return globalReadCache ?? useSettingsStore().settings;
}

export { getSettings, useSettingsStore };
