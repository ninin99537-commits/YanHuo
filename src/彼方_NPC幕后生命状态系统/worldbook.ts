// 已从酒馆导出的打包产物恢复 (webpack 编译形态还原)
//
// 条目内容本身的求值(ACU 模板 <if>、EJS、酒馆宏、助手变量宏、其余语法清理)不在这里 ——
// 那约 400 行与烟火同源, 已收进 共用/条目求值.ts(候选8)。本文件只剩**读哪几本世界书、
// 排除谁、常驻名单怎么并进来**这份彼方自己的策略, 以及彼方那份诊断措辞与"空表头不算命中"。
import { isBifangEntry } from './彼方条目';
import * as vue__WEBPACK_IMPORTED_MODULE_1__ from 'vue';
import { useHost } from './host';
import { 取EJS模板环境, 组装求值上下文, 收集表格名, 求值条目文本, 重置求值缓存, type 求值环境 } from '../共用/条目求值';

/* harmony export */ 

/** 共用求值器要的平台能力与文案: 能力全部从 host 接缝接上(那个 module 自己不碰平台)。
 * 彼方现行实现与烟火有两处措辞/判定不同, 照抄彼方现状:
 *   - 表未找到用全角括号、查值失败多一句"| 数据行数: 略";
 *   - EJS 环境初始化失败要记日志(烟火静默);
 *   - 空表头不参与表头模糊匹配(烟火会命中空表头那一列)。 */
function 彼方求值环境(): 求值环境 {
    return {
        文案: {
            名字: '彼方',
            缺表: (缺失, 可用) => `[彼方] 世界书 <if cell:> 引用的表未找到: ${缺失}（可用表: ${可用 || '(无)'}）`,
            查值失败: (原因, 表名, 行名, 列名, 表头) => `[彼方] <if cell:> 查值失败(${原因}): ${表名}/${行名}/${列名}\n  该表实际表头: ${表头} | 数据行数: 略`,
            环境初始化失败: error => `[彼方] EjsTemplate(提示词模板语法插件)环境初始化失败, 世界书注入与 EJS 渲染将不可用: ${error instanceof Error ? error.message : String(error)}`,
        },
        取ACU表格: () => useHost().acu.tables(),
        准备EJS模板环境: () => useHost().ejs.prepareContext(),
        求值EJS: (text, env) => useHost().ejs.evaluate(text, env),
        EJS语法错误: text => useHost().ejs.syntaxError(text),
        展开酒馆宏: text => useHost().macros.expand(text),
        取助手变量: option => useHost().vars.get(option),
        空表头也算命中: false,
    };
}

/** 切聊天时重置缓存(表数据/模板环境随聊天不同, 两个聊天楼层号可能相同导致误用)。
 * 缓存本体在 共用/条目求值.ts 里, 这里保留原来的导出名 —— index.ts 还按这个名字调。 */
function resetWorldbookCaches() {
    重置求值缓存();
}
/**
 * 收集当前聊天激活的世界书条目内容，**直接使用酒馆主 AI 的激活机制**（EjsTemplate 环境里的
 * getWorldInfoActivatedData，与主 AI 完全一致：蓝灯常驻、绿灯关键词匹配、概率等）。
 *
 * 只读取角色卡绑定的世界书（主 + 附加）与聊天世界书，**不含全局世界书**。
 * 条目内的 ACU 模板语法会求值：<if> 条件按主 AI 规则用 ACU 表格数据求值，只保留命中分支；其余表达式/标签移除。
 *
 * @param scanText 扫描文本（最近回复等）
 * @param excludeNames 排除注入的条目名/关键词列表
 * @param alwaysIncludeNames 常驻注入的条目名/关键词列表(绕过关键词激活)
 */
