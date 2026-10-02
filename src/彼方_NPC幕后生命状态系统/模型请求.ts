// 从模型那里拿到"合要求的 JSON"这一步(候选2 拆出来的第一步)。
// 这一段以前塞在 updateNpcStates 里, 和"取料/应用/收尾"共用一个 try; 现在它自己一个模块:
// 发请求 → 解析 → 校验, 不合格就带着错误原因重试(最多 3 次)。两类失败分开对待:
//  - 接口出错(网络/网关/超时/政策拦): 没有有效输出可回喂, 只等更久(2 秒 × 第几次)后重试;
//  - 解析/校验失败: 把上次输出里的 JSON 片段连同错误原因回喂给 AI, 让它自己改(等 0.6 秒后重试)。
// 发请求、写日志、报进度都由调用方传进来, 所以这一整套重试协议不装酒馆也能单独跑。
// 依赖按实际用到的符号具名导入/默认导入(形态守卫见 tests/no-bundle-artifacts.test.ts)。
// json5 走默认导入: 原先是从命名空间取 ["default"], 默认导入编译出的取值路径与它完全一致。
import JSON5 from 'json5';
import { CARD_FIELDS } from './卡字段';
import { PHYSIO_FIELDS } from './生理规则';
import { parseStoryTime } from './剧情时间';
import { 请求并校验 as 共用请求并校验 } from '../共用/模型往返';

/** 模型可能把内部思考当成顶层字段输出的键名(非彼方数据): 解析兜底时剥离, 也作为保留键不参与 NPC 建档 */
const THINKING_FIELD_KEYS = ['静默思考流程', '思考流程', '思考过程', '思维链', '推理过程'];
/** 每张被返回的状态卡都必须包含的普通字符串字段(全部字段, 新建 NPC 建档时使用) */
const REQUIRED_CARD_FIELDS = CARD_FIELDS.filter(field => !PHYSIO_FIELDS.includes(field));
/** 增量更新下已有 NPC 每次必返的核心字段(其余字段未返回=沿用旧值) */
const CORE_CARD_FIELDS = ['当前在做', '当前状态', '位置'];
function parseModelResponse(content) {
    let text = content.trim();
    const fence = text.match(/^```(?:json|yaml)?\s*([\s\S]*?)\s*```$/);
    if (fence)
        text = fence[1].trim();
    // 括号配平+候选轮验截取 JSON——不能用"第一个{到最后一个}"的粗切:
    // 模型受世界书格式影响时, 彼方的 JSON 前后可能跟着自带 { } 的其他格式块(UpdateVariable/思维链里的伪示例),
    // 粗切会拼出坏串, 固定取第一个 { 又可能抓到前文的示例小对象。
    // 候选轮验: 逐个 { 起配平切出候选串, 含彼方核心字段且能通过解析的第一个完整对象胜出
    const sliceBalancedJson = (text) => {
        let start = text.indexOf('{');
        while (start !== -1) {
            let depth = 0;
            let inString = false;
            let escaped = false;
            for (let i = start; i < text.length; i++) {
                const ch = text[i];
                if (inString) {
                    if (escaped)
                        escaped = false;
                    else if (ch === '\\')
                        escaped = true;
                    else if (ch === '"')
                        inString = false;
                    continue;
                }
                if (ch === '"')
                    inString = true;
                else if (ch === '{')
                    depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        const candidate = text.slice(start, i + 1);
                        // 候选必须含彼方的核心字段才算目标对象(排除前文伪 JSON 示例/其他格式块的小对象)
                        if (candidate.includes('"剧情时间"') || candidate.includes("'剧情时间'") || candidate.includes('"移除NPC"')) return candidate;
                        start = text.indexOf('{', i + 1); // 不是目标, 从这个候选之后继续找
                        break;
                    }
                }
            }
            if (depth !== 0)
                break; // 扫到文本末尾括号都没配平(截断), 无更多候选
        }
        return null;
    };
    const sliced = sliceBalancedJson(text);
    if (!sliced) {
        throw Error(`AI 没有返回 JSON 对象（只输出了文字/推理内容, 或大括号不配平可能被截断）。\n原始内容: ${content.slice(0, 400)}`);
    }
    text = sliced;
    // 思考内容不是数据, 直接无视: 模型偶尔把内部思考当顶层字段输出(如 "静默思考流程": "Step1 ..."),
    // 其中的裸换行/未转义引号会让 JSON 与 JSON5 全部解析失败。优先剥离该字段再解析。
    const stripped = stripThinkingFields(text);
    // 字符串内的裸控制字符(换行/制表符)转义: 模型把多行文本写进数据字段时(思考之外的字段也可能出现)
    const candidates = [];
    if (stripped !== text) {
        candidates.push(escapeRawControlCharsInStrings(stripped), stripped);
    }
    candidates.push(escapeRawControlCharsInStrings(text), text);
    // 逐个候选尝试: JSON 严格解析 → JSON5 宽松解析; 全部失败时用最后一次的错误报错
    let lastError;
    for (const candidate of candidates) {
        // 剥离/修复后必须仍是彼方 JSON(含数据键), 否则说明切坏了, 换下一候选
        if (!candidate.includes('"剧情时间"') && !candidate.includes("'剧情时间'") && !candidate.includes('"移除NPC"'))
            continue;
        for (const parse of [(t) => JSON.parse(t), (t) => JSON5.parse(t)]) {
            try {
                return parse(candidate);
            }
            catch (e) {
                lastError = e;
            }
        }
    }
    if (stripped !== text)
        console.warn('[彼方] JSON 解析失败后已剥离"思考流程"字段重试(提示词已要求不要把思考写进 JSON)');
    const jsonError = lastError;
    throw Error(`AI 返回的 JSON 不完整或格式错误（已自动重试，多次失败请调大「最大输出Token」或检查模型）。解析错误: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}\n原始内容: ${content.slice(0, 600)}`, { cause: jsonError ?? undefined });
}
/** 字符串内的裸控制字符(换行/回车/制表符等)转义为合法 JSON 转义序列。
 *  模型把多行文本直接写进 JSON 字符串时会产生裸换行, JSON.parse 与 json5 都会拒绝。
 *  只在字符串内部做转义, 不改动结构字符。 */
