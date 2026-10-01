// 彼方 · 平台边界(host)
// ---------------------------------------------------------------------------
// 本文件是**唯一**直接命名酒馆助手全局的地方(getVariables / getChatMessages / getWorldbook …)。
//
// 为什么要有它: 业务逻辑此前内联调用平台全局 90 多处, 于是这些逻辑离开酒馆就跑不起来,
// 也就谈不上测试。现在按用途切成若干**小能力**, 每个模块只接收自己真正需要的那一两个
// (用 Pick<Host, '…'> 把需求写在签名上), 测试时传一个假实现进去即可。
// 有真有假两份实现, 这条接缝才算真的存在——只有一份实现时, 它只是"换了个名字的全局"。
//
// 约定(重要):
// - 只在**边界**构造真实宿主: index.ts(脚本入口) / 悬浮球界面.vue(界面入口) / update.ts 的收尾;
// - 纯逻辑不要在内部自己 new 宿主, 否则等于把全局换个名字继续用;
// - 流水线内部优先传**值**, 能不传宿主就不传(例如世界书文本已读出来时, 直接传字符串)。
//
// 能力是**随着模块搬迁逐个加的**, 目前收了签名已验证的四类: 变量 / 聊天 / 世界书 / 宏展开。
// 模型调用(generateRaw)、事件订阅(eventOn) 等对应模块搬迁时再补, 避免在这里写出没验证过的签名。
//
// 文件末尾的"当前宿主"(useHost)是给**签名改不动**的模块用的(快照.ts 被几十处调用);
// 能收参数的模块仍然优先把宿主收进签名, 见 worldbook-inject.ts。
// ---------------------------------------------------------------------------

import * as _toast__WEBPACK_IMPORTED_MODULE_0__ from './toast';

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

/** 宏展开: 把 {{char}} / {{user}} 这类占位符换成实际内容 */
interface HostMacros {
    /** 平台在没有聊天上下文时会抛错; 要不要兜底、要不要记日志由调用方决定(各处策略不同) */
    expand(text: string): string;
}

/** EJS 模板环境(由「提示词模板语法」插件提供; 世界书条目里的 <% %> 靠它求值) */
interface HostEjs {
    /** 准备求值上下文(会合并各楼层变量, 成本不低); 插件不可用时抛错, 日志由调用方打 */
    prepareContext(): Promise<Record<string, any>>;
    /**
     * 求值一段 EJS 模板; 插件缺失或版本不符时返回 null(调用方据此跳过该条目)。
     * 类型声明把方法名写成全小写 evaltemplate, 而插件真实导出是驼峰 evalTemplate——
     * 两种拼写都认、优先驼峰。这是"平台长什么样"的知识, 所以收在宿主里。
     */
    evaluate(text: string, env: Record<string, any>): Promise<string | null>;
    /** EJS 语法错误信息(无错误时为空串), 用于出错时的日志诊断 */
    syntaxError(text: string): Promise<string>;
}

/** 聊天楼层读取 */
interface HostChat {
    /**
     * 取楼层消息: 支持单个楼层号、'0-12' 这样的区间, 以及 role / hide_state 过滤。
     * 只取"每楼被 AI 实际使用的那一页"(不传 include_swipes)——彼方各处都是这个口径;
     * 将来若要连没被使用的消息页一起取(swipes), 得在这里显式加一个方法, 不能顺手传参。
     */
    messages(range: number | string, options?: Omit<GetChatMessagesOption, 'include_swipes'> & { include_swipes?: false }): ChatMessage[];
    lastMessageId(): number;
    /** 当前聊天 id(用来判断"是不是真的换了聊天"); 读不到时 null */
    currentChatId(): string | null;
}

/** 事件订阅: 域名只关心"发生了什么", 不关心平台把事件常量叫什么 */
interface HostEvents {
    /** 收到一条新消息 */
    onMessageReceived(listener: (messageId: number) => void): EventOnReturn;
    /** 有楼层被删除 */
    onMessageDeleted(listener: () => void): EventOnReturn;
    /** 楼层被重roll(切到另一个 swipe 页) */
    onMessageSwiped(listener: () => void): EventOnReturn;
    /** 一次生成流程执行完 */
    onGenerationAfterCommands(listener: () => void): EventOnReturn;
    /** 切换聊天 */
    onChatChanged(listener: (chatId: string) => void): EventOnReturn;
}

/** 当前角色卡 */
interface HostCharacter {
    /** 角色卡名; 没打开角色卡或读取失败时 null */
    name(): string | null;
}

/** 当前用户人设(persona): 主角设定在这里, 主 AI 看得到, 彼方以前读不到 */
interface HostPersona {
    /** 人设名; 没有时 null */
    name(): string | null;
    /** 人设描述(主角设定); 没有时空串 */
    description(): string;
    /** 人设绑定的世界书名(主角设定常写在世界书里); 没有时空串 */
    lorebook(): string;
}

