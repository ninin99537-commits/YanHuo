// 共用 · 世界书条目求值 —— 烟火与彼方各抄一份的"条目求值器", 现在只此一份
// ---------------------------------------------------------------------------
// 两家原来各有一份约 400 行的同源实现(烟火 worldbook-read.ts / 彼方 worldbook.ts):
// 条目里的 ACU 模板语法(<if cond="cell:表/行/列 >= 值"> 这类条件块、seed 关键词、嵌套与 <else>)、
// EJS 模板、酒馆宏与酒馆助手扩展变量宏的求值, 以及"其余无法求值的语法一律移除"的清理。
// 两边同源、各自演化、零覆盖 —— 正是最容易出问题的地方。现在收在这里, 两家只留
// **读世界书的范围与排除策略**(各留各家, 见两份 adapter), 求值本身改一次两边同时生效。
//
// 它不碰平台: ACU 表格数据、EJS 环境、宏展开、变量表这些平台能力, 以及两家的诊断文案,
// 都从 求值环境 参数进来(两家各自 host 接缝接上), 所以没有酒馆也能测 ——
// 用例见 tests/worldbook-eval.test.ts(同一份用例, 两份适配层各跑一遍)。
//
// 两家现行行为**本来就不一致**的两处, 这里不替人类选, 由各自的适配层声明:
//   1. 空表头算不算模糊命中: 烟火那份写 `h.includes(列名) || 列名.includes(h)`, 空表头 `''` 让
//      `列名.includes('')` 恒真 → 命中第 0 列; 彼方那份多了个 `h &&` → 空表头跳过。
//      用 空表头也算命中 声明(烟火 true / 彼方 false)。
//   2. 诊断文案: 缺表的括号、查值失败的行数后缀、EJS 环境初始化失败要不要说、条目名的取法,
//      一律照抄各自现状, 从 文案 进来(不在这里统一措辞)。
// 另外这处共用语义照抄(两家一致, 但容易看错): 只有写成 `cell:表/...`(即 cond 里)的表才会被
// 收集去取数, `<if cell="表/行/列 >= 值">` 自己引用的表不会被收集 —— 见 收集表格名。
// 剩下几处只是写法不同、语义一样(逐函数比对过), 这里统一按烟火那份写:
//   collectCellTables/findTopLevelElse 用 matchAll(彼方用 re.exec 循环)、findMatchingClose 用
//   matchAll + `index < start`(彼方用 `re.lastIndex = start`)、logCellLookupFailure 带默认参数
//   (彼方不带, 但两边调用点都传了两个实参)。
// ---------------------------------------------------------------------------

/** 一张 ACU 表格(来自 AutoCardUpdaterAPI.exportTableAsJson): 第一行是表头 */
interface 表格数据 {
    name: string;
    content: string[][];
}

/** 诊断文案: 两家措辞不同, 各自由适配层给全(不在这里改标点、不改后缀) */
interface 求值文案 {
    /** 日志与文案里的名字, 如 '烟火' / '彼方'; 日志前缀就是 `[名字]` */
    名字: string;
    /** 条目引用了 ACU 里没有的表: (缺失的表名, 可用表名) → 整条日志 */
    缺表(缺失: string, 可用: string): string;
    /** 查值失败: (原因, 表名, 行名, 列名文案, 表头文案) → 整条日志 */
    查值失败(原因: string, 表名: string, 行名: string, 列名: string, 表头: string): string;
    /** EJS 环境初始化失败: 返回 null 表示"不说"(烟火现行就是不说, 彼方要说) */
    环境初始化失败(error: unknown): string | null;
}

/** 求值需要的外部能力 —— 全部由调用方从各自的 host 接缝接进来 */
interface 求值环境 {
    文案: 求值文案;
    /** ACU 表格全量导出(exportTableAsJson 的返回值); 插件未就绪时 undefined, 按空表处理 */
    取ACU表格(): any;
    /** EJS 求值环境初始化; 插件不可用时抛错(要不要记日志由 文案.环境初始化失败 决定) */
    准备EJS模板环境(): Promise<any>;
    /** 求值一段 EJS 模板; 插件缺失或版本不符时返回 null(调用方据此跳过该条目) */
    求值EJS(text: string, env: any): Promise<string | null>;
    /** EJS 语法错误信息(无错误时为空串), 用于出错时的日志诊断 */
    EJS语法错误(text: string): Promise<string>;
    展开酒馆宏(text: string): string;
    取助手变量(option: any): any;
    /** 表头模糊匹配时空表头算不算命中 —— 两份现行实现不一致, 由各自适配层声明(见文件头) */
    空表头也算命中: boolean;
}