function escapeRawControlCharsInStrings(text) {
    const src = String(text ?? '');
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inString) {
            if (escaped) {
                out += ch;
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                out += ch;
                escaped = true;
                continue;
            }
            if (ch === '"') {
                out += ch;
                inString = false;
                continue;
            }
            const code = ch.charCodeAt(0);
            if (code === 0x0A)
                out += '\\n';
            else if (code === 0x0D)
                out += '\\r';
            else if (code === 0x09)
                out += '\\t';
            else if (code < 0x20)
                out += `\\u${code.toString(16).padStart(4, '0')}`;
            else
                out += ch;
            continue;
        }
        if (ch === '"')
            inString = true;
        out += ch;
    }
    return out;
}
/** 剥离顶层"静默思考流程"等思考字段(非彼方数据, 直接无视)。
 *  优先按"下一个顶层键"定位值结尾(`,` + 换行 + `"键名"`), 找不到再退回对象结尾 `}`;
 *  切完立即由调用方用真实解析验证, 切坏则自动降级到原始文本。找不到思考键时原样返回。 */
function stripThinkingFields(text) {
    let result = String(text ?? '');
    for (const key of THINKING_FIELD_KEYS) {
        const keyRe = new RegExp(`"${key}"\\s*:`, 'g');
        let match = keyRe.exec(result);
        while (match) {
            const valueStart = keyRe.lastIndex;
            let end = -1;
            let endWithComma = false;
            // ① 优先: 顶层键分隔符 `,` + 换行 + `"键名"`
            for (let i = valueStart; i < result.length; i++) {
                if (result[i] === ',') {
                    const rest = result.slice(i + 1);
                    if (/^\s*\n\s*"/.test(rest)) {
                        end = i;
                        break;
                    }
                }
            }
            // ② 退回: 顶层对象结尾 `}`(此时候选框会缺数据键, 由调用方判定作废)
            if (end === -1) {
                const closeIdx = result.lastIndexOf('}');
                if (closeIdx > valueStart) {
                    end = closeIdx;
                    endWithComma = true;
                }
            }
            if (end === -1)
                break;
            const before = result.slice(0, match.index);
            const after = result.slice(end + (endWithComma ? 0 : 1));
            result = before + after.replace(/^\s*/, '');
            // 重建后必须重置 lastIndex: 全局正则否则会从旧位置继续, 漏掉重复出现的思考字段
            keyRe.lastIndex = 0;
            match = keyRe.exec(result);
        }
    }
    return result;
}
/** 从 AI 原始输出中提取 JSON 部分(去思维链/正文等杂质), 供重试时回喂给 AI 指明格式错误 */
function extractJsonSnippet(content) {
    let text = String(content || '').trim();
    const fence = text.match(/^```(?:json|yaml)?\s*([\s\S]*?)\s*```$/);
    if (fence)
        text = fence[1].trim();
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace <= firstBrace)
        return '';
    // 剥离思考字段: 思考超长(数十KB)会挤掉真正需要回喂的格式错误信息
    const snippet = stripThinkingFields(text.slice(firstBrace, lastBrace + 1));
    return snippet.trim() || text.slice(firstBrace, lastBrace + 1);
}
/** 顶层保留键(非 NPC 名字): 元数据/思考字段/旧格式分组键, 不参与状态卡合并与校验。
 *  「持有物移除」正常写在每个 NPC 对象里(见 应用更新.ts 的 mergeCard), 这里把它一并列为保留键:
 *  模型若误把它放到顶层, 不会被当成一个叫"持有物移除"的 NPC。 */