/** 模型调用 */
interface HostModel {
    /** 列出某个接口下可用的模型名 */
    list(api: { apiurl: string; key?: string }): Promise<string[]>;
    /** 发一次原始请求(generateRaw): 消息由彼方自己拼, 不经过酒馆的提示词组装 */
    raw(config: GenerateRawConfig): Promise<string | GenerateToolCallResult>;
    /** 按 id 取消后台请求(generateRaw 不支持 AbortSignal, 只能这么取消) */
    stop(generationId: string): boolean;
}

/** 世界书读写(角色卡主世界书 / 聊天世界书) */
interface HostWorldbook {
    /** 当前角色卡绑定的世界书: 主世界书 + 附加的(没绑定时为空; 平台抛错也折成空) */
    boundNames(): { primary: string | null; additional: string[] };
    /** 当前聊天绑定的世界书名; 没有时为 null */
    chatName(): string | null;
    entries(name: string): Promise<WorldbookEntry[]>;
    update(name: string, updater: (entries: WorldbookEntry[]) => TypeFest.PartialDeep<WorldbookEntry>[]): Promise<void>;
    create(name: string, entries: TypeFest.PartialDeep<WorldbookEntry>[]): Promise<void>;
    /** 按判定函数删除条目(平台自带, 比自己 filter 再整体替换更安全) */
    remove(name: string, predicate: (entry: WorldbookEntry) => boolean): Promise<void>;
}

/** 用户可见提示: 只有边界该用(纯逻辑不该自己弹提示) */
interface HostToast {
    warn(text: string, title?: string): void;
    success(text: string, title?: string): void;
}

/** ACU(自动卡片更新器)的表格数据: 世界书条目里 <if cond="cell:表/行/列 >= 值"> 的条件靠它取数。
 * 它不在 @types 的 declare 清单里, 是插件挂到酒馆页面 window 上的属性 —— 放在这里,
 * 世界书求值(共用/条目求值.ts)才不会自己去摸 window.parent。 */
interface HostAcu {
    /** 全量导出表格(exportTableAsJson 的返回值); 插件没装/没就绪时 undefined, 调用方按空表处理 */
    tables(): any;
}

/** 彼方用到的平台能力集合 */
interface Host {
    vars: HostVars;
    chat: HostChat;
    events: HostEvents;
    worldbook: HostWorldbook;
    character: HostCharacter;
    persona: HostPersona;
    model: HostModel;
    macros: HostMacros;
    ejs: HostEjs;
    acu: HostAcu;
    toast: HostToast;
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
            onGenerationAfterCommands: listener => eventOn(tavern_events.GENERATION_AFTER_COMMANDS, listener),
            onChatChanged: listener => eventOn(tavern_events.CHAT_CHANGED, listener),
        },
        character: {
            name: () => {
                try {
                    return getCharData('current')?.name ?? null;
                }
                catch {
                    // 没打开角色卡
                    return null;
                }
            },
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
            lorebook: () => {
                try {
                    return String(getPersona('current')?.lorebook ?? '');
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
        worldbook: {
            // 平台在"没有绑定世界书"等情况下会抛错; 这里统一折成空, 调用方只需判空
            boundNames: () => {
                try {
                    const 绑定 = getCharWorldbookNames('current');
                    return { primary: 绑定?.primary ?? null, additional: [...(绑定?.additional ?? [])] };
                }
                catch {
                    // 没打开角色卡
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
        acu: {
            // ACU 把 API 挂在酒馆页面的 window 上(脚本跑在自己的 iframe 里, 所以要问 parent),
            // 结构由插件决定: 这里只把 exportTableAsJson 的返回值原样交出去, 怎么解析是调用方的事。
            tables: () => {
                try {
                    const api = (window.parent as any)?.AutoCardUpdaterAPI ?? (window as any).AutoCardUpdaterAPI;
                    return api?.exportTableAsJson?.();
                }
                catch {
                    // 插件未就绪 / 跨 document 读取被拒: 按"没有表格"处理
                    return undefined;
                }
            },
        },
        toast: {
            warn: (text, title) => _toast__WEBPACK_IMPORTED_MODULE_0__.toastWarning(text, title),
            success: (text, title) => _toast__WEBPACK_IMPORTED_MODULE_0__.toastSuccess(text, title),
        },
    };
}

/** 当前宿主: 被几十处调用、签名改不动的模块(快照.ts / settings.ts 这类)默认用它访问平台。
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
export type { Host, HostAcu, HostCharacter, HostChat, HostEjs, HostEvents, HostMacros, HostModel, HostPersona, HostToast, HostVars, HostWorldbook };
