// 烟火 · 平台边界(host)
// ---------------------------------------------------------------------------
// 本文件是**唯一**直接命名酒馆助手全局的地方(getVariables / getChatMessages / getWorldbook …)。
//
// 为什么要有它: 世界推进此前内联调用平台全局 50 多处, 于是它离开酒馆就跑不起来, 也就谈不上
// 测试。现在按用途切成若干**小能力**, 每个模块只取自己真正需要的那一两个(用 Pick<Host, '…'>
// 把需求写在签名上), 测试时传一个假实现进去即可。有真有假两份实现, 这条接缝才算真的存在。
//
// 约定(与彼方那份相同):
// - 只在**边界**构造真实宿主: index.ts(脚本入口) / 悬浮球界面(界面入口);
// - 纯逻辑不要在内部自己 new 宿主, 否则等于把全局换个名字继续用;
// - 优先传**值**, 能不传宿主就不传(例如世界书文本已读出来时, 直接传字符串)。
// ---------------------------------------------------------------------------

/** 变量表读写: 全局 / 聊天 / 楼层 / 脚本变量 */
interface HostVars {
    get(option: VariableOption): Record<string, any>;
    update(updater: (vars: Record<string, any>) => Record<string, any>, option: VariableOption): Record<string, any>;
    del(path: string, option: VariableOption): { variables: Record<string, any>; delete_occurred: boolean };
    /** 深合并写入: 只覆盖给定的那几个键, 同键的旧字段保留(update 是"整张表交给你") */
    insertOrAssign(variables: Record<string, any>, option: VariableOption): Record<string, any>;
    /** 本脚本在酒馆里的 id(读写"脚本变量"要拿它当 key) */
    scriptId(): string;
}

/** 聊天楼层读取 */
interface HostChat {
    /** 取楼层消息: 支持单个楼层号、'0-12' 这样的区间, 以及 role / hide_state 过滤 */
    messages(range: number | string, options?: Omit<GetChatMessagesOption, 'include_swipes'> & { include_swipes?: false }): ChatMessage[];
    lastMessageId(): number;
    /** 当前聊天 id(用来判断"是不是真的换了聊天"); 读不到时 null */
    currentChatId(): string | null;
}

/** 事件订阅: 域名只关心"发生了什么", 不关心平台把事件常量叫什么 */
interface HostEvents {
    onMessageReceived(listener: (messageId: number) => void): EventOnReturn;
    onMessageDeleted(listener: () => void): EventOnReturn;
    onMessageSwiped(listener: () => void): EventOnReturn;
    onChatChanged(listener: (chatId: string) => void): EventOnReturn;
}

/** 当前用户人设(persona): 主角设定在这里 */
interface HostPersona {
    /** 人设名; 没有时 null */
    name(): string | null;
    /** 人设描述(主角设定); 没有时空串 */
    description(): string;
}

/** 模型调用 */
interface HostModel {
    /** 列出某个接口下可用的模型名 */
    list(api: { apiurl: string; key?: string }): Promise<string[]>;
    /** 发一次原始请求(generateRaw): 消息由烟火自己拼, 不经过酒馆的提示词组装 */
    raw(config: GenerateRawConfig): Promise<string | GenerateToolCallResult>;
    /** 按 id 取消后台请求(generateRaw 不支持 AbortSignal, 只能这么取消) */
    stop(generationId: string): boolean;
}

/** 宏展开: 把 {{char}} / {{user}} 这类占位符换成实际内容 */
interface HostMacros {
    /** 平台在没有聊天上下文时会抛错; 要不要兜底、要不要记日志由调用方决定 */
    expand(text: string): string;
}

/** EJS 模板环境(由「提示词模板语法」插件提供; 世界书条目里的 <% %> 靠它求值) */
interface HostEjs {
    /** 准备求值上下文(会合并各楼层变量, 成本不低); 插件不可用时抛错, 日志由调用方打 */
    prepareContext(): Promise<Record<string, any>>;
    /** 求值一段 EJS 模板; 插件缺失或版本不符时返回 null(调用方据此跳过该条目) */
    evaluate(text: string, env: Record<string, any>): Promise<string | null>;
    /** EJS 语法错误信息(无错误时为空串), 用于出错时的日志诊断 */
    syntaxError(text: string): Promise<string>;
}

/** 世界书读写(角色卡主世界书 / 聊天世界书 / 全局世界书) */
interface HostWorldbook {
    /** 当前角色卡绑定的世界书: 主世界书 + 附加的(没绑定时为空; 平台抛错也折成空) */
    boundNames(): { primary: string | null; additional: string[] };
    /** 当前聊天绑定的世界书名; 没有时为 null */
    chatName(): string | null;
    /** 全局世界书名(设置里"全局"那一栏) */
    globalNames(): string[];
    entries(name: string): Promise<WorldbookEntry[]>;
    update(name: string, updater: (entries: WorldbookEntry[]) => TypeFest.PartialDeep<WorldbookEntry>[]): Promise<void>;
    create(name: string, entries: TypeFest.PartialDeep<WorldbookEntry>[]): Promise<void>;
    /** 按判定函数删除条目(平台自带, 比自己 filter 再整体替换更安全) */
    remove(name: string, predicate: (entry: WorldbookEntry) => boolean): Promise<void>;
}

