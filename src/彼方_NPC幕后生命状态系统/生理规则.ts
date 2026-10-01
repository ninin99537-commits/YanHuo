// 彼方 · 生理规则: 周期阶段 / 受孕判定 / 孕期哺乳期 / 怀孕知晓(纯函数, 不依赖酒馆平台)
// 从 update.ts 原样搬出(仅改归属, 行为未变)。这里的常量与规则, 与 prompts.ts 里写给模型的
// 中文说明是同一套规则的两份表述——集中在此是为了让两份能被逐条对照, 不再各改各的。

import { dateOnlyTs, fmtStoryTime, parseStoryTime, parseStoryTimeRange } from './剧情时间';

/** 生理字段(仅当某 NPC 卡里出现了任一生理字段、即被判定为女性/双性等可怀孕角色时, 才要求全部补全) */
const PHYSIO_FIELDS = ['生理周期', '是否怀孕', '周期影响', '当前防护', '近期性行为'];
/** 周期长度随机范围(可怀孕角色首次建档时确定, 之后锁死, 不随 AI 覆盖变化) */
const PHYSIO_CYCLE_MIN = 21;
const PHYSIO_CYCLE_MAX = 35;
/** 从"生理周期"文本提取当前 Day(如 "排卵期 Day 13/25" → 13; "孕期 孕6周+3天" → null) */
function extractCycleDay(physioText) {
    const m = String(physioText ?? '').match(/Day\s*(\d+)/i);
    return m ? +m[1] : null;
}
/** 计算某 NPC 在指定 Day 发生受孕行为的单次受孕率(0~1), 基于锁定周期长度与防护 */
function calcConceptionRate(cycleLen, day, protection) {
    if (!cycleLen || !day)
        return 0;
    const ovuDay = cycleLen - 14; // 排卵日 = 周期长度-14
    const dist = day - ovuDay;    // 正=排卵后, 负=排卵前
    let base = 0.01; // 窗口外(安全期)保底 1%
    if (dist === 0)
        base = 0.25;              // 排卵日当天
    else if (dist >= -2 && dist <= -1)
        base = 0.20;              // 排卵前1-2天
    else if (dist >= -5 && dist <= -3)
        base = 0.10;              // 排卵前3-5天
    else if (dist === 1)
        base = 0.05;              // 排卵后1天
    const prot = String(protection ?? '').trim();
    const factor = prot.includes('避孕药') ? 0.01
        : prot.includes('避孕套') ? 0.02
            : prot.includes('外射') ? 0.05
                : prot.includes('无') ? 1
                    : 1;
    return Math.min(1, base * factor);
}
/** 解析受孕事件的"次数"为整数(钳制 1~20): 兼容数字/数字字符串/常见中文数字(一~十, 如"三次"→3, "2~3次"→2); 无效或缺省返回 1 */
function parseConceptionCount(value) {
    let n = Number(value);
    if (!Number.isFinite(n)) {
        const t = String(value ?? '').trim();
        const numMatch = t.match(/\d+/);
        if (numMatch) {
            n = Number(numMatch[0]);
        }
        else {
            const digit = { '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
            const first = t.charAt(0);
            if (first === '十')
                n = digit[t.charAt(1)] ? 10 + digit[t.charAt(1)] : 10; // 十/十一次
            else if (digit[first])
                n = t.charAt(1) === '十' ? digit[first] * 10 : digit[first]; // 三次→3, 二十次→20
        }
    }
    if (!Number.isFinite(n))
        return 1;
    return Math.max(1, Math.min(20, Math.floor(n)));
}
/**
 * 彼方自动受孕判定: AI 报告了"受孕事件"(阴道内射/阴道外射外阴附近)时, 由彼方代码
 * 掷 D100 并判定是否怀孕, 结果写回卡——不依赖 AI 自觉遵守规则。
 * 触发条件: 方式∈{阴道内射, 阴道外射(外阴附近)}, 且该 NPC 未怀孕(孕期不再判定),
 * 且该事件**发生在本次剧情时间窗口内**(旧事件——如剧情已跨过一晚仍被 AI 沿用的——不再判定)。
 * "次数">1(同一楼层内多次内射/外射)时按次数独立投掷多次, 任一次命中即怀孕(等价 1-(1-p)^n)。
 * "受孕事件"支持 单事件对象 或 事件数组(不同方式/防护分别报告, 如 3次内射+2次外射)——逐项独立判定。
 */
function applyConceptionCheck(merged, oldCard, storyTimeText = '') {
    const ev = merged['受孕事件'];
    if (!ev || typeof ev !== 'object')
        return;
    try {
        // 兼容两种报告格式: 单事件对象(旧格式) / 事件数组(多种方式/防护分别报告, 如 3次内射+2次外射)
        const asList = (v) => (Array.isArray(v) ? v : [v]).filter(item => item && typeof item === 'object' && !Array.isArray(item));
        const events = asList(ev);
        const oldEvents = asList(oldCard?.['受孕事件']);
        const range = parseStoryTimeRange(storyTimeText);
        for (const item of events) {
            const way = String(item['方式'] ?? '').trim();
            const isConceptive = way.includes('阴道内射') || way.includes('阴道外射');
            if (!isConceptive)
                continue; // 口内/肛内/体外不判定
            // 防御: 方式混合了内射与外射(AI 未按提示词分项报告)——无法拆分各自次数/防护, 只告警不拆
            if (way.includes('阴道内射') && way.includes('阴道外射'))
                console.warn(`[彼方] 受孕事件"方式"混合了内射与外射, 已按单一事件判定(提示词已要求分项报告)`);
            // 防御: 方式为"阴道外射"但防护填"无/空"——外射本身就是防护, 按"外射"系数(×0.05)判定,
            // 否则会按无防护的完整受孕率计算(比外射高约20倍), 严重误判
            let protection = item['防护'];
            if (way.includes('阴道外射') && !way.includes('阴道内射')
                && (!String(protection ?? '').trim() || String(protection).trim() === '无')) {
                protection = '外射';
                console.warn(`[彼方] 受孕事件方式为"阴道外射"但防护填"无/空", 已按外射系数判定`);
            }
            // 旧事件过滤(防反复判定): AI 每次更新会把旧卡里的受孕事件原样带上(如剧情已过了一晚),
            // 若事件时间明显早于本次剧情开始(或晚于剧情结束), 说明不是本次新发生的行为, 跳过判定。
            const evTs = parsePregnancyEventTime(item['时间'], storyTimeText);
            if (evTs !== null && range.startTs !== null && (evTs < range.startTs || (range.endTs !== null && evTs > range.endTs))) {
                console.info(`[彼方] 受孕事件为旧事件(不在本次剧情时间窗口内), 跳过判定: 事件=${item['时间']} 剧情=${storyTimeText}`);
                continue;
            }
            // 事件时间无法解析时, 若与旧卡里的受孕事件时间完全相同, 视为旧事件被沿用, 同样跳过
            if (evTs === null && storyTimeText && item['时间']
                && oldEvents.some(oldEv => oldEv['时间'] && String(oldEv['时间']) === String(item['时间']))) {
                console.info(`[彼方] 受孕事件时间无法解析且与旧卡相同, 视为旧事件, 跳过判定`);
                continue;
            }
            // 已怀孕: 不再判定(孕期无排卵, 不会二次怀孕)——本事件或数组中前一项已判孕时, 后续全部跳过
            if (String(merged['是否怀孕'] ?? '') === 'true' || String(merged['是否怀孕']) === '是')
                break;
            const phy = merged['生理周期'] || '';
            if (String(phy).includes('孕期'))
                break;
            const day = extractCycleDay(phy);
            const cycleLen = merged['周期长度'];
            if (!day || !cycleLen)
                continue;
            const rate = calcConceptionRate(cycleLen, day, protection);
            // 彼方掷骰 D100(1~100): 按事件"次数"独立投掷多次, 任一次命中即怀孕
            const count = parseConceptionCount(item['次数']);
            let pregnant = false;
            const rolls = [];
            for (let i = 0; i < count; i++) {
                const roll = 1 + Math.floor(Math.random() * 100);
                rolls.push(roll);
                if (roll <= Math.round(rate * 100)) {
                    pregnant = true;
                    break;
                }
            }
            const ovuDay = cycleLen - 14;
            console.info(`[彼方] 受孕判定: ${merged['是否怀孕'] !== undefined ? 'AI输出=' + merged['是否怀孕'] : '新卡'} 周期=${cycleLen} Day=${day}(排卵日${ovuDay}) 方式=${way} 防护=${item['防护'] || '无'} 次数=${count} 受孕率=${(rate * 100).toFixed(1)}%/次 掷骰=[${rolls.join(',')}] → ${pregnant ? '怀孕!' : '未怀'}`);
        if (pregnant) {
            merged['是否怀孕'] = 'true';
            if (!String(phy).includes('孕期'))
                merged['生理周期'] = `孕期 孕0周+0天`;
            // 防全知: 刚受孕的 NPC 本人完全不知情, 知晓状态固定为"未知"
            merged['怀孕知晓'] = '未知';
            // 阶段联动: 受孕后原"周期影响"(如排卵期性欲高涨)与孕期矛盾, 且该字段会注入主AI——
            // 刚受孕本人无感, 用中性文本覆盖, 下一轮 AI 可按剧情自然更新
            if (typeof merged['周期影响'] === 'string' && CYCLE_STAGE_INFLUENCE_RE.test(merged['周期影响']))
                merged['周期影响'] = '刚受孕, 暂无明显身体变化';
                // 记录受孕日期(剧情时间): 优先用受孕事件时间, 解析失败用剧情结束时刻。
                // 这是孕周推进的**绝对基准**——之后孕周一律按"当前剧情日期 - 受孕日期"重算,
                // 彻底摆脱 AI/旧卡孕周被写快后越推越快的问题。
                const pregTs = evTs !== null ? evTs : range.endTs;
                if (pregTs !== null)
                    merged['受孕日期'] = fmtStoryTime(pregTs);
                console.info(`[彼方] ${merged['曾用名'] || ''} 判定为怀孕, 生理周期转孕期(本人尚不知晓), 受孕日期=${merged['受孕日期'] || '(未知)'}`);
                break; // 已怀孕, 数组中剩余项不再判定
            }
            else if (String(merged['是否怀孕'] ?? '') !== 'false') {
                merged['是否怀孕'] = 'false';
            }
        }
    }
    finally {
        // 无论是否判定(已怀孕/孕期/方式非受孕/数据缺失/旧事件), 都从卡中清空受孕事件——
        // 避免残留后下一轮 AI 沿用旧事件再次触发重复判定/怀孕。
        delete merged['受孕事件'];
    }
}
/** 解析受孕事件的"时间"字段为时间戳: 兼容 "0137-06-09 21:40" 与缺年份的 "06-09 21:40"(用剧情时间补年份); 解析失败返回 null */
function parsePregnancyEventTime(timeText, storyTimeText) {
    let t = String(timeText ?? '').trim();
    if (!t)
        return null;
    // 缺年份(如 "06-09 21:40")时, 用剧情时间里的年份补全
    if (!/^\d{4}[-/.]/.test(t)) {
        const yearMatch = String(storyTimeText ?? '').match(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/);
        const year = yearMatch ? yearMatch[0].slice(0, 4) : String(new Date().getFullYear());
        t = `${year}-${t}`;
    }
    return parseStoryTime(t);
}
/** 从"生理周期"孕期文本提取孕周(如 "孕期 孕6周+3天" → 6; 提取不到返回 null) */
function extractPregnancyWeek(physioText) {
    const m = String(physioText ?? '').match(/孕\s*(\d+)\s*周/);
    return m ? +m[1] : null;
}
/** 由 Day 与锁定周期长度推算阶段名(与提示词规则一致): 排卵日 = 周期长度 - 14;
 *  月经期 Day1~5, 卵泡期 Day6~排卵日-2, 排卵期 排卵日±1, 黄体期 排卵日+2~周期长度 */
function cycleStageName(day, cycleLen) {
    const ovuDay = cycleLen - 14;
    if (day >= 1 && day <= 5)
        return '月经期';
    if (day >= 6 && day <= ovuDay - 2)
        return '卵泡期';
    if (day >= ovuDay - 1 && day <= ovuDay + 1)
        return '排卵期';
    return '黄体期';
}
/** 各阶段「周期影响」的通用描述: 阶段名被彼方代码修正时, 联动替换与旧阶段矛盾的影响文本
 * (通用描述保证阶段一致; 下一轮 AI 可按剧情自然细化重写) */
const CYCLE_STAGE_INFLUENCE = {
    '月经期': '经期身体略感疲惫, 腹部隐隐不适, 情绪偏低',
    '卵泡期': '卵泡期精力逐渐回升, 情绪平稳',
    '排卵期': '排卵期性欲高涨、情绪积极、更主动',
    '黄体期': '黄体期情绪趋于平稳, 略感倦怠(经前阶段)',
};
/** 「周期影响」文本是否描述的是某个普通周期阶段(月经期/卵泡期/排卵期/黄体期) */
const CYCLE_STAGE_INFLUENCE_RE = /(月经期|卵泡期|排卵期|黄体期|经前期)/;
/**
 * 生理周期兜底校正: 以旧卡中(AI 维护的)"生理周期日期"到本次剧情结束时刻的
 * **日历日差**推进 Day/孕周, 纠正 AI 偶发失误(同一天/过一晚就 +1~+2 天)。
 * 仅供兜底——AI 自行正确推进时不冲突; 旧卡无基准/剧情时间不可解析/时间倒退时跳过。
 * - 同一日历日(未跨午夜): 强制 Day/孕周保持与旧卡一致(不改动)
 * - 跨过午夜进入新的一天(即使只差几分钟, 如 23:45 → 00:20): Day+1
 * - 过了几个日历日: Day = 旧Day + 日历日差, 超过锁定周期长度归零进入新周期; 孕期按总天数推进
 */
function correctPhysioByStoryTime(merged, oldCard, storyTimeText) {
    const oldDate = oldCard?.['生理周期日期'];
    if (!oldDate)
        return;
    const range = parseStoryTimeRange(storyTimeText);
    const endTs = range.endTs;
    // 兼容旧数据: 早期 fmtStoryTime 年份没补零(如 "137-06-12 07:45"), 补零到4位再解析
    const rawDate = String(oldDate).trim();
    let oldTs = parseStoryTime(rawDate);
    if (oldTs === null) {
        const m = rawDate.match(/^(\d{1,3})([-/.]\d)/);
        if (m)
            oldTs = parseStoryTime(m[1].padStart(4, '0') + m[2] + rawDate.slice(m[0].length));
    }
    if (endTs === null || oldTs === null)
        return;
    // 按日历日差推进(忽略时分): 跨午夜(23:45→00:20)算 1 天, 同日算 0 天。
    // 注意: 剧情时间与上次同刻或倒退(endTs <= oldTs)时**不跳过**——days 会被
    // Math.max(0) 压成 0, 强制把 Day/孕周拉回旧卡值, 防止 AI 乱写(如手动重更时
    // AI 把 Day6 又写成 Day20, 却因 endTs==oldTs 而跳过校正直接入库)。
    const days = Math.max(0, Math.round((dateOnlyTs(endTs) - dateOnlyTs(oldTs)) / 86400000));
    const oldPhy = String(oldCard?.['生理周期'] ?? '').trim();
    if (!oldPhy)
        return;
    // 孕期: 优先按「受孕日期」重算孕周 = (当前剧情结束日期 - 受孕日期)的天数,
    // 彻底不依赖 AI/旧卡孕周(它们可能被 AI 写快后越推越快)。
    // 无受孕日期(存量旧卡)时退回: 旧卡孕周 + 天数差。
    const oldPreg = oldPhy.match(/孕期\s*孕(\d+)\s*周\s*\+\s*(\d+)\s*天/);
    // 关键: 旧卡是孕期, 但 AI 已把生理周期改为**非孕期**(哺乳期/普通周期) = AI 明确结束
    // 孕期(剧情写了分娩/孩子出生)。此时**不强制改回孕期**——否则 AI 输出哺乳期会被
    // 下面的孕期分支(受孕日期重算/旧卡孕周推进)覆盖回孕期, 导致"分娩了还显示孕期"。
    if (oldPreg && !String(merged['生理周期'] ?? '').includes('孕期')) {
        return;
    }
    const pregDate = merged['受孕日期'] || oldCard?.['受孕日期'];
    if (pregDate) {
        const pregTs = parseStoryTime(String(pregDate).trim());
        if (pregTs !== null && endTs !== null && endTs > pregTs) {
            const totalDays = Math.max(0, Math.round((dateOnlyTs(endTs) - dateOnlyTs(pregTs)) / 86400000));
            merged['生理周期'] = `孕期 孕${Math.floor(totalDays / 7)}周+${totalDays % 7}天`;
            return;
        }
    }
    if (oldPreg) {
        const total = (+oldPreg[1]) * 7 + (+oldPreg[2]) + days;
        merged['生理周期'] = `孕期 孕${Math.floor(total / 7)}周+${total % 7}天`;
        return;
    }
    // 普通周期: 以旧卡 Day 为基准推进, 超过周期长度归零进入新周期
    const oldDay = extractCycleDay(oldPhy);
    const cycleLen = merged['周期长度'];
    if (oldDay === null || !cycleLen || typeof merged['生理周期'] !== 'string' || !merged['生理周期'])
        return;
    const newDay = ((oldDay - 1 + days) % cycleLen) + 1;
    merged['生理周期'] = String(merged['生理周期'])
        .replace(/Day\s*\d+(?:\/\d+)?/i, `Day ${newDay}/${cycleLen}`);
}
/** 「怀孕知晓」的合法取值: 反映 NPC 本人对自己怀孕的知晓程度(防全知) */
const PREGNANCY_KNOWN_UNKNOWN = '未知';
const PREGNANCY_KNOWN_SUSPECT = '疑似';
const PREGNANCY_KNOWN_CONFIRMED = '已确认';
const PREGNANCY_KNOWN_VALUES = [PREGNANCY_KNOWN_UNKNOWN, PREGNANCY_KNOWN_SUSPECT, PREGNANCY_KNOWN_CONFIRMED];
/**
 * 种族时间尺度字段: 由 AI 按 NPC 的种族/世界书设定填写(人类约 40 周 / 6 个月)。
 * 彼方**只用这两个数字做算术**, 不靠种族名字猜——查不到的种族一律不推断、不改写数据:
 * "孕程周数" = 从受孕到分娩的周数; "哺乳期月数" = 产后哺乳时长的月数。
 */
const RACE_SCALE_FIELDS = ['孕程周数', '哺乳期月数'];
/** 人类标准孕程(周)。**仅**用于「AI 未报告该 NPC 数值」时的兜底基准, 绝不用于强制改写已有数据 */
const GESTATION_WEEKS_HUMAN = 40;
/** 合法范围(周 / 月): 超出视为 AI 乱写, 与"未填写"同等对待 */
const GESTATION_WEEKS_RANGE = [1, 200];
const LACTATION_MONTHS_RANGE = [1, 120];
/** 解析受范围约束的正整数(兼容数字与数字字符串); 越界/非数字/缺失一律返回 null */
function parseBoundedInt(value: unknown, min: number, max: number): number | null {
    if (value === undefined || value === null)
        return null;
    const n = Number(String(value).trim());
    if (!Number.isFinite(n))
        return null;
    const i = Math.floor(n);
    return i >= min && i <= max ? i : null;
}
/** 归一化 AI 报来的时间尺度为规范数字字符串; 非法/越界返回 null(调用方应保留原值, 不写入) */
function normalizeRaceScale(field: string, raw: unknown): string | null {
    const range = field === '孕程周数' ? GESTATION_WEEKS_RANGE
        : field === '哺乳期月数' ? LACTATION_MONTHS_RANGE
            : null;
    if (!range)
        return null;
    const n = parseBoundedInt(raw, range[0], range[1]);
    return n === null ? null : String(n);
}
/** 读取「孕程周数」; 未填/非法返回 null = **没有依据** */
function extractGestationWeeks(card: Record<string, unknown> | null | undefined): number | null {
    return parseBoundedInt(card?.['孕程周数'], GESTATION_WEEKS_RANGE[0], GESTATION_WEEKS_RANGE[1]);
}
/** 读取「哺乳期月数」; 未填/非法返回 null = **没有依据** */
function extractLactationMonths(card: Record<string, unknown> | null | undefined): number | null {
    return parseBoundedInt(card?.['哺乳期月数'], LACTATION_MONTHS_RANGE[0], LACTATION_MONTHS_RANGE[1]);
}
/**
 * 哺乳期是否已超出该 NPC 的「哺乳期月数」(按 30 天/月计)。
 * 返回 null = **无从判断**(未填哺乳期月数, 或时间不可解析) → 调用方只告警, **绝不改写数据**;
 * 缺这个数字时唯一正确的默认是"不动手"(交回 AI 按种族设定处理), 而不是假人类 6 个月。
 */
function lactationExpired(startTs: number | null, endTs: number | null, card: Record<string, unknown> | null | undefined): boolean | null {
    const months = extractLactationMonths(card);
    if (months === null || startTs === null || endTs === null)
        return null;
    return endTs - startTs > months * 30 * 86400000;
}
/**
 * 按孕程比例判定「怀孕知晓」: 人类标准是孕 4 周起可能怀疑、6 周起才确认,
 * 这两个阈值按该 NPC 的「孕程周数」等比放大(孕程正好 40 周时与人类标准完全一致, 原行为不变)。
 * 未填孕程周数时退回人类标准: 这里是**补一个缺失字段**(非改写已有数据), 且下一轮 AI 会按种族更正;
 * 若留空反而会破坏「五、防全知」——主 AI 拿不到知晓度就会超前知情。
 */
function pregnancyKnowledgeByWeek(week: number | null, gestationWeeks: number | null | undefined): string {
    if (week === null)
        return PREGNANCY_KNOWN_UNKNOWN;
    const gestation = gestationWeeks ?? GESTATION_WEEKS_HUMAN;
    return week < 4 * gestation / GESTATION_WEEKS_HUMAN ? PREGNANCY_KNOWN_UNKNOWN
        : week < 6 * gestation / GESTATION_WEEKS_HUMAN ? PREGNANCY_KNOWN_SUSPECT
            : PREGNANCY_KNOWN_CONFIRMED;
}
/**
 * 防全知兜底: 保证孕期 NPC 一定有「怀孕知晓」字段(该字段只属于怀孕角色)。
 * - 未怀孕: 清理残留的知晓字段;
 * - 孕期但缺字段(存量旧卡升级): 按当前孕周推断初始知晓度——孕0~4周本人不知情(未知),
 *   孕4~6周停经开始怀疑(疑似), 孕6周+早孕反应/验孕早已确认(已确认), 符合现实认知。
 *   阈值按该 NPC 的「孕程周数」等比放大(见 pregnancyKnowledgeByWeek); 人类 40 周时结果与旧版一致。
 */
function ensurePregnancyKnowledge(merged) {
    const pregnant = String(merged['是否怀孕'] ?? '') === 'true' || String(merged['是否怀孕']) === '是' || String(merged['生理周期'] ?? '').includes('孕期');
    if (!pregnant) {
        delete merged['怀孕知晓'];
        return;
    }
    if (typeof merged['怀孕知晓'] === 'string' && merged['怀孕知晓'].trim())
        return;
    const week = extractPregnancyWeek(merged['生理周期']);
    merged['怀孕知晓'] = pregnancyKnowledgeByWeek(week, extractGestationWeeks(merged));
}

export {
    PHYSIO_FIELDS,
    PHYSIO_CYCLE_MIN,
    PHYSIO_CYCLE_MAX,
    extractCycleDay,
    calcConceptionRate,
    parseConceptionCount,
    applyConceptionCheck,
    parsePregnancyEventTime,
    extractPregnancyWeek,
    cycleStageName,
    CYCLE_STAGE_INFLUENCE,
    CYCLE_STAGE_INFLUENCE_RE,
    correctPhysioByStoryTime,
    PREGNANCY_KNOWN_UNKNOWN,
    PREGNANCY_KNOWN_SUSPECT,
    PREGNANCY_KNOWN_CONFIRMED,
    PREGNANCY_KNOWN_VALUES,
    RACE_SCALE_FIELDS,
    normalizeRaceScale,
    extractGestationWeeks,
    extractLactationMonths,
    lactationExpired,
    pregnancyKnowledgeByWeek,
    ensurePregnancyKnowledge,
};