async function getActiveWorldbookText(scanText, excludeNames = [], alwaysIncludeNames = []) {
    const 环境 = 彼方求值环境();
    // 排除名单: 条目名/comment 与排除项相等或包含即不注入(如填 "【彼方】NPC幕后生活" 排除该条目);
    // 名字在激活数据里可能不可靠(可能只在 comment), 故内容开头(如 "[彼方 · 幕后NPC状态]")也参与匹配
    const excludes = (excludeNames || []).map(s => String(s).trim()).filter(Boolean);
    const isExcluded = (entry) => {
        if (excludes.length === 0 || !entry)
            return false;
        const name = String(entry.name ?? '').trim();
        const comment = String(entry.comment ?? '').trim();
        const content = String(entry.content ?? '').trim();
        return excludes.some(item => {
            if (!item)
                return false;
            return name === item || comment === item
                || (name && name.includes(item)) || (comment && comment.includes(item))
                || (content && content.startsWith(item));
        });
    };
    // 常驻名单: 条目名/comment/key 相等或包含即命中, 每次都强制注入(绕过关键词激活)。
    // 角色人设条目一般按关键词触发——最新正文没提到该角色时就不会激活, 更新AI便读不到人设;
    // 常驻名单让这些人设条目始终可见。换角色卡后匹配不到则静默跳过(不报错、不警告)。
    const alwaysNames = (alwaysIncludeNames || []).map(s => String(s).trim()).filter(Boolean);
    // 注意条目字段有两种形状:
    // - getWorldbook() 返回: { name, enabled, strategy: { keys }, content }
    // - 主AI激活数据(getWorldInfoActivatedData)返回: { name/comment, disable, key, content }
    // 匹配时两种形状都要认, 否则按关键词匹配会失效。
    const isAlwaysIncluded = (entry) => {
        if (alwaysNames.length === 0 || !entry)
            return false;
        const candidates = [];
        for (const value of [entry.name, entry.comment, entry.key, entry.strategy?.keys]) {
            if (Array.isArray(value))
                candidates.push(...value.map(item => String(item)));
            else if (value !== undefined && value !== null)
                candidates.push(String(value));
        }
        return alwaysNames.some(item => item
            && candidates.some(text => text.trim() === item || (text && text.includes(item))));
    };
    /** 内容指纹: 用于激活条目与常驻条目去重(同一内容只注入一次); 用完整内容, 避免"开头120字相同"的两条被误合并 */
    const contentFingerprint = (entry) => String(entry?.content ?? '').trim();
    const names = [];
    // 没打开角色卡 / 没有聊天世界书时都是空(宿主折成空, 见 host.ts)
    const charWorldbooks = useHost().worldbook.boundNames();
    if (charWorldbooks.primary)
        names.push(charWorldbooks.primary);
    charWorldbooks.additional.forEach(name => names.push(name));
    const chatWorldbook = useHost().worldbook.chatName();
    if (chatWorldbook)
        names.push(chatWorldbook);
    // persona 绑定的世界书: 主 AI 会加载它(主角设定等常写在这里), 彼方同样需要读取
    const personaLorebook = useHost().persona.lorebook().trim();
    if (personaLorebook)
        names.push(personaLorebook);
    if (names.length === 0)
        return '';
    // EJS 模板环境提供 getWorldInfoActivatedData（主 AI 的世界书激活逻辑），同时复用于 EJS 渲染；带 30 秒缓存
    const env = await 取EJS模板环境(环境);
    if (!env || typeof env.getWorldInfoActivatedData !== 'function') {
        console.warn('[彼方] 模板环境不可用，跳过世界书注入');
        return '';
    }
    /** 彼方自己写入的常驻条目: 不把自身输出当设定(判定见 彼方条目.ts —— 名字、备注、正文开头、标记四样都认) */
    // 兼容两种条目形状的启用字段: 激活数据用 disable, getWorldbook 用 enabled(不显式启用=false 的排除)
    const acceptsEntry = (entry) => Boolean(entry && entry.disable !== true && entry.enabled !== false && entry.content && !isBifangEntry(entry) && !isExcluded(entry));
    // 1. 收集各世界书的激活条目（用酒馆主 AI 的激活机制）
    const activatedAll = [];
    {
        const seen = new Set();
        for (const name of names) {
            if (seen.has(name))
                continue;
            seen.add(name);
            let activated;
            try {
                activated = (await env.getWorldInfoActivatedData(name, scanText)) || [];
            }
            catch {
                continue;
            }
            for (const entry of activated) {
                if (acceptsEntry(entry))
                    activatedAll.push({ entry });
            }
        }
    }
    // 1.5 常驻条目: 直接按 条目名/comment/key 从绑定世界书里抓取(绕过关键词激活), 优先占用注入额度。
    // 角色人设条目通常按关键词触发——最新正文没提到该角色时就不会激活, 更新AI读不到人设;
    // 常驻名单保证这些人设条目每次都注入。换角色卡后匹配不到则静默跳过(不报错、不警告)。
    if (alwaysNames.length > 0) {
        const alwaysEntries = [];
        const seenWorldbook = new Set();
        for (const name of names) {
            if (seenWorldbook.has(name))
                continue;
            seenWorldbook.add(name);
            let entries;
            try {
                entries = (await useHost().worldbook.entries(name)) || [];
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                if (isAlwaysIncluded(entry) && acceptsEntry(entry))
                    alwaysEntries.push(entry);
            }
        }
        if (alwaysEntries.length > 0) {
            const prioritized = [];
            const seenContent = new Set();
            for (const entry of alwaysEntries) {
                const fingerprint = contentFingerprint(entry);
                if (fingerprint && seenContent.has(fingerprint))
                    continue;
                if (fingerprint)
                    seenContent.add(fingerprint);
                prioritized.push({ entry });
            }
            // 激活条目里与常驻内容重复的去重, 其余保持在常驻条目之后
            const rest = activatedAll.filter(item => !seenContent.has(contentFingerprint(item.entry)));
            activatedAll.length = 0;
            activatedAll.push(...prioritized, ...rest);
        }
    }
    // 2. 只查 <if cond="cell:..."> 用到的表，供条件求值
    const ctx = await 组装求值上下文(scanText, 收集表格名(activatedAll.map(a => a.entry.content)), 环境);
    // 3. 处理并组装条目内容（顺带提示哪些条目引用了不存在的表，方便去世界书里改错别字）
    // 不设内容/条数上限: 截断会让发给 AI 的世界书内容不完整(宁多勿缺)
    const loggedMissingTables = new Set();
    const lines = [];
    for (const { entry } of activatedAll) {
        // 条目名兼容两种形状: 激活数据在 comment/key, getWorldbook 在 name(strategy.keys)
        const label = (typeof entry.comment === 'string' && entry.comment)
            || (typeof entry.name === 'string' && entry.name)
            || (entry.key ? (Array.isArray(entry.key) ? entry.key.join('、') : String(entry.key)) : '')
            || '(未命名条目)';
        for (const table of 收集表格名([entry.content])) {
            if (!ctx.sheets.some(s => s.name === table) && !loggedMissingTables.has(table)) {
                loggedMissingTables.add(table);
                console.warn(`[彼方] 世界书条目「${label}」引用了不存在的表: ${table}，请在世界书里改成正确的表名`);
            }
        }
        const needsEjs = entry.content.includes('<%');
        const text = await 求值条目文本(entry.content, ctx, needsEjs ? env : null, label);
        if (!text.trim())
            continue;
        lines.push(text);
    }
    return lines.join('\n\n');
}
/**
 * 按 NPC 名字收集其专属的绿灯(关键词触发)条目, 用于"人设参考"注入。
 *
 * 与 getActiveWorldbookText 的区别:
 * - 后者走主 AI 激活机制, **蓝灯常驻条目无条件下发**——给所有 NPC 的都是同一份"基础世界观+蓝灯集合",
 *   人设条目(绿灯)只有正文提到该 NPC 时才激活, 失去"按 NPC 区分人设"的意义;
 * - 本函数**跳过蓝灯(vectorized/constant)**, 只收集绿灯条目中 `keys` 数组里**显式包含该 NPC 名字(或曾用名)** 的条目,
 *   保证每张 NPC 卡附的"人设参考"真的是它自己的人设, 不是基础世界观。
 *
 * @param npcName  NPC 当前名字(状态卡的键名)
 * @param alias    NPC 曾用名(可选, 改名前的旧名, 同样会参与匹配)
 * @param excludeNames 用户配置的"注入世界书排除"名单
 * @returns 渲染后的条目内容(已做 EJS/宏/<if> 求值), 多条目用 \n\n 拼接; 无命中返回空串
 */
