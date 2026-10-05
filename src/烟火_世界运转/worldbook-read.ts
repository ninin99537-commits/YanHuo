/**
 * 收集当前聊天激活的世界书条目内容, **直接使用酒馆主 AI 的激活机制**(EjsTemplate 环境里的
 * getWorldInfoActivatedData, 与主 AI 完全一致: 蓝灯常驻、绿灯关键词匹配、概率等)——
 * 主 AI 读到什么, 世界引擎就读到什么; 主 AI 匹配不到的条目, 世界引擎也读不到。
 *
 * 默认只读角色卡绑定世界书(主 + 附加)与聊天世界书; 全局世界书由设置开关控制(默认关)。
 * 烟火自己写入的条目自动排除; 彼方等其它条目照常读取(它们也是世界的一部分)。
 *
 * 条目内容本身的求值(ACU 模板 <if>、EJS、酒馆宏、助手变量宏、其余语法清理)不在这里 ——
 * 那约 400 行与彼方同源, 已收进 共用/条目求值.ts, 这里只剩**读哪几本世界书、排除谁**这份策略,
 * 以及两份现行实现不一致的那点措辞与"空表头算不算命中"(见 烟火求值环境)。
 */

import { useHost } from './host';
import { 取EJS模板环境, 组装求值上下文, 收集表格名, 求值条目文本, type 求值环境 } from '../共用/条目求值';

/** 自动排除的世界书条目特征(名字/内容开头): 仅烟火自己写入的条目——不把自身输出当设定。
 * 彼方等其它插件的条目不排除: 它们也是世界的一部分, 与主 AI 读到的保持一致。
 * 「【主线·本幕】」是主线条目(主线条目.ts): 它写的是**作者视角的戏骨架**, 不是世界动向 ——
 * 不排除的话, 烟火下一轮会把这段"戏的骨架"当成世界线读进世界引擎, 污染它的推演。
 * 这份名单只认"名字/comment/内容开头"; 条目被用户改名后就匹配不上了, 所以 isExcluded 还有一条
 * **写入时打的记号**(extra.yanhuo / extra.主线, 见 inject.ts 与 主线条目.ts)作兜底。 */
const SELF_EXCLUDE_MARKS = ['【烟火】世界动向', '[烟火 · 世界动向]', '【主线·本幕】'];

/** 共用求值器要的平台能力与文案: 能力全部从 host 接缝接上(那个 module 自己不碰平台) */
function 烟火求值环境(): 求值环境 {
    return {
        文案: {
            名字: '烟火',
            // 下面两条诊断措辞(半角括号、没有"数据行数"后缀)与"EJS 环境初始化失败不说"
            // 都是烟火现行行为, 照抄; 与彼方那份不同, 不在这里统一。
            缺表: (缺失, 可用) => `[烟火] 世界书 <if cell:> 引用的表未找到: ${缺失}(可用表: ${可用 || '(无)'})`,
            查值失败: (原因, 表名, 行名, 列名, 表头) => `[烟火] <if cell:> 查值失败(${原因}): ${表名}/${行名}/${列名}\n  该表实际表头: ${表头}`,
            环境初始化失败: () => null,
        },
        取ACU表格: () => useHost().acu.tables(),
        准备EJS模板环境: () => useHost().ejs.prepareContext(),
        求值EJS: (text, env) => useHost().ejs.evaluate(text, env),
        EJS语法错误: text => useHost().ejs.syntaxError(text),
        展开酒馆宏: text => useHost().macros.expand(text),
        取助手变量: option => useHost().vars.get(option),
        // 烟火现行实现里空表头会让 `列名.includes('')` 恒真(命中第 0 列), 彼方那份多了个 `h &&` 不会;
        // 两份本来就不一致, 照抄现状 —— 不在这里顺手统一。
        空表头也算命中: true,
    };
}

export interface WorldbookReadOptions {
    excludeNames?: string[];
    includeGlobal?: boolean;
}