function isReservedTopLevelKey(name) {
    return name === '在场NPC' || name === '后台互动' || name === '移除NPC'
        || name === '剧情时间' || name === '受孕事件' || name === '人设参考'
        || name === '持有物移除'
        || THINKING_FIELD_KEYS.includes(name);
}
/** 校验 AI 输出的 JSON 结构是否符合预期; 结构错误、"新增 NPC 字段不全"抛错重试, 已有 NPC 缺普通字段只警告(沿用旧值) */
function validateParsedFormat(parsed, existingCards = {}, skipCheckNames = null) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw Error('AI 返回的 JSON 结构不符合预期(顶层不是对象)');
    }
    // 剧情时间格式校验: 生理周期日期/受孕判定依赖它解析, 必须为标准
    // "YYYY-MM-DD HH:mm"(年份4位补零如 0004/0025/0137), 否则自动重试让 AI 修正格式
    const storyTime = parsed['剧情时间'];
    let storyEndTs = null;
    if (storyTime && typeof storyTime === 'object' && !Array.isArray(storyTime)) {
        const bad = [];
        for (const key of ['开始', '结束']) {
            const value = String(storyTime[key] ?? '').trim();
            if (value && parseStoryTime(value) === null)
                bad.push(`${key}="${value}"`);
        }
        if (bad.length > 0) {
            throw Error(`"剧情时间"格式不正确(${bad.join('、')}): 必须为 "YYYY-MM-DD HH:mm", 年份固定4位补零(如 0004、0025、0137), 月/日/时/分2位补零, 重新输出`);
        }
        const endStr = String(storyTime['结束'] ?? '').trim();
        storyEndTs = endStr ? parseStoryTime(endStr) : null;
    }
    const checkCard = (npcName, card, isNew = false) => {
        // 增量更新: 新建 NPC 要求全字段(建档补全); 已有 NPC 只要求核心三字段——
        // 其余字段未返回=沿用旧值, 属于合法行为, 不警告
        const requiredFields = isNew ? REQUIRED_CARD_FIELDS : CORE_CARD_FIELDS;
        const missingNormal = requiredFields.filter(field => typeof card?.[field] !== 'string' || !String(card?.[field] ?? '').trim());
        if (missingNormal.length > 0) {
            console.warn(`[彼方] NPC「${npcName}」缺失字段: ${missingNormal.join('、')}(保留旧值)`);
        }
        // 睡眠时间合理性告警: 剧情结束时刻已到白天(约07:00~21:00),
        // 但"当前在做/当前状态"仍停留在过夜睡眠(睡觉/入睡/就寝/赖床), 提示 AI 按时间推进
        if (storyEndTs !== null) {
            const hour = new Date(storyEndTs).getHours();
            if (hour >= 7 && hour <= 21) {
                const sleepText = `${String(card?.['当前在做'] ?? '')} ${String(card?.['当前状态'] ?? '')}`;
                if (/睡觉|就寝|入睡|睡着|赖床|睡觉中|仍在睡/.test(sleepText) && !/午休|打盹|小憩|补觉|夜班|熬夜|守夜|病床|卧床/.test(sleepText)) {
                    console.warn(`[彼方] NPC「${npcName}」剧情已到 ${String(hour).padStart(2, '0')}:00 仍在过夜睡眠状态, 应按时间推进(起床/洗漱/做事等), 除非剧情明确其在补觉/值夜班/卧床`);
                }
            }
        }
        // 生理字段齐全性: 只对**本卡实际返回了任一生理字段**的卡要求齐全(增量更新下,
        // 未返回生理字段=沿用旧值+代码按剧情时间兜底推进, 属于合法行为, 不警告)
        const cardHasPhysio = PHYSIO_FIELDS.some(field => card?.[field] !== undefined && card?.[field] !== null && String(card?.[field] ?? '').trim() !== '');
        const missingPhysio = PHYSIO_FIELDS.filter(field => card?.[field] === undefined || card?.[field] === null || (typeof card?.[field] === 'string' && !card[field].trim()));
        if (cardHasPhysio && missingPhysio.length > 0) {
            console.warn(`[彼方] NPC「${npcName}」缺失生理字段: ${missingPhysio.join('、')}(保留旧值)`);
        }
        // 防全知字段: 孕期角色必须有「怀孕知晓」(NPC 本人是否知晓怀孕); 缺失时警告(mergeCard 会按孕周兜底补全)
        const isPregnantOut = String(card?.['是否怀孕'] ?? '') === 'true' || String(card?.['是否怀孕']) === '是' || String(card?.['生理周期'] ?? '').includes('孕期');
        if (isPregnantOut && (card?.['怀孕知晓'] === undefined || card?.['怀孕知晓'] === null || !String(card?.['怀孕知晓'] ?? '').trim())) {
            console.warn(`[彼方] NPC「${npcName}」孕期但缺「怀孕知晓」字段(将按孕周兜底补全)`);
        }
    };
    for (const [name, card] of Object.entries(parsed)) {
        if (isReservedTopLevelKey(name))
            continue;
        // 自动建档关闭: 即将被跳过(不建档)的新角色不按"新建 NPC 全字段"口径校验, 避免误警告
        if (skipCheckNames && skipCheckNames.has(name))
            continue;
        if (card && typeof card === 'object' && !Array.isArray(card))
            checkCard(name, card, !(existingCards ?? {})[name]);
    }
}
/**
 * 发请求并拿到"合要求的 JSON"; 不合格就带着错误原因重试, 最多 3 次都失败则抛最后一次的错。
 * 调用方负责: 把请求/响应写进日志页(记日志)、把"正在重试"显示给用户(报进度)。
 * 返回请求耗时与次数, 由调用方累加进它自己的计时(便于"本次更新总耗时"的拆分统计)。
 */
