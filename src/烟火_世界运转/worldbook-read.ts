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
 *
 * 2026-11-01 (审查 P0 · 来源清楚的完整条目读取):
 *   新增 `getActiveWorldbookBundle()`: 除了拼好的文本, 还交代**每一条从哪来**(书名 + 世界书内 uid +
 *   AM 激活关键词 + 完整正文), 并把"设定(facts)"与"记忆(memory)"分开, 附带 warnings 与"独立重扫"
 *   的诚实标注。旧的 `getActiveWorldbookText()` 保留为**包装接口**(同样的条目、同样的顺序、同样的连接),
 *   供还没迁移的调用方继续用。
 *
 * 三条硬约束(写在这里, 免得后人又去"补全"):
 *   ① 这是**独立重扫**, 不是主 AI 那一次请求的最终激活集合 —— 所以 `sameRequest` 恒为 false,
 *      `mode` 恒为 '独立重扫'。第三方记忆插件把 AM 尾缀加在最终请求里、却没落回聊天正文时,
 *      这里重扫的文本里就没有那批关键词: 那就**如实报缺失**, 不假装"与主请求同批"。
 *   ② `options.expectedAM` 只用来**核对**: 主 AI 这一轮选中的 AM 若没被重扫激活, 记进 warnings 与
 *      `缺失AM`。**不**因此去扫全部旧记忆补数、**不**按标题数字猜映射、**不**为凑 20/40 条硬塞。
 *   ③ 每条正文都是**完整原文**(零截断): 这一层不许出现 slice/省略号/字数上限。
 */

import { useHost } from './host';
import {
    取EJS模板环境,
    组装求值上下文,
    收集表格名,
    求值条目文本,
    条目求值失败,
    type 求值环境,
} from '../共用/条目求值';
// 排除名单的判定与日志措辞: 与彼方/剧情导演同一份(共用/世界书排除.ts)
import { 命中排除, 条目标签, 排除说明, 是别的插件条目 } from '../共用/世界书排除';

/** 自动排除的世界书条目特征(名字/内容开头): 仅烟火自己写入的条目——不把自身输出当设定。
 * 彼方等其它插件的条目不排除: 它们也是世界的一部分, 与主 AI 读到的保持一致 */
const SELF_EXCLUDE_MARKS = ['【烟火】世界动向', '[烟火 · 世界动向]'];

/** AM 编码的合法形态: AM + 4 位以上数字(与 剧情导演/记忆检索 同一套契约) */
const AM正则 = /AM\d{4,}/gi;

/** 共用求值器要的平台能力与文案: 能力全部从 host 接缝接上(那个 module 自己不碰平台) */
function 烟火求值环境(选项: { 严格模式: boolean; 禁用缓存: boolean }): 求值环境 {
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
        // 2026-11-01: 严格(失败关闭)与不跨轮复用缓存。包装接口显式传 false, 行为与以前一致。
        严格模式: 选项.严格模式,
        禁用缓存: 选项.禁用缓存,
    };
}

export interface WorldbookReadOptions {
    excludeNames?: string[];
    includeGlobal?: boolean;
    /**
     * 主 AI **这一轮**实际选中的 AM(完整回溯引用)。只用于核对: 独立重扫没读到就显式报缺失。
     * 不猜映射、不补扫旧记忆、不硬凑条数。
     */
    expectedAM?: string[];
    /** 严格(失败关闭): 条件不可判定/缺表/EJS 不可用或失败 → 跳过整条并记原因。默认 **true**。 */
    严格?: boolean;
    /** 不复用也不写入上轮的 ACU/EJS 缓存。默认 **true**(烟火每轮重新读)。 */
    禁用缓存?: boolean;
}

/** 一条被读到的世界书条目: 来源与正文都完整, 便于回溯源 */
export interface 世界书条目来源 {
    /** 条目所在世界书(角色卡主/附加/聊天/全局之一) */
    书名: string;
    /** 世界书**内部**的 uid(WorldbookEntry 的 uid 不跨书唯一); 激活数据没带又无法唯一确认时为 null */
    uid: number | null;
    /**
     * 该条目命中的 AM 激活关键词(只认 `key` / `strategy.keys` 这两个**激活关键词**位置)。
     * 正文里写没写 AM 不参与判断 —— 否则"正文提了一句 AM"就会把真设定误降级成记忆。
     */
    AM关键词: string[];
    /** 有 AM 激活关键词 = 记忆(memory); 没有 = 设定(facts) */
    分类: '设定' | '记忆';
    /** 条目显示名(comment 优先, 退回 key / name), 只用于日志与诊断 */
    条目名: string;
    /** 求值后的**完整**正文, 一个字不砍 */
    text: string;
}