export async function getActiveWorldbookText(scanText: string, options: WorldbookReadOptions = {}): Promise<string> {
    const 环境 = 烟火求值环境();
    // 排除名单: 条目名/comment 与排除项相等或包含即不读;
    // 名字在激活数据里可能不可靠(可能只在 comment), 故内容开头(如 "[烟火 · 世界动向]")也参与匹配
    const excludes = [...(options.excludeNames ?? []), ...SELF_EXCLUDE_MARKS].map(s => String(s).trim()).filter(Boolean);
    const isExcluded = (entry: any) => {
        if (!entry) return false;
        // 认领记号(与 主线条目.ts / inject.ts 写入时用的一致): 用户改了名字/comment/开头,
        // 按名字那一路就失效了 —— 有 extra 这一路才敢说"不管你怎么改名都排除得掉"。
        if (entry?.extra?.yanhuo === true) return true;
        if (entry?.extra?.主线 === true) return true;
        const name = String(entry.name ?? '').trim();
        const comment = String(entry.comment ?? '').trim();
        const content = String(entry.content ?? '').trim();
        return excludes.some(item => {
            if (!item) return false;
            return name === item || comment === item || (name && name.includes(item)) || (comment && comment.includes(item)) || (content && content.startsWith(item));
        });
    };
    const names: string[] = [];
    try {
        const charWorldbooks = useHost().worldbook.boundNames();
        if (charWorldbooks?.primary) names.push(charWorldbooks.primary);
        (charWorldbooks?.additional ?? []).forEach(name => names.push(name));
    } catch {
        // 未打开角色卡时忽略
    }
    try {
        const chatWorldbook = useHost().worldbook.chatName();
        if (chatWorldbook) names.push(chatWorldbook);
    } catch {
        // 无聊天世界书时忽略
    }
    if (options.includeGlobal) {
        try {
            useHost().worldbook.globalNames().forEach(name => names.push(name));
        } catch {
            // 忽略
        }
    }
    if (names.length === 0) return '';
    // EJS 模板环境提供 getWorldInfoActivatedData(主 AI 的世界书激活逻辑), 同时复用于 EJS 渲染; 带 30 秒缓存
    const env: any = await 取EJS模板环境(环境);
    if (!env || typeof env.getWorldInfoActivatedData !== 'function') {
        console.warn('[烟火] 模板环境不可用, 跳过世界书读取');
        return '';
    }
    // 1. 收集各世界书的激活条目(用酒馆主 AI 的激活机制)
    const activatedAll: any[] = [];
    {
        const seen = new Set<string>();
        for (const name of names) {
            if (seen.has(name)) continue;
            seen.add(name);
            let activated: any[];
            try {
                activated = (await env.getWorldInfoActivatedData(name, scanText)) || [];
            } catch {
                continue;
            }
            for (const entry of activated) {
                if (entry && !entry.disable && entry.content && !isExcluded(entry)) {
                    activatedAll.push(entry);
                }
            }
        }
    }
    // 2. 只查 <if cond="cell:..."> 用到的表, 供条件求值
    const ctx = await 组装求值上下文(scanText, 收集表格名(activatedAll.map(entry => entry.content)), 环境);
    // 3. 处理并组装条目内容(顺带提示哪些条目引用了不存在的表)
    const loggedMissingTables = new Set<string>();
    const lines: string[] = [];
    for (const entry of activatedAll) {
        const label = typeof entry.comment === 'string' && entry.comment ? entry.comment : entry.key ? (Array.isArray(entry.key) ? entry.key.join('、') : entry.key) : '(未命名条目)';
        for (const table of 收集表格名([entry.content])) {
            if (!ctx.sheets.some(s => s.name === table) && !loggedMissingTables.has(table)) {
                loggedMissingTables.add(table);
                console.warn(`[烟火] 世界书条目「${label}」引用了不存在的表: ${table}, 请在世界书里改成正确的表名`);
            }
        }
        const needsEjs = entry.content.includes('<%');
        const text = await 求值条目文本(entry.content, ctx, needsEjs ? env : null, label);
        if (!text.trim()) continue;
        lines.push(text);
    }
    return lines.join('\n\n');
}