/** 依赖全部由调用方给: 发请求、写日志、报进度 —— 所以这一整套重试协议能脱离酒馆单独跑 */
type 请求参数 = {
    /** 基础消息(不含错误反馈); 反馈只追加到"任务 user 消息"上, 不动尾部 */
    messages: any[];
    /** 任务 user 消息在 messages 里的位置(提示词形状自己声明的锚点) */
    锚点: { 任务下标: number };
    /** 设置里的"预填充": 末位补一条 assistant '{' 引导模型直接从 JSON 开始 */
    预填充: boolean;
    /** 校验用: 已有的 NPC 卡(用来判断哪些名字算新角色) */
    现有卡: Record<string, any>;
    /** 校验用: 当前追踪的名单 */
    名单: string[];
    /** 校验用: 玩家自己的名字(不算新角色) */
    玩家名: string;
    /** 设置里的"自动建档"; 关掉时即将被跳过的新角色不按全字段校验 */
    自动建档: boolean;
    signal: AbortSignal;
    /** 真正发请求(线上是 api.ts 的 chatCompletion) */
    发请求: (messages: any[], options: { signal: AbortSignal }) => Promise<string>;
    /** 写日志页(线上是 debugStore.record) */
    记日志: (partial: any) => void;
    /** 报进度(线上是 updatingStore.message = 文字) */
    报进度: (文字: string) => void;
};
/** 彼方这一侧要告诉共用模块的只有"怎么解析、怎么校验、文案叫什么";
 *  重试节奏、回喂文案、预填充拼回这些两边一样的部分都在 共用/模型往返.ts 里。 */