/** 烟火用到的平台能力集合 */
interface Host {
    vars: HostVars;
    chat: HostChat;
    events: HostEvents;
    worldbook: HostWorldbook;
    persona: HostPersona;
    model: HostModel;
    macros: HostMacros;
    ejs: HostEjs;
}

/** 真实宿主: 酒馆助手全局在这里被包一层, 别处不再直接碰它们 */
function createTavernHost(): Host {
    return {
        vars: {
            get: option => getVariables(option),
            update: (updater, option) => updateVariablesWith(updater, option),
            del: (path, option) => deleteVariable(path, option),
            insertOrAssign: (variables, option) => insertOrAssignVariables(variables, option),
            scriptId: () => getScriptId(),
        },
        chat: {
            messages: (range, options) => getChatMessages(range, options),
            lastMessageId: () => getLastMessageId(),
            currentChatId: () => {
                try {
                    return SillyTavern.getCurrentChatId();
                }
                catch {
                    return null;
                }
            },
        },
        events: {
            onMessageReceived: listener => eventOn(tavern_events.MESSAGE_RECEIVED, listener),
            onMessageDeleted: listener => eventOn(tavern_events.MESSAGE_DELETED, listener),
            onMessageSwiped: listener => eventOn(tavern_events.MESSAGE_SWIPED, listener),
            onChatChanged: listener => eventOn(tavern_events.CHAT_CHANGED, listener),
        },
        persona: {
            name: () => {
                try {
                    return getCurrentPersonaName() ?? null;
                }
                catch {
                    return null;
                }
            },
            description: () => {
                try {
                    return String(getPersona('current')?.description ?? '');
                }
                catch {
                    return '';
                }
            },
        },
        model: {
            list: api => getModelList(api),
            raw: config => generateRaw(config),
            stop: generationId => stopGenerationById(generationId),
        },
        macros: {
            expand: text => substitudeMacros(text),
        },
        ejs: {
            prepareContext: () => EjsTemplate.prepareContext(),
            evaluate: async (text, env) => {
                // 插件真实导出是 evalTemplate(驼峰), 类型声明却写成了 evaltemplate(全小写);
                // 用错拼写会拿到 undefined, 静默失败。两种都认, 优先驼峰。
                const 插件 = EjsTemplate as unknown as { evalTemplate?: (code: string, context?: Record<string, any>) => Promise<string> };
                const evalFn = typeof 插件.evalTemplate === 'function' ? 插件.evalTemplate
                    : typeof EjsTemplate.evaltemplate === 'function' ? EjsTemplate.evaltemplate
                        : null;
                if (!evalFn)
                    return null;
                return await evalFn.call(EjsTemplate, text, env);
            },
            syntaxError: text => EjsTemplate.getSyntaxErrorInfo(text),
        },
        worldbook: {
            // 平台在"没有绑定世界书"等情况下会抛错; 这里统一折成空, 调用方只需判空
            boundNames: () => {
                try {
                    const 绑定 = getCharWorldbookNames('current');
                    return { primary: 绑定?.primary ?? null, additional: [...(绑定?.additional ?? [])] };
                }
                catch {
                    return { primary: null, additional: [] };
                }
            },
            chatName: () => {
                try {
                    return getChatWorldbookName('current') ?? null;
                }
                catch {
                    return null;
                }
            },
            globalNames: () => {
                try {
                    return [...(getGlobalWorldbookNames() ?? [])];
                }
                catch {
                    return [];
                }
            },
            entries: name => getWorldbook(name),
            update: async (name, updater) => {
                await updateWorldbookWith(name, updater);
            },
            create: async (name, entries) => {
                await createWorldbookEntries(name, entries);
            },
            remove: async (name, predicate) => {
                await deleteWorldbookEntries(name, predicate);
            },
        },
    };
}

/** 当前宿主: 被几十处调用、签名改不动的模块(state.ts / settings.ts 这类)默认用它访问平台。
 * 能收参数的模块优先把宿主收进签名 —— 这条只是给前者兜底的, 别拿它当偷懒的借口。 */
let current: Host = createTavernHost();
function useHost(): Host {
    return current;
}
/** 仅供用例: 替换平台来源(可以只给要换的那几项, 其余沿用真实能力) */
function injectHostForTest(next: Partial<Host>) {
    current = { ...current, ...next };
}

export { createTavernHost, injectHostForTest, useHost };
export type { Host, HostChat, HostEjs, HostEvents, HostMacros, HostModel, HostPersona, HostVars, HostWorldbook };