/** 求值上下文: 扫描文本 + 本次用到的表格数据 + 环境 */
interface 求值上下文 {
    scanText: string;
    sheets: 表格数据[];
    环境: 求值环境;
}

/** 移除世界书条目里无法求值的模板语法：{[...]} 表达式、<random/> 等标签、$v: 变量引用(不处理 <if>, <if> 由 evaluateTemplate 求值) */
function stripOtherSyntax(content: string): string {
    if (!/\{\[|<(?:random|calc|max|min)\b|\$(?:v|random|calc|max|min):|<%/i.test(content))
        return content;
    let result = content;
    // {[ ... ]} 表达式块
    let out = '';
    let i = 0;
    while (i < result.length) {
        if (result[i] === '{' && result[i + 1] === '[') {
            let depth = 1;
            let inQuote: string | null = null;
            let j = i + 2;
            for (; j < result.length; j++) {
                const ch = result[j];
                if (inQuote) {
                    if (ch === inQuote)
                        inQuote = null;
                    continue;
                }
                if (ch === "'" || ch === '"') {
                    inQuote = ch;
                    continue;
                }
                if (ch === '[')
                    depth++;
                else if (ch === ']') {
                    depth--;
                    if (depth === 0)
                        break;
                }
            }
            j++;
            if (result[j] === '}')
                j++;
            i = j;
            continue;
        }
        out += result[i];
        i++;
    }
    result = out;
    // 自闭合值标签与变量引用
    result = result.replace(/<(?:random|calc|max|min)\b[^>]*\/?>/gi, '');
    result = result.replace(/\$(?:v|random|calc|max|min):[a-zA-Z_][a-zA-Z0-9_]*/g, '');
    // EJS 未渲染时的兜底：移除残留的 <% ... %> 模板块
    result = result.replace(/<%[\s\S]*?%>/g, '');
    // 兜底：移除残留的 elseif/else 标签(防不完整结构)
    result = result.replace(/<\/?(?:elseif|else)\b[^>]*>/gi, '');
    return result;
}

/** ACU 表格快照缓存(按表名集合缓存, 30 秒内复用) */
let sheetsCache: { key: string; time: number; sheets: 表格数据[] } | null = null;
const SHEETS_TTL = 30_000;

/** 从世界书内容里收集 <if cond="cell:表名/..."> 用到的表名(只用到的表才查)。
 * 注意判据是 `cell:` 而不是 `cell=` —— 写在 cond 里的 cell: 才算数, `<if cell="表/行/列 >= 值">`
 * 自己引用的表收集不到(两家现行实现都是这样, 照抄不改) */
function 收集表格名(contents: string[]): string[] {
    const tables = new Set<string>();
    for (const content of contents) {
        const re = /cell:\s*([^/\s]+)\s*\//gi;
        for (const m of content.matchAll(re)) {
            if (m[1])
                tables.add(m[1]);
        }
    }
    return [...tables];
}

async function 组装求值上下文(scanText: string, tableNames: string[], 环境: 求值环境): Promise<求值上下文> {
    const key = [...tableNames].sort().join('|');
    if (sheetsCache && sheetsCache.key === key && Date.now() - sheetsCache.time < SHEETS_TTL) {
        return { scanText, sheets: sheetsCache.sheets, 环境 };
    }
    const sheets: 表格数据[] = [];
    if (tableNames.length > 0) {
        // 用 exportTableAsJson(原生/SQLite 模式都可用、结构稳定), 只保留用到的表
        let allNames: string[] = [];
        try {
            const all = 环境.取ACU表格();
            if (all && typeof all === 'object') {
                const list = Object.values(all) as any[];
                allNames = list.filter(s => s && typeof s.name === 'string').map(s => s.name);
                for (const s of list) {
                    if (s && typeof s.name === 'string' && Array.isArray(s.content) && tableNames.includes(s.name)) {
                        sheets.push({ name: s.name, content: s.content });
                    }
                }
            }
        }
        catch {
            // ACU 未就绪或无表格时按空数据处理
        }
        if (sheets.length < tableNames.length) {
            const missing = tableNames.filter(n => !sheets.some(s => s.name === n));
            console.warn(环境.文案.缺表(missing.join('、'), allNames.join('、')));
        }
        sheetsCache = { key, time: Date.now(), sheets };
    }
    return { scanText, sheets, 环境 };
}

function getCellValue(ctx: 求值上下文, tableName: string, rowName: string, colName?: string): unknown {
    const sheet = ctx.sheets.find(s => s.name === tableName);
    if (!sheet || sheet.content.length === 0)
        return undefined;
    const headers = sheet.content[0];
    // 列：先精确匹配表头，再模糊匹配(表头包含列名, 如"性别/年龄"匹配"年龄")
    // 空表头/空列名算不算命中, 两家现行实现不一样 —— 由 空表头也算命中 声明(见文件头)
    let colIdx = -1;
    if (colName) {
        colIdx = headers.indexOf(colName);
        if (colIdx === -1)
            colIdx = headers.findIndex(h => (ctx.环境.空表头也算命中 || h) && (h.includes(colName) || colName.includes(h)));
    }
    // 行：先精确(任意单元格等于行名), 再模糊(任意单元格包含行名)
    let rowIdx = -1;
    for (let r = 1; r < sheet.content.length; r++) {
        const row = sheet.content[r];
        if (row && row.some(cell => cell !== null && cell !== undefined && String(cell) === String(rowName))) {
            rowIdx = r;
            break;
        }
    }
    if (rowIdx === -1) {
        for (let r = 1; r < sheet.content.length; r++) {
            const row = sheet.content[r];
            if (row && row.some(cell => cell !== null && cell !== undefined && String(cell).includes(String(rowName)))) {
                rowIdx = r;
                break;
            }
        }
    }
    if (rowIdx === -1 && colName) {
        const swappedCol = headers.indexOf(rowName);
        const swappedRow = sheet.content.findIndex((row, r) => r > 0 && row && row.some(cell => String(cell) === String(colName)));
        if (swappedCol !== -1 && swappedRow !== -1) {
            rowIdx = swappedRow;
            colIdx = swappedCol;
        }
    }
    if (rowIdx === -1 || colIdx === -1) {
        logCellLookupFailure(ctx.环境, sheet.name, headers, rowName, colName, rowIdx === -1, colIdx === -1);
        return undefined;
    }
    return sheet.content[rowIdx][colIdx];
}

/** 查值失败诊断：只对每个 表/行/列 组合记录一次, 避免刷屏 */
const cellDebugSeen = new Set<string>();
function logCellLookupFailure(环境: 求值环境, sheetName: string, headers: string[], rowName: string, colName: string | undefined, rowMissing = false, colMissing = false) {
    const key = `${sheetName}/${rowName}/${colName ?? ''}`;
    if (cellDebugSeen.has(key))
        return;
    cellDebugSeen.add(key);
    const reason = rowMissing && colMissing ? '行和列都没找到' : rowMissing ? '行未找到' : '列未找到';
    console.warn(环境.文案.查值失败(reason, sheetName, rowName, colName ?? '(两段式)', headers.join('、')));
}

function compareValue(value: unknown, op: string, rawValue: string): boolean {
    const aStr = String(value);
    // 数值比较：单元格值可能是 "女/19" 这种复合串, 先尝试整体转数字, 失败则提取第一个数字
    let aNum = typeof value === 'number' ? value : parseFloat(aStr);
    if (!Number.isFinite(aNum)) {
        const m = aStr.match(/-?\d+(\.\d+)?/);
        if (m)
            aNum = parseFloat(m[0]);
    }
    const bNum = parseFloat(rawValue);
    const numeric = Number.isFinite(aNum) && Number.isFinite(bNum);
    const x = numeric ? aNum : aStr;
    const y = numeric ? bNum : rawValue;
    switch (op) {
        case '>=': return x >= y;
        case '<=': return x <= y;
        case '>': return x > y;
        case '<': return x < y;
        case '!=': return x !== y;
        case '=':
        case '==': return x === y;
        default: return false;
    }
}

function evaluateCellExpr(expr: string, ctx: 求值上下文): boolean | null {
    const norm = expr
        .replace(/＞/g, '>')
        .replace(/＜/g, '<')
        .replace(/＝/g, '==')
        .replace(/≥/g, '>=')
        .replace(/≤/g, '<=')
        .replace(/≦/g, '<=')
        .replace(/≠/g, '!=');
    const m = norm.match(/^(.+?)\s*(>=|<=|==|!=|=|>|<)\s*(.+)$/);
    if (!m)
        return null;
    const cellRef = m[1].trim();
    const parts = cellRef.split('/').map(s => s.trim());
    if (parts.length < 2)
        return null;
    const value = getCellValue(ctx, parts[0], parts[1], parts.length >= 3 ? parts[2] : undefined);
    if (value === undefined || value === null)
        return null;
    return compareValue(value, m[2], m[3].trim());
}

/** seed 关键词匹配(支持 A,B=OR / A&B=AND / !k 取反 / 括号分组) */
function evaluateSeedExpr(expr: string, ctx: 求值上下文): boolean | null {
    const text = (ctx.scanText || '').toLowerCase();
    const groups = expr.split(',').map(g => g.trim()).filter(Boolean);
    if (groups.length === 0)
        return null;
    return groups.some(group => {
        const parts = group.split('&').map(p => p.trim()).filter(Boolean);
        return parts.every(p => {
            const neg = p.startsWith('!');
            const kw = (neg ? p.slice(1) : p).replace(/^\(|\)$/g, '').toLowerCase();
            const hit = kw.length > 0 && text.includes(kw);
            return neg ? !hit : hit;
        });
    });
}

function evaluateLeaf(leaf: string, ctx: 求值上下文): boolean | null {
    const m = leaf.match(/^(cell|seed|db|sql|v):([\s\S]*)$/i);
    if (!m)
        return null;
    const type = m[1].toLowerCase();
    const arg = m[2].trim();
    if (type === 'cell')
        return evaluateCellExpr(arg, ctx);
    if (type === 'seed')
        return evaluateSeedExpr(arg, ctx);
    return null; // db/sql/v 依赖 SQLite 运行时, 不模拟
}

/** cond 表达式递归下降求值：OR(,) -> AND(&) -> NOT(!) -> primary(() | 叶子) */
function evalCond(expr: string, ctx: 求值上下文): boolean | null {
    let pos = 0;
    const skipWs = () => {
        while (pos < expr.length && /\s/.test(expr[pos])) pos++;
    };
    function parseOr(): boolean | null {
        let value = parseAnd();
        for (;;) {
            skipWs();
            if (expr[pos] === ',') {
                pos++;
                const v = parseAnd();
                value = value === null || v === null ? null : value || v;
            }
            else break;
        }
        return value;
    }
    function parseAnd(): boolean | null {
        let value = parseNot();
        for (;;) {
            skipWs();
            if (expr[pos] === '&') {
                pos++;
                const v = parseNot();
                value = value === null || v === null ? null : value && v;
            }
            else break;
        }
        return value;
    }
    function parseNot(): boolean | null {
        skipWs();
        if (expr[pos] === '!') {
            pos++;
            const v = parseNot();
            return v === null ? null : !v;
        }
        return parsePrimary();
    }
    function parsePrimary(): boolean | null {
        skipWs();
        if (pos >= expr.length)
            return null;
        if (expr[pos] === '(') {
            pos++;
            const v = parseOr();
            skipWs();
            if (expr[pos] === ')')
                pos++;
            return v;
        }
        const rest = expr.slice(pos);
        const pm = rest.match(/^(cell|seed|db|sql|v):/i);
        if (pm) {
            const type = pm[0].slice(0, -1).toLowerCase();
            const afterPrefix = rest.slice(pm[0].length);
            if (type === 'sql') {
                const qm = afterPrefix.match(/^"([\s\S]*?)"/);
                if (!qm)
                    return null;
                pos += pm[0].length + qm[0].length;
                return evaluateLeaf('sql:' + qm[1], ctx);
            }
            const lm = afterPrefix.match(/^[^&!,()]+/);
            if (!lm)
                return null;
            pos += pm[0].length + lm[0].length;
            return evaluateLeaf(pm[0] + lm[0], ctx);
        }
        const lm = rest.match(/^[^&!,()]+/);
        if (!lm)
            return null;
        pos += lm[0].length;
        return evaluateLeaf('seed:' + lm[0], ctx);
    }
    const result = parseOr();
    skipWs();
    return pos >= expr.length ? result : null;
}

function evaluateCondition(type: string, expr: string, ctx: 求值上下文): boolean | null {
    const t = (type || '').toLowerCase();
    if (t === 'cond')
        return evalCond(expr, ctx);
    if (t === 'cell')
        return evaluateCellExpr(expr, ctx);
    if (t === 'seed')
        return evaluateSeedExpr(expr, ctx);
    return null; // db/sql 无法求值
}

/** 递归求值 <if>...</if>(含 <else>、支持嵌套), 返回选中的分支内容 */
function evaluateTemplate(content: string, ctx: 求值上下文): string {
    let result = '';
    let i = 0;
    while (i < content.length) {
        const openIdx = content.indexOf('<if', i);
        if (openIdx === -1) {
            result += content.slice(i);
            break;
        }
        result += content.slice(i, openIdx);
        const tagMatch = content.slice(openIdx).match(/^<if\s+([a-zA-Z]+)\s*=\s*"([^"]*)"\s*>/i);
        if (!tagMatch) {
            result += '<if';
            i = openIdx + 3;
            continue;
        }
        const type = tagMatch[1];
        const expr = tagMatch[2];
        const tagEnd = openIdx + tagMatch[0].length - 1;
        const close = findMatchingClose(content, tagEnd + 1);
        if (!close) {
            result += content.slice(openIdx);
            break;
        }
        const block = content.slice(tagEnd + 1, close);
        const elseIdx = findTopLevelElse(block);
        const ifContent = elseIdx === -1 ? block : block.slice(0, elseIdx);
        const elseContent = elseIdx === -1 ? '' : block.slice(elseIdx).replace(/^<else\b[^>]*>/i, '');
        const cond = evaluateCondition(type, expr, ctx);
        const branch = cond === false ? elseContent : ifContent; // 无法求值时保守保留主分支
        result += evaluateTemplate(branch, ctx);
        i = close + '</if>'.length;
    }
    return result;
}

function findMatchingClose(content: string, start: number): number | null {
    const re = /<\/?if\b/g;
    let depth = 1; // 已计入外层 <if>
    for (const m of content.matchAll(re)) {
        const index = m.index ?? -1;
        if (index < start)
            continue;
        if (m[0][1] === '/') {
            depth--;
            if (depth === 0)
                return index;
        }
        else {
            depth++;
        }
    }
    return null;
}

function findTopLevelElse(block: string): number {
    const re = /<\/?if\b|<else\b/g;
    let depth = 0;
    for (const m of block.matchAll(re)) {
        if (m[0].startsWith('</'))
            depth--;
        else if (m[0].startsWith('<if'))
            depth++;
        else if (m[0].startsWith('<else') && depth === 0)
            return m.index ?? -1;
    }
    return -1;
}

/** EJS 模板环境缓存(prepareContext 会合并全部消息楼层变量, 成本不低; 30 秒内复用) */
let ejsContextCache: { time: number; env: unknown } | null = null;
const EJS_CONTEXT_TTL = 30_000;
async function 取EJS模板环境(环境: 求值环境): Promise<unknown> {
    if (ejsContextCache && Date.now() - ejsContextCache.time < EJS_CONTEXT_TTL)
        return ejsContextCache.env;
    let env: unknown = null;
    try {
        env = await 环境.准备EJS模板环境();
    }
    catch (error) {
        // 要不要把这件事说出来, 两家现行做法不同(烟火静默 / 彼方记日志), 由文案决定
        const 说明 = 环境.文案.环境初始化失败(error);
        if (说明)
            console.warn(说明);
    }
    if (env !== null)
        ejsContextCache = { time: Date.now(), env };
    return env;
}

/** 缓存出口: 切聊天时表数据/模板环境都可能失效(两个聊天楼层号可能相同导致误用)。
 * 注意: 烟火那份把出口丢了(候选8), 所以它现在也仍然不调 —— 行为不变, 出口只是补在了一起。 */
function 重置求值缓存(): void {
    sheetsCache = null;
    ejsContextCache = null;
}

/**
 * 展开酒馆助手扩展变量宏({{get_message_variable::路径}} / {{get_chat_variable::路径}} /
 * {{get_global_variable::路径}} / {{get_preset_variable::路径}} / {{get_character_variable::路径}} /
 * {{format_message_variable::路径}}):
 * `substitudeMacros` 只是酒馆本体 substituteParamsExtended 的包装, 不认识这些助手宏,
 * 不展开的话会原样发出去(主 AI 侧由酒馆助手的生成管线展开, 两边都得自行处理)。
 */
function expandHelperMacros(text: string, label: string, 环境: 求值环境): string {
    const macroRe = /\{\{(get_message_variable|format_message_variable|get_chat_variable|get_global_variable|get_preset_variable|get_character_variable)::([^{}]+)\}\}/gi;
    if (!macroRe.test(text))
        return text;
    const kindOf: Record<string, any> = {
        get_message_variable: { type: 'message', message_id: 'latest' },
        format_message_variable: { type: 'message', message_id: 'latest' },
        get_chat_variable: { type: 'chat' },
        get_global_variable: { type: 'global' },
        get_preset_variable: { type: 'preset' },
        get_character_variable: { type: 'character' },
    };
    const sources: Record<string, any> = {};
    const missing: string[] = [];
    const result = text.replace(macroRe, (match: string, macroName: string, rawPath: string) => {
        const path = String(rawPath).trim();
        const key = macroName.toLowerCase();
        if (!(key in sources)) {
            try {
                sources[key] = 环境.取助手变量(kindOf[key]) ?? {};
            }
            catch (error) {
                console.warn(`[${环境.文案.名字}] 世界书条目「${label}」读取${macroName}的变量失败: ${error instanceof Error ? error.message : String(error)}`);
                sources[key] = {};
            }
        }
        const value = _.get(sources[key], path);
        if (value === undefined || value === null) {
            missing.push(`${macroName}::${path}`);
            return '';
        }
        if (typeof value === 'string')
            return value;
        try {
            return JSON.stringify(value);
        }
        catch {
            return String(value);
        }
    });
    if (missing.length > 0)
        console.warn(`[${环境.文案.名字}] 世界书条目「${label}」以下助手变量宏没有取到值(已替换为空): ${[...new Set(missing)].join('、')}`);
    return result;
}

/**
 * 处理一条世界书内容, 按主 AI 的顺序：
 * 1. <if> 条件求值(选命中分支)
 * 2. EJS 模板渲染(<% %>, 环境与主 AI 相同, MVU 变量等可直接使用)
 * 3. 酒馆宏替换({{user}}/{{char}} 等) + 酒馆助手扩展变量宏展开
 * 4. 移除其余无法求值的模板语法
 * 所有失败都会输出日志(不再静默吞掉), 方便从日志页排查条目模板问题。
 */
async function 求值条目文本(content: string, ctx: 求值上下文, ejsEnv: unknown, label = '(未命名条目)'): Promise<string> {
    const 环境 = ctx.环境;
    let text = evaluateTemplate(content, ctx);
    if (ejsEnv && text.includes('<%')) {
        // 插件导出名大小写不一致(evalTemplate / evaltemplate)的兼容收在各自的 host 接缝里:
        // 这里只管求值, 返回 null 即插件不可用, 模板块随后会被 stripOtherSyntax 移除。
        try {
            const 求值结果 = await 环境.求值EJS(text, ejsEnv);
            if (求值结果 === null) {
                console.warn(`[${环境.文案.名字}] 世界书条目「${label}」含 EJS 模板, 但 EjsTemplate.evalTemplate 不可用(请检查提示词模板语法插件版本), 模板块将被移除`);
            }
            else {
                text = 求值结果;
            }
        }
        catch (error) {
            // 不再静默: 附带语法诊断, 方便排查条目里的模板错误
            let syntax = '';
            try {
                syntax = await 环境.EJS语法错误(text);
            }
            catch {
                // 诊断失败不影响主日志
            }
            console.warn(`[${环境.文案.名字}] 世界书条目「${label}」EJS 渲染失败(模板块将被移除): ${error instanceof Error ? error.message : String(error)}${syntax ? `\n语法诊断: ${syntax}` : ''}`);
        }
    }
    if (text.includes('{{')) {
        try {
            text = 环境.展开酒馆宏(text);
        }
        catch (error) {
            console.warn(`[${环境.文案.名字}] 世界书条目「${label}」酒馆宏替换失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    text = expandHelperMacros(text, label, 环境);
    if (/<%[\s\S]*?%>/.test(text))
        console.warn(`[${环境.文案.名字}] 世界书条目「${label}」仍残留未渲染的 EJS 模板块(通常为渲染失败或语法错误, 见上方日志), 已移除`);
    return stripOtherSyntax(text);
}

export { 取EJS模板环境, 收集表格名, 求值条目文本, 组装求值上下文, 重置求值缓存 };
export type { 求值上下文, 求值文案, 求值环境, 表格数据 };