async function 请求并校验(params: 请求参数): Promise<{ parsed: any; 请求耗时: number; 请求次数: number }> {
    const { 现有卡, 名单, 玩家名, 自动建档 } = params;
    return await 共用请求并校验({
        messages: params.messages,
        锚点: params.锚点,
        预填充: params.预填充,
        signal: params.signal,
        发请求: params.发请求,
        记日志: params.记日志,
        报进度: params.报进度,
        解析: content => parseModelResponse(content),
        校验: (parsed) => {
            // 自动建档关闭: 构造将被跳过的新角色名单(未追踪且不在已有卡中), 校验时不按新建口径要求全字段
            let skipCheckNames: Set<string> | null = null;
            if (自动建档 === false) {
                skipCheckNames = new Set();
                const collect = (n) => {
                    const name = String(n ?? '').trim();
                    if (name && name !== 玩家名 && !(名单.includes(name) || 现有卡[name]))
                        skipCheckNames.add(name);
                };
                for (const [name, card] of Object.entries(parsed)) {
                    if (isReservedTopLevelKey(name))
                        continue;
                    if (card && typeof card === 'object' && !Array.isArray(card))
                        collect(name);
                }
                if (Array.isArray(parsed['在场NPC'])) {
                    for (const item of parsed['在场NPC']) {
                        if (!item || typeof item !== 'object' || Array.isArray(item))
                            continue;
                        const n = String(item['姓名'] ?? item['名字'] ?? '').trim();
                        if (n)
                            collect(n);
                        else {
                            const first = Object.entries(item).find(([key, value]) => key !== '姓名' && key !== '名字' && value && typeof value === 'object');
                            if (first)
                                collect(first[0]);
                        }
                    }
                }
            }
            validateParsedFormat(parsed, 现有卡 ?? {}, skipCheckNames);
            return parsed;
        },
        取JSON片段: content => extractJsonSnippet(content),
        名字: '彼方',
        结构失败标签: '更新失败',
        中断文案: '用户已中断本次更新',
        取重试理由: (error) => {
            const errMsg = error.message ?? '';
            return errMsg.includes('JSON') || errMsg.includes('解析')
                ? 'AI 返回的 JSON 不完整'
                : errMsg.includes('格式不正确')
                    ? 'AI 输出格式不符合要求(如剧情时间格式)'
                    : 'AI 返回格式不符合要求';
        },
    });
}
export { isReservedTopLevelKey, THINKING_FIELD_KEYS, 请求并校验 };