/** 一次世界书读取的结果: 分开的设定/记忆 + 逐条来源 + 诊断 */
export interface 世界书包 {
    /** 设定类条目(无 AM 关键词)拼成的文本, 空行连接; 与旧接口同样的顺序 */
    facts: string;
    /** 记忆类条目(有 AM 激活关键词)拼成的文本, 空行连接 */
    memory: string;
    /** 逐条来源(完整正文 + 书名 + uid + AM), 顺序 = 激活顺序 */
    entries: 世界书条目来源[];
    /** 本轮所有值得记的诊断(缺表、跳过整条的原因、缺失的 AM、重复来源…) */
    warnings: string[];
    /** 恒为 '独立重扫': 这是烟火自己按本轮扫描文本重算的激活, 不是主 AI 那一次请求的激活集合 */
    mode: '独立重扫';
    /** 恒为 false —— 不宣称与主请求同批(未验证第三方记忆插件的末段时点时, 只能诚实降级) */
    sameRequest: false;
    /** expectedAM 里本轮没读到的引用(显式缺失) */
    缺失AM: string[];
    /** 本轮参与扫描的世界书(主 → 附加 → 聊天 → 可选全局, 已去重) */
    扫描书: string[];
}

/** 空结果(没绑世界书 / 模板环境不可用时用) */
function 空包(warnings: string[], 扫描书: string[] = []): 世界书包 {
    return {
        facts: '',
        memory: '',
        entries: [],
        warnings,
        mode: '独立重扫',
        sameRequest: false,
        缺失AM: [],
        扫描书,
    };
}

/** 归一化一个 AM 引用: 去空白 + 大写(AM0001 与 am0001 视为同一引用; 不做位数补齐, 免得猜编码) */
function 归一AM(raw: unknown): string {
    return String(raw ?? '').trim().toUpperCase();
}

/** 从条目的**激活关键词**里取 AM(`key` 是激活数据的绿灯关键词, `strategy.keys` 是 getWorldbook 的形状) */
function 取AM关键词(entry: any): string[] {
    const out: string[] = [];
    const 收集 = (value: any, 深度 = 0) => {
        if (深度 > 3 || value === undefined || value === null)
            return;
        if (Array.isArray(value)) {
            for (const item of value)
                收集(item, 深度 + 1);
            return;
        }
        if (typeof value !== 'string')
            return; // 关键词也可能是正则, 取不出字面 AM, 跳过(不猜)
        for (const hit of value.match(AM正则) ?? []) {
            const ref = 归一AM(hit);
            if (ref && !out.includes(ref))
                out.push(ref);
        }
    };
    收集(entry?.key);
    收集(entry?.strategy?.keys);
    return out;
}

/** 本轮要扫的世界书: 角色主 + 附加 + 聊天 + (可选)全局, 按名字去重 */
function 收集书名(includeGlobal: boolean): string[] {
    const names: string[] = [];
    const push = (name: unknown) => {
        const 文本 = String(name ?? '').trim();
        if (文本 && !names.includes(文本))
            names.push(文本);
    };
    try {
        const 绑定 = useHost().worldbook.boundNames();
        push(绑定?.primary);
        for (const name of 绑定?.additional ?? [])
            push(name);
    }
    catch {
        // 未打开角色卡时忽略
    }
    try {
        push(useHost().worldbook.chatName());
    }
    catch {
        // 无聊天世界书时忽略
    }
    if (includeGlobal) {
        try {
            for (const name of useHost().worldbook.globalNames())
                push(name);
        }
        catch {
            // 忽略
        }
    }
    return names;
}

/**
 * 取条目的 uid。激活数据一般自带 uid(世界书内部编号), 没带时**只在严格模式**下回查一次该书全部条目
 * (`worldbook.entries`, 声明过的 host 能力)按内容(+标题)唯一匹配; 匹配不唯一就记 null 并说明,
 * **不猜**。宽松模式(旧包装)不做这次回查 —— 保证旧路径的读取次数与日志一个字节都不变。
 */
async function 取uid(
    书名: string,
    entry: any,
    严格: boolean,
    warnings: string[],
    全书缓存: Map<string, any[] | null>,
): Promise<number | null> {
    if (typeof entry?.uid === 'number' && Number.isFinite(entry.uid))
        return entry.uid;
    if (!严格)
        return null;
    let 全部: any[] | null;
    if (全书缓存.has(书名))
        全部 = 全书缓存.get(书名) ?? null;
    else {
        try {
            全部 = (await useHost().worldbook.entries(书名)) ?? [];
        }
        catch (error) {
            全部 = null;
            warnings.push(`无法确认 uid: 读不到「${书名}」的全部条目(${error instanceof Error ? error.message : String(error)})`);
        }
        全书缓存.set(书名, 全部);
    }
    if (!全部)
        return null;
    const 内容 = String(entry?.content ?? '');
    const 标题 = String(entry?.comment ?? entry?.name ?? '').trim();
    const 按内容 = 全部.filter(item => String(item?.content ?? '') === 内容);
    const 按标题 = 标题 ? 按内容.filter(item => [item?.name, item?.comment].some(value => String(value ?? '').trim() === 标题)) : [];
    const 候选 = 按标题.length > 0 ? 按标题 : 按内容;
    if (候选.length === 1 && typeof 候选[0]?.uid === 'number')
        return 候选[0].uid;
    warnings.push(`无法确认 uid: 「${书名}」里按内容+标题匹配到 ${候选.length} 条条目(激活数据没有 uid) → uid 记为 null, 不使用猜测值`);
    return null;
}