async function getPersonaTextForNpc(npcName, alias = '', excludeNames = []) {
    const 环境 = 彼方求值环境();
    const name = String(npcName ?? '').trim();
    if (!name)
        return '';
    const aliases = [name];
    const trimmedAlias = String(alias ?? '').trim();
    if (trimmedAlias && trimmedAlias !== name)
        aliases.push(trimmedAlias);
    // 复用与 getActiveWorldbookText 一致的世界书收集范围: 角色主+附加+聊天+persona 绑定
    const names = [];
    // 没打开角色卡 / 没有聊天世界书时都是空(宿主折成空, 见 host.ts)
    const charWorldbooks = useHost().worldbook.boundNames();
    if (charWorldbooks.primary)
        names.push(charWorldbooks.primary);
    charWorldbooks.additional.forEach(n => names.push(n));
    const chatWorldbook = useHost().worldbook.chatName();
    if (chatWorldbook)
        names.push(chatWorldbook);
    const personaLorebook = useHost().persona.lorebook().trim();
    if (personaLorebook)
        names.push(personaLorebook);
    if (names.length === 0)
        return '';
    // 排除名单: 与 getActiveWorldbookText 同口径(条目名/comment/内容开头)
    const excludes = (excludeNames || []).map(s => String(s).trim()).filter(Boolean);
    const isExcluded = (entry) => {
        if (excludes.length === 0 || !entry)
            return false;
        const entryName = String(entry.name ?? '').trim();
        const comment = String(entry.comment ?? '').trim();
        const content = String(entry.content ?? '').trim();
        return excludes.some(item => item
            && (entryName === item || comment === item
                || (entryName && entryName.includes(item)) || (comment && comment.includes(item))
                || (content && content.startsWith(item))));
    };
    /** 彼方自己写入的常驻条目: 排除(否则人设参考会包含上一轮的 NPC 状态卡, 造成自我反馈); 判定见 彼方条目.ts */
    /** 关键词匹配: 条目 keys 数组里是否有任意一个 key 等于/包含 NPC 名字(或曾用名)。
     *  只对字符串 key 做匹配; RegExp key 用 .test() 测试 NPC 名。 */
    const entryMatchesNpc = (entry) => {
        if (!entry)
            return false;
        // 只认绿灯(selective)条目——蓝灯(constant)/向量化(vectorized)条目与 NPC 名字无关, 跳过
        // 注意: 兼容旧数据没有 strategy 字段的情况——按"有 keys 数组"兜底视作绿灯
        const strategyType = entry.strategy?.type;
        if (strategyType === 'constant' || strategyType === 'vectorized')
            return false;
        const keys = entry.strategy?.keys;
        if (!Array.isArray(keys) || keys.length === 0)
            return false;
        for (const key of keys) {
            for (const aliasName of aliases) {
                if (typeof key === 'string') {
                    const trimmedKey = key.trim();
                    if (trimmedKey && (trimmedKey === aliasName || trimmedKey.includes(aliasName) || aliasName.includes(trimmedKey)))
                        return true;
                }
                else if (key instanceof RegExp) {
                    try {
                        if (key.test(aliasName))
                            return true;
                    }
                    catch {
                        // 正则坏掉时跳过
                    }
                }
            }
        }
        return false;
    };
    // 收集所有命中条目
    const matched = [];
    const seenWorldbook = new Set();
    const seenContent = new Set();
    for (const wbName of names) {
        if (seenWorldbook.has(wbName))
            continue;
        seenWorldbook.add(wbName);
        let entries;
        try {
            entries = (await useHost().worldbook.entries(wbName)) || [];
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry || entry.enabled === false || !entry.content)
                continue;
            if (isBifangEntry(entry) || isExcluded(entry))
                continue;
            if (!entryMatchesNpc(entry))
                continue;
            const fingerprint = String(entry.content ?? '').trim();
            if (fingerprint && seenContent.has(fingerprint))
                continue;
            if (fingerprint)
                seenContent.add(fingerprint);
            matched.push(entry);
        }
    }
    if (matched.length === 0)
        return '';
    // EJS 环境: 与主激活一致(失败时仍能渲染基础内容)
    const env = await 取EJS模板环境(环境);
    const ctx = await 组装求值上下文('', 收集表格名(matched.map(e => e.content)), 环境);
    const lines = [];
    for (const entry of matched) {
        const label = entry.name || entry.comment || '(未命名条目)';
        const needsEjs = String(entry.content).includes('<%');
        const text = await 求值条目文本(String(entry.content), ctx, needsEjs ? env : null, label);
        if (text.trim())
            lines.push(text);
    }
    return lines.join('\n\n');
}

export { getActiveWorldbookText, getPersonaTextForNpc, resetWorldbookCaches };