/**
 * 读一轮世界书, 返回**来源清楚**的完整条目包。
 *
 * 与旧接口的关系: `getActiveWorldbookText` 就是拿这个包里的 entries 按顺序拼起来。
 * 默认严格 + 不用缓存(烟火 reader 的用法); 想复现旧行为就显式传 `严格: false, 禁用缓存: false`。
 */
export async function getActiveWorldbookBundle(scanText: string, options: WorldbookReadOptions = {}): Promise<世界书包> {
    const 严格 = options.严格 !== false;
    const 禁用缓存 = options.禁用缓存 !== false;
    const 环境 = 烟火求值环境({ 严格模式: 严格, 禁用缓存 });
    const warnings: string[] = [];
    const entries: 世界书条目来源[] = [];
    // 排除名单: 标题/备注里含这些字就排除(不分大小写, 判定与彼方/导演共用 共用/世界书排除.ts);
    // 名字在激活数据里可能不可靠(可能只在 comment), 故内容开头(如 "[烟火 · 世界动向]")也参与匹配
    const excludes = [...(options.excludeNames ?? []), ...SELF_EXCLUDE_MARKS].map(s => String(s).trim()).filter(Boolean);
    const isExcluded = (entry: any) => Boolean(entry && (
        entry.extra?.yanhuo === true        // 烟火自己写的那条（上一轮的推演结果，不能当设定读回来）
        || 是别的插件条目(entry, '烟火')      // 彼方/导演的常驻条目同理（2026-11-23，三家共用一张身份表）
        || 命中排除(entry, excludes)));
    /** 被排除名单挡掉的条目(静默排除是排查黑洞: 挡没挡住要能看见) */
    const 排除挡掉: string[] = [];
    const names = 收集书名(!!options.includeGlobal);
    if (names.length === 0) return 空包(warnings);
    // EJS 模板环境提供 getWorldInfoActivatedData(主 AI 的世界书激活逻辑), 同时复用于 EJS 渲染
    const env: any = await 取EJS模板环境(环境);
    if (!env || typeof env.getWorldInfoActivatedData !== 'function') {
        console.warn('[烟火] 模板环境不可用, 跳过世界书读取');
        warnings.push('模板环境不可用(提示词模板语法插件缺失或版本不符): 本轮一条世界书条目都没读到');
        return 空包(warnings, names);
    }
    // 1. 收集各世界书的激活条目(用酒馆主 AI 的激活机制)
    const 扫描书: string[] = [];
    const 激活: { 书名: string; entry: any }[] = [];
    for (const name of names) {
        if (扫描书.includes(name))
            continue;
        扫描书.push(name);
        let activated: any[];
        try {
            activated = (await env.getWorldInfoActivatedData(name, scanText)) || [];
        }
        catch (error) {
            warnings.push(`「${name}」的激活查询失败(${error instanceof Error ? error.message : String(error)}): 这本世界书本轮没有参与`);
            continue;
        }
        for (const entry of activated) {
            if (!entry || entry.disable || !entry.content)
                continue;
            if (isExcluded(entry)) {
                排除挡掉.push(条目标签(entry));
                continue;
            }
            激活.push({ 书名: name, entry });
        }
    }
    if (排除挡掉.length > 0)
        console.info(`[烟火] ${排除说明(排除挡掉)}`);
    // 2. 去重: 同一本书 + 同一 uid + 同一片 AM + 同一份原文 = 同一条(同一个条目被重复返回/重复绑定)。
    //    **同内容不同 AM 不合并** —— 那是两条不同的记忆(AM 才是引用), 合并就等于凭正文猜引用。
    const 去重后: { 书名: string; entry: any; AM: string[] }[] = [];
    const 已见 = new Set<string>();
    for (const item of 激活) {
        const AM = 取AM关键词(item.entry);
        const uid = typeof item.entry?.uid === 'number' ? String(item.entry.uid) : '-';
        const 键 = [item.书名, uid, [...AM].sort().join(','), String(item.entry?.content ?? '')].join('\u0000');
        if (已见.has(键)) {
            warnings.push(`重复来源已合并:「${item.书名}」里的同一条目(uid ${uid === '-' ? '未确认' : uid})被重复返回`);
            continue;
        }
        已见.add(键);
        去重后.push({ ...item, AM });
    }
    // 3. 只查 <if> 用到的表(严格模式也认 `<if cell="表/行/列 …">` 那种写法)
    const ctx = await 组装求值上下文(scanText, 收集表格名(去重后.map(item => String(item.entry.content)), 严格), 环境);
    // 4. 逐条求值并记录来源(顺带提示哪些条目引用了不存在的表)
    const loggedMissingTables = new Set<string>();
    const 全书缓存 = new Map<string, any[] | null>();
    const 跳过AM = new Set<string>();
    for (const { 书名, entry, AM } of 去重后) {
        const label = typeof entry.comment === 'string' && entry.comment ? entry.comment : entry.key ? (Array.isArray(entry.key) ? entry.key.join('、') : entry.key) : '(未命名条目)';
        for (const table of 收集表格名([entry.content], 严格)) {
            if (!ctx.sheets.some(s => s.name === table) && !loggedMissingTables.has(table)) {
                loggedMissingTables.add(table);
                console.warn(`[烟火] 世界书条目「${label}」引用了不存在的表: ${table}, 请在世界书里改成正确的表名`);
                warnings.push(`「${书名}」的条目「${label}」引用了 ACU 里不存在的表: ${table}`);
            }
        }
        const uid = await 取uid(书名, entry, 严格, warnings, 全书缓存);
        const needsEjs = String(entry.content).includes('<%');
        try {
            const text = await 求值条目文本(entry.content, ctx, needsEjs ? env : null, label);
            if (!text.trim())
                continue; // 求值后为空(条件不命中/只有空白): 与现行一致, 不占位
            entries.push({
                书名,
                uid,
                AM关键词: AM,
                分类: AM.length > 0 ? '记忆' : '设定',
                条目名: label,
                text,
            });
        }
        catch (error) {
            // 严格模式下这里才会发生(条件不可判定/EJS 不可用或失败/残留模板块):
            // **整条都不注入**(两个分支都不要), 并把原文整篇写进诊断 —— 只删模板代码留下正文,
            // 正是把条件藏住的内容当公开设定。
            const 原因 = error instanceof 条目求值失败
                ? error.message
                : `求值异常: ${error instanceof Error ? error.message : String(error)}`;
            for (const ref of AM)
                跳过AM.add(ref);
            warnings.push(
                `条目「${label}」(书名「${书名}」/ uid ${uid ?? '未确认'}) 求值失败, 已跳过整条(不注入任何分支): ${原因}\n原文(完整, 未裁切): ${entry.content}`,
            );
        }
    }
    // 5. 核对 expectedAM: 只报告, 不补扫、不猜、不凑数
    const 已覆盖 = new Set<string>();
    for (const entry of entries) {
        if (entry.分类 !== '记忆')
            continue;
        for (const ref of entry.AM关键词)
            已覆盖.add(ref);
    }
    const 缺失AM: string[] = [];
    for (const raw of options.expectedAM ?? []) {
        const ref = 归一AM(raw);
        if (!ref || 已覆盖.has(ref) || 缺失AM.includes(ref))
            continue;
        缺失AM.push(ref);
        if (跳过AM.has(ref)) {
            warnings.push(`${ref}: 本轮重扫**激活到了**含该 AM 的条目, 但整条求值失败被跳过 —— 这条记忆本轮没有内容(不是没激活)`);
            continue;
        }
        warnings.push(`${ref}: 本轮独立重扫没有读到(扫描文本没有激活含该 AM 的条目)。不补扫旧记忆、不猜映射、不硬凑条数 —— 这条记忆本轮缺失`);
    }
    return {
        facts: entries.filter(entry => entry.分类 === '设定').map(entry => entry.text).join('\n\n'),
        memory: entries.filter(entry => entry.分类 === '记忆').map(entry => entry.text).join('\n\n'),
        entries,
        warnings,
        mode: '独立重扫',
        sameRequest: false,
        缺失AM,
        扫描书,
    };
}

/**
 * 旧接口(**包装**): 返回同样的激活条目、按同样的顺序用空行连接 —— 迁移期给还没换到 bundle 的调用方用。
 * 内部固定走宽松 + 允许缓存, 所以它的文本、日志、读取次数与改造前一致(已有的行为用例全靠这条).
 */
export async function getActiveWorldbookText(scanText: string, options: WorldbookReadOptions = {}): Promise<string> {
    const 包 = await getActiveWorldbookBundle(scanText, { ...options, 严格: false, 禁用缓存: false });
    return 包.entries.map(entry => entry.text).join('\n\n');
}
