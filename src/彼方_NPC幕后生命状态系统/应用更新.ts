// 把模型的输出变成新的状态数据(候选2 拆出来的第二块)。
// 这一段以前和"取料/请求/收尾"一起挤在 updateNpcStates 里:
//   字段合并(mergeCard) / 改名归并(resolveRenamedNpc) / 统计与移除(applyUpdate),
//   以及三件只服务于它们的小工具(最近事件去重、剧情时间提示、接口地址脱敏)。
// 它们不碰平台(不需要宿主), 只做纯数据变换 —— 所以能单独读、单独验证。

import { APPEND_CARD_FIELDS, CARD_FIELDS, LEGACY_CARD_FIELDS } from './卡字段';
import { applyConceptionCheck, CYCLE_STAGE_INFLUENCE, correctPhysioByStoryTime, ensurePregnancyKnowledge, extractLactationMonths, extractPregnancyWeek, cycleStageName, lactationExpired, normalizeRaceScale, PHYSIO_CYCLE_MAX, PHYSIO_CYCLE_MIN, PHYSIO_FIELDS, PREGNANCY_KNOWN_CONFIRMED, PREGNANCY_KNOWN_SUSPECT, PREGNANCY_KNOWN_UNKNOWN, PREGNANCY_KNOWN_VALUES, RACE_SCALE_FIELDS } from './生理规则';
import { fmtStoryTime, parseStoryTime, parseStoryTimeRange, withStoryDate } from './剧情时间';
import { isReservedTopLevelKey } from './模型请求';

/** 脱敏接口地址(隐藏地址中可能携带的 token/key 查询参数), 用于错误日志。
 *  这行注释原先落在 update.ts 的 updateNpcStates 头上(从导出脚本还原时串了行, 文档挂到了它不描述的函数上), 这里归位。 */
function maskBaseUrl(url) {
    const value = String(url || '').trim();
    return value.replace(/([?&](?:key|token|api_key|apiKey|apikey)=)[^&]*/gi, '$1***');
}
/** 从正文/上下文中提取明确标注的"当前时间"(如 <time_format> 的 time 行、正文里的日期+时刻), 作为剧情时间的参考提示。
 *  **只从正文与上下文提取, 不读世界书**——世界书里的"当前时间"表/全局时间表是其他系统或彼方
 *  上次写入的推断值, 可能滞后或与正文不符, 作为"务必以此为准"的提示反而会把剧情时间带偏。 */
function extractCurrentTimeHint(_worldbook, reply, context) {
    const pad = (n) => String(n).padStart(2, '0');
    // 正文时间**只从 reply(最近回复)里提取**——worldbook/context 含彼方自己写的
    // "当前时间"固定标签(会干扰), 且拼接在 reply 之后, 取"最后一次"会取到它们。
    // reply 拼接顺序是"较早回复在前、最新回复在后", 最新正文在末尾, 取 reply 内最后一次出现的时间。
    const extractFrom = (text) => {
        if (!text)
            return '';
        // 1. 明确的"当前时间"标签(时间表列), 取最后一次出现
        for (const pattern of [/当前时间[^\d]*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]?\d{1,2}:\d{1,2})?)/g, /现在(?:是|为)?[^\d]*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]?\d{1,2}:\d{1,2})?)/g]) {
            const matches = [...text.matchAll(pattern)];
            if (matches.length > 0)
                return matches[matches.length - 1][1].replace(/[/.]/g, '-');
        }
        // 2. 中文格式: 2025年11月15日 ... 19:20-19:25 (时间段取结束时刻), 取最后一次
        const cnRe = /(\d{4})年(\d{1,2})月(\d{1,2})日[^\n]*?(\d{1,2}):(\d{1,2})(?:-(\d{1,2}):(\d{1,2}))?/g;
        const cnMatches = [...text.matchAll(cnRe)];
        if (cnMatches.length > 0) {
            const [, y, mo, d, h1, m1, h2, m2] = cnMatches[cnMatches.length - 1];
            const h = h2 ?? h1;
            const m = m2 ?? m1;
            return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(m)}`;
        }
        // 3. 数字格式(日期+时间), 取最后一次
        const numericRe = /(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]?\d{1,2}:\d{1,2})?)/g;
        const numericMatches = [...text.matchAll(numericRe)];
        if (numericMatches.length > 0)
            return numericMatches[numericMatches.length - 1][1].replace(/[/.]/g, '-');
        // 4. 特殊纪年/无标准日期的时间标注: "time:" 行取最后一行, 时间段取结束时刻
        const timeLines = [...text.matchAll(/time:([^\n]*)/gi)].map(match => match[1]);
        const timeLine = timeLines[timeLines.length - 1];
        if (timeLine) {
            const hm = timeLine.match(/(\d{1,2}):(\d{1,2})(?:-(\d{1,2}):(\d{1,2}))?/);
            if (hm) {
                const [, h1, m1, h2, m2] = hm;
                const h = h2 ?? h1;
                const m = m2 ?? m1;
                return `${pad(h)}:${pad(m)}`;
            }
        }
        // 5. 备选: 任意 "☆" 标注后的时分(时间段取结束时刻), 取最后一次
        const hm2Re = /☆[^\n]{0,80}?(\d{1,2}):(\d{1,2})(?:-(\d{1,2}):(\d{1,2}))?/g;
        const hm2Matches = [...text.matchAll(hm2Re)];
        if (hm2Matches.length > 0) {
            const [, h1, m1, h2, m2] = hm2Matches[hm2Matches.length - 1];
            const h = h2 ?? h1;
            const m = m2 ?? m1;
            return `${pad(h)}:${pad(m)}`;
        }
        return '';
    };
    // 优先 reply(最新正文), 其次 context(最近剧情上下文)——两者都是本聊天的
    // 实际剧情内容, 时间标注可信; 世界书不参与(见函数注释)
    const fromReply = extractFrom(reply);
    if (fromReply)
        return fromReply;
    return extractFrom(context);
}

/**
 * 近期关键事件的语义近似去重。
 *
 * AI 常把同一件事换一种说法再次返回，例如：
 * - 2026-05-20 因诊所宣传日需提早出门，临走前叮嘱家中孩子们
 * - 2026-05-20 因诊所宣传日提早出门上班
 *
 * 精确字符串去重认不出这种重复。这里用“同日期 + 最长公共连续文本占较短事件正文 >= 60%”
 * 判断为同一事件，并保留信息更完整（正文更长）的一条。不同日期永不合并。
 */
function dedupeRecentEvents(text) {
    const items = String(text ?? '').split(/[；;、\n]+/).map(item => item.trim()).filter(Boolean);
    const parse = (item) => {
        const match = item.match(/^(\d{4}-\d{1,2}-\d{1,2})\s*(.*)$/);
        return {
            date: match?.[1] ?? '',
            body: String(match?.[2] ?? item).replace(/[\s，。！？、；;,.!?：:的了需]/g, ''),
        };
    };
    const longestCommonSubstringLength = (a, b) => {
        if (!a || !b)
            return 0;
        const previous = new Array(b.length + 1).fill(0);
        let longest = 0;
        for (let i = 1; i <= a.length; i++) {
            const current = new Array(b.length + 1).fill(0);
            for (let j = 1; j <= b.length; j++) {
                if (a[i - 1] === b[j - 1]) {
                    current[j] = previous[j - 1] + 1;
                    longest = Math.max(longest, current[j]);
                }
            }
            for (let j = 0; j <= b.length; j++)
                previous[j] = current[j];
        }
        return longest;
    };
    const result = [];
    for (const item of items) {
        const candidate = parse(item);
        const duplicateIndex = result.findIndex(existing => {
            const prior = parse(existing);
            if (!candidate.date || candidate.date !== prior.date)
                return false;
            const shorter = Math.min(candidate.body.length, prior.body.length);
            return shorter > 0 && longestCommonSubstringLength(candidate.body, prior.body) / shorter >= 0.6;
        });
        if (duplicateIndex === -1) {
            result.push(item);
        }
        else if (item.length > result[duplicateIndex].length) {
            result[duplicateIndex] = item;
        }
    }
    return result.slice(-3).join('；');
}

function mergeCard(oldCard, update, storyTimeText = '') {
    const merged = { ...(oldCard ?? {}) };
    // 剧情时间已废弃独立记录(时间轴功能已下线), 不再写入状态卡; 顺带清理旧数据残留
    delete merged['剧情时间'];
    // 人设参考是发给 AI 的只读参考(每张卡附在末尾的世界书条目), AI 不应把它当字段返回——
    // 若 AI 误把它写进 JSON, 直接丢弃不合并, 防止它进入快照无限累积。
    delete merged['人设参考'];
    // 清理旧版字段(最近变化已从 CARD_FIELDS 移除)
    for (const legacyField of LEGACY_CARD_FIELDS) {
        delete merged[legacyField];
    }
    for (const key of CARD_FIELDS) {
        const value = update[key];
        if (typeof value === 'string' && value.trim()) {
            // 持有物/近期关键事件: 追加式合并, 不覆盖(见原则4.5一致性铁律)
            if (APPEND_CARD_FIELDS.includes(key)) {
                const oldText = String(merged[key] ?? '').trim();
                const newText = value.trim();
                if (!oldText) {
                    merged[key] = newText;
                }
                else if (key === '近期关键事件') {
                    // FIFO 最多3条, 新条目追加到末尾, 去重(避免AI重复返回已入库条目)
                    // 分隔符兼容: 提示词未强制, AI 可能用 ；、;、顿号、换行 分隔多条
                    const splitItems = (text) => text.split(/[；;、\n]+/).map(s => s.trim()).filter(Boolean);
                    const oldItems = splitItems(oldText);
                    const newItems = splitItems(newText);
                    const combined = [...oldItems];
                    for (const item of newItems) {
                        if (!combined.includes(item))
                            combined.push(item);
                    }
                    merged[key] = dedupeRecentEvents(combined.join('；'));
                }
                else {
                    // 持有物: 去重合并, 旧物品保留
                    // 分隔符兼容: 提示词要求顿号, 但 AI 可能用 , 、, 逗号、顿号、分号
                    const splitItems = (text) => text.split(/[、,，;；]+/).map(s => s.trim()).filter(Boolean);
                    const oldItems = splitItems(oldText);
                    const newItems = splitItems(newText);
                    const combined = [...oldItems];
                    for (const item of newItems) {
                        if (!combined.includes(item))
                            combined.push(item);
                    }
                    merged[key] = combined.join('、');
                }
            }
            else {
                // 生活状态: AI 若写了"今天/昨天 HH:mm"等相对时间, 用本次剧情时间补全为带日期格式
                merged[key] = key === '生活状态' ? withStoryDate(value.trim(), storyTimeText) : value.trim();
            }
        }
    }
    // 即使本轮 AI 没返回近期关键事件，也清理旧快照里已经存在的近义重复。
    if (merged['近期关键事件'])
        merged['近期关键事件'] = dedupeRecentEvents(merged['近期关键事件']);
    // 受孕事件: AI 报告的结构化对象(时间/对象/方式/防护/次数)或事件数组, 整块覆盖; 未报告则保留旧值
    let 本次有新受孕事件 = false;
    const evUpdate = update['受孕事件'];
    const evValid = !!evUpdate && typeof evUpdate === 'object'
        && (!Array.isArray(evUpdate) || evUpdate.some(item => item && typeof item === 'object' && !Array.isArray(item)));
    if (evValid) {
        merged['受孕事件'] = _.cloneDeep(evUpdate);
        本次有新受孕事件 = true;
    }
    if (merged['周期长度'] === undefined || merged['周期长度'] === null) {
        const hasPhysio = PHYSIO_FIELDS.some(field => merged[field] !== undefined && merged[field] !== null && String(merged[field] ?? '').trim() !== '');
        if (hasPhysio) {
            merged['周期长度'] = PHYSIO_CYCLE_MIN + Math.floor(Math.random() * (PHYSIO_CYCLE_MAX - PHYSIO_CYCLE_MIN + 1));
        }
    }
    // 种族时间尺度(「孕程周数」「哺乳期月数」): AI 按 NPC 种族/世界书设定填写, 只接受范围内的正整数。
    // 非法/缺失一律**保留原值**并告警——缺数字时彼方没有依据, 下游按"不推断、不改写"处理, 绝不默认人类。
    for (const scaleField of RACE_SCALE_FIELDS) {
        const rawScale = update[scaleField];
        if (rawScale === undefined)
            continue;
        const normalized = normalizeRaceScale(scaleField, rawScale);
        if (normalized === null) {
            console.warn(`[彼方] ${merged['曾用名'] || ''} 「${scaleField}」取值不合法(${rawScale}), 已忽略并保留原值`);
            continue;
        }
        merged[scaleField] = normalized;
    }
    // 受孕日期兜底(存量孕期卡): 孕期但缺「受孕日期」(旧版本受孕的卡)时, 用旧卡孕周反推
    // 受孕日 = 本次剧情结束时刻 - 孕周总天数, 作为后续孕周推进的绝对基准。
    // 必须放在 correctPhysioByStoryTime 之前, 让本次更新就能按受孕日期重算孕周。
    {
        const phyForPregDate = typeof merged['生理周期'] === 'string' ? merged['生理周期'] : '';
        if (phyForPregDate.includes('孕期') && !merged['受孕日期']) {
            const oldPhyStr = String(oldCard?.['生理周期'] ?? '');
            const oldWeekNum = extractPregnancyWeek(oldPhyStr);
            const oldDaysNum = oldPhyStr.match(/孕\s*\d+\s*周\s*\+\s*(\d+)\s*天/);
            const physioEndTs = parseStoryTimeRange(storyTimeText).endTs;
            if (physioEndTs !== null) {
                const totalDays = (oldWeekNum !== null ? oldWeekNum * 7 : 0) + (oldDaysNum ? +oldDaysNum[1] : 0);
                merged['受孕日期'] = fmtStoryTime(physioEndTs - totalDays * 86400000);
                console.info(`[彼方] ${merged['曾用名'] || ''} 孕期旧卡补记受孕日期=${merged['受孕日期']}`);
            }
        }
    }
    // 生理周期按剧情时间校正: 以"生理周期日期"到本次剧情时间的真实天数差强制修正 Day/孕周,
    // 防止 AI 凭轮次惯性乱跳(同一天多次变、过一晚+2)。放在受孕判定前, 让判定使用校正后的 Day。
    correctPhysioByStoryTime(merged, oldCard, storyTimeText);
    // 受孕判定: 由彼方代码执行(掷D100+算受孕率+更新是否怀孕), AI 只负责报告受孕事件。
    // **只对本次剧情时间窗口内新发生的受孕事件判定**——旧事件(如剧情已跨过一晚仍被 AI 沿用的)
    // 会被 applyConceptionCheck 按事件时间过滤掉, 避免同一事件反复掷骰刷怀孕。
    if (本次有新受孕事件)
        applyConceptionCheck(merged, oldCard, storyTimeText);
    // 一致性兜底: "是否怀孕=true"的角色, 生理周期必须是孕期文本——
    // 若 AI 误把孕期写成普通周期(如"排卵期 Day 12/25", 非哺乳期), 强制改回孕期; 孕周优先从旧卡恢复。
    // 反向: 生理周期已是孕期但"是否怀孕"未标记, 补标记为 true。
    // 例外: 生理周期为「哺乳期」= AI 明确结束孕期(剧情已分娩), 强制补 是否怀孕=false 并清残留,
    // 不得恢复孕期——否则"分娩了还显示孕期"。
    const isPregnantNow = String(merged['是否怀孕'] ?? '') === 'true' || String(merged['是否怀孕']) === '是';
    const phyNow = typeof merged['生理周期'] === 'string' ? merged['生理周期'] : '';
    if (phyNow.includes('哺乳期')) {
        merged['是否怀孕'] = 'false';
        delete merged['受孕日期'];
        delete merged['怀孕知晓'];
        // 记录哺乳期开始日期(首次进入时, 供后续判断哺乳期是否超期)
        const physioEndNow = parseStoryTimeRange(storyTimeText).endTs;
        if (!merged['哺乳期开始日期'] && physioEndNow !== null)
            merged['哺乳期开始日期'] = fmtStoryTime(physioEndNow);
        // 哺乳期超期处理: 时长按该 NPC 的「哺乳期月数」(AI 按种族/世界书设定填写, 人类约 6)判定, 30 天/月。
        // 剧情大跳跃(如3年后)且 AI 未推进时, 强制恢复普通周期(月经期 Day 1, 产后月经恢复的合理起点),
        // 之后由校正/AI 按"生理周期日期"正常推进。
        // **未填「哺乳期月数」= 彼方没有依据 → 只告警、绝不改数据**, 交回 AI 按种族设定决定。
        // (这里以前硬编码 180 天, 等于把人类时长套给所有种族——龙族/天使等更长的会被错误地强制恢复)
        const lactStartRaw = String(merged['哺乳期开始日期'] ?? '').trim();
        if (lactStartRaw && physioEndNow !== null) {
            const lactStartTs = parseStoryTime(lactStartRaw);
            const expired = lactationExpired(lactStartTs, physioEndNow, merged);
            if (expired === true) {
                merged['生理周期'] = `月经期 Day 1/${merged['周期长度'] || 28}`;
                delete merged['哺乳期开始日期'];
                // 阶段联动: 哺乳期强制恢复普通周期后, 原"周期影响"(哺乳相关描述)已不适用
                if (typeof merged['周期影响'] === 'string' && merged['周期影响'].includes('哺乳'))
                    merged['周期影响'] = CYCLE_STAGE_INFLUENCE['月经期'];
                console.warn(`[彼方] ${merged['曾用名'] || ''} 哺乳期已超过${extractLactationMonths(merged)}个月(自${lactStartRaw}), 已恢复普通周期(月经期 Day 1)`);
            }
            else if (expired === null) {
                console.info(`[彼方] ${merged['曾用名'] || ''} 哺乳期时长无从判断(未填「哺乳期月数」或时间不可解析), 不改写, 交回 AI 按种族设定处理(自${lactStartRaw})`);
            }
        }
    }
    else if (isPregnantNow && !phyNow.includes('孕期')) {
        // 旧卡是否孕期: 是 → AI 误把孕期改成普通周期, 强制恢复; 否 → AI 无受孕判定
        // 依据凭空写"是否怀孕=true", 纠正回 false(防止"之前怀孕的角色又怀孕")
        const oldCardIsPreg = String(oldCard?.['是否怀孕'] ?? '') === 'true' || String(oldCard?.['是否怀孕']) === '是' || String(oldCard?.['生理周期'] ?? '').includes('孕期');
        if (oldCardIsPreg) {
            const oldWeek = extractPregnancyWeek(String(oldCard?.['生理周期'] ?? ''));
            merged['生理周期'] = oldWeek !== null ? `孕期 孕${oldWeek}周+0天` : `孕期 孕0周+0天`;
            console.warn(`[彼方] ${merged['曾用名'] || ''} 生理周期被AI写回普通周期, 已强制恢复为孕期`);
        }
        else {
            merged['是否怀孕'] = 'false';
            console.warn(`[彼方] ${merged['曾用名'] || ''} AI 无受孕判定依据把"是否怀孕"写成 true, 已纠正为 false`);
        }
    }
    else if (!isPregnantNow && phyNow.includes('孕期')) {
        merged['是否怀孕'] = 'true';
        console.warn(`[彼方] ${merged['曾用名'] || ''} 生理周期为孕期但"是否怀孕"未标记, 已补标记`);
    }
    // 结束孕期后的清理: 生理周期既非孕期也非哺乳期(已结束孕期/恢复普通周期)时,
    // 受孕日期不应残留——否则旧卡会带着过期的受孕日期(如三年后已分娩却还留着三年前的受孕日期)
    if (!phyNow.includes('孕期') && !phyNow.includes('哺乳期'))
        delete merged['受孕日期'];
    // 怀孕知晓: AI 维护的 NPC 自我认知字段(仅孕期角色), 只接受合法取值, 非法/空值忽略(走下方兜底)
    // 单向闸: 只能 未知→疑似→已确认 前进, 不能倒退(AI 误标"未知"为"已确认"时拦截)
    if (update['怀孕知晓'] !== undefined) {
        const known = String(update['怀孕知晓'] ?? '').trim();
        if (PREGNANCY_KNOWN_VALUES.includes(known)) {
            const oldKnown = String(merged['怀孕知晓'] ?? '').trim();
            const order = { [PREGNANCY_KNOWN_UNKNOWN]: 0, [PREGNANCY_KNOWN_SUSPECT]: 1, [PREGNANCY_KNOWN_CONFIRMED]: 2 };
            const oldIdx = order[oldKnown] ?? -1;
            const newIdx = order[known] ?? -1;
            if (newIdx >= oldIdx) {
                merged['怀孕知晓'] = known;
            }
            else {
                console.warn(`[彼方] ${merged['曾用名'] || ''} 怀孕知晓倒退被拦截(${oldKnown}→${known}), 保持旧值`);
            }
        }
    }
    // 防全知兜底: 未怀孕清理该字段; 孕期缺该字段(旧卡升级)按孕周补初始知晓度
    ensurePregnancyKnowledge(merged);
    // 哺乳期开始日期清理: 不再处于哺乳期时清除(哺乳期已结束/从未进入)
    if (!String(merged['生理周期'] ?? '').includes('哺乳期'))
        delete merged['哺乳期开始日期'];
    // 生理周期字段的分母修正: AI 常惯性写 "Day X/28", 但周期长度是锁定的个体值(21~35)。
    // 这里用锁定的周期长度自动替换分母, 不依赖 AI 自觉——保证排卵日计算(锁定长度-14)正确。
    if (merged['周期长度'] && typeof merged['生理周期'] === 'string' && merged['生理周期']) {
        const lockedLen = merged['周期长度'];
        // 匹配 "Day X/任意分母" 或 "Day X" 后补分母; 孕期文本不动(没有 Day 结构)
        merged['生理周期'] = String(merged['生理周期'])
            .replace(/Day\s*\d+\/\d+/gi, (m) => m.replace(/\/\d+$/, `/${lockedLen}`));
    }
    // 阶段名重算(与提示词阶段判定规则一致, 排卵日=周期长度-14): 阶段由 Day 决定,
    // 防止 AI 惯性写错阶段名——如 "Day 22/22" 却被写成排卵期(实际排卵期只有排卵日±1)。
    // 放在分母修正之后, 此时 Day 为最终值。孕期文本没有 Day 结构, 不受影响。
    {
        const finalPhy = typeof merged['生理周期'] === 'string' ? merged['生理周期'] : '';
        const dayOnly = finalPhy.match(/Day\s*(\d+)/i);
        if (dayOnly && merged['周期长度']) {
            const stage = cycleStageName(+dayOnly[1], merged['周期长度']);
            const stageRe = /^(月经期|卵泡期|排卵期|黄体期|经前期|孕期|哺乳期)\s*/;
            const oldStageMatch = finalPhy.match(stageRe);
            const oldStage = oldStageMatch ? oldStageMatch[1] : '';
            merged['生理周期'] = oldStage
                ? finalPhy.replace(stageRe, `${stage} `)
                : `${stage} ${finalPhy}`;
            // 阶段被修正时联动「周期影响」: AI 的"周期影响"是按它写的(错误)阶段撰写的,
            // 彼方修正阶段名后二者矛盾(如写了排卵期影响、实际已是黄体期)——
            // 影响文本包含旧阶段名时, 用新阶段的通用描述覆盖(下一轮 AI 可按剧情自然细化)。
            if (oldStage && oldStage !== stage
                && typeof merged['周期影响'] === 'string' && merged['周期影响'].includes(oldStage)) {
                merged['周期影响'] = CYCLE_STAGE_INFLUENCE[stage];
                console.warn(`[彼方] ${merged['曾用名'] || ''} 生理周期阶段被修正(${oldStage}→${stage}), "周期影响"已同步替换`);
            }
        }
    }
    // 清理旧版生理字段残留(累计受孕率/受孕率记录/生理结算 已被新系统取代)
    delete merged['累计受孕率'];
    delete merged['受孕率记录'];
    delete merged['生理结算'];
    // 清理已下线的「可能偶遇」字段: 主 AI 通过"位置+当前在做"即可推断偶遇可能性,
    // 单独维护布尔字段反而容易出现"位置在公司但可能偶遇=true"的矛盾
    delete merged['可能偶遇'];
    // 曾用名: AI 在改名时标注的旧名(如"林姐"其实是"林淑仪"), 保留供彼方识别与合并
    if (update['曾用名'] && typeof update['曾用名'] === 'string' && update['曾用名'].trim()) {
        merged['曾用名'] = update['曾用名'].trim();
    }
    // 生理周期日期: 由彼方代码维护的只读参考字段——记录"上次推进到哪一天"的剧情结束时刻,
    // 供 AI 按真实天数差推进 Day/孕周(防跳天), 也供 correctPhysioByStoryTime 校正。
    // 关键: **剧情时间倒退/同刻时保留旧基准, 不回退**——否则重roll/删楼层后基准变小,
    // 之后 days 从倒退日期算起会虚增, Day 越推越快。
    const hasPhysioNow = PHYSIO_FIELDS.some(field => merged[field] !== undefined && merged[field] !== null && String(merged[field] ?? '').trim() !== '');
    if (hasPhysioNow) {
        const physioRange = parseStoryTimeRange(storyTimeText);
        if (physioRange.endTs) {
            const curPhysioTs = physioRange.endTs;
            const oldPhysioRaw = merged['生理周期日期'] ? String(merged['生理周期日期']).trim() : '';
            let oldPhysioTs = oldPhysioRaw ? parseStoryTime(oldPhysioRaw) : null;
            if (oldPhysioTs === null) {
                const m = oldPhysioRaw.match(/^(\d{1,3})([-/.]\d)/);
                if (m)
                    oldPhysioTs = parseStoryTime(m[1].padStart(4, '0') + m[2] + oldPhysioRaw.slice(m[0].length));
            }
            if (oldPhysioTs === null || curPhysioTs >= oldPhysioTs)
                merged['生理周期日期'] = fmtStoryTime(curPhysioTs);
        }
    }
    else {
        delete merged['生理周期日期'];
    }
    merged['最后更新'] = Date.now();
    return merged;
}

/**
 * 处理 NPC 改名合并: AI 输出状态卡时若带「曾用名」, 且该曾用名正好是已建档的旧卡 key,
 * 说明正文揭示了同一角色的真实姓名(如"林姐"→"林淑仪")。此时:
 * - 把旧卡内容作为合并基底(mergeCard 的 oldCard), 新卡字段覆盖旧卡 → 状态连续不割裂
 * - 删除旧卡 key, 名单同步用新名替换旧名, 避免两张卡并存/名单重复
 * 返回 { name, oldCard } 供调用方 mergeCard 使用; 无改名时返回原 name + 原旧卡。
 */
function resolveRenamedNpc(newData, name, card, playerName) {
    const alias = String(card?.['曾用名'] ?? '').trim();
    if (alias && alias !== name && alias !== playerName && newData.NPC[alias] && !newData.NPC[name]) {
        console.info(`[彼方] NPC改名合并: ${alias} → ${name}, 旧卡状态并入新卡`);
        const oldCard = newData.NPC[alias];
        delete newData.NPC[alias];
        newData.名单 = newData.名单.map(n => (n === alias ? name : n));
        return { name, oldCard };
    }
    return { name, oldCard: newData.NPC[name] };
}

function applyUpdate(data, parsed, timeJump = null, playerName = null, autoTrack = true) {
    const newData = {
        ...data,
        名单: [...data.名单],
        NPC: _.cloneDeep(data.NPC),
        卡字段计数: _.cloneDeep(data.卡字段计数 ?? {}),
        统计: { ...data.统计 },
    };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return newData;
    const storyRange = parseStoryTimeRange(parsed['剧情时间']);
    const storyTimeText = storyRange.text;
    if (!storyTimeText) {
        // AI 完全省略"剧情时间"时静默通过会导致生理推进失去基准, 至少留一条警告
        console.warn('[彼方] AI 输出缺少"剧情时间", 生理周期推进将使用旧基准');
    }
    if (storyTimeText)
        newData.剧情时间 = storyTimeText;
    let npcUpdates;
    if (typeof parsed['NPC'] === 'object' && parsed['NPC'] !== null && !Array.isArray(parsed['NPC'])) {
        npcUpdates = parsed['NPC'];
    }
    else {
        npcUpdates = { ...parsed };
        delete npcUpdates['在场NPC'];
        delete npcUpdates['剧情时间'];
    }
    // 「自动建档」关闭时: 只允许合并**已追踪**的 NPC(名单内或已有卡), AI 返回的新角色一律跳过——
    // 已有卡但不在名单的(如改名后的新键)仍放行, 由 resolveRenamedNpc 的改名合并逻辑处理
    const isTrackedNpc = (name) => newData.名单.includes(name) || !!newData.NPC[name];
    const skippedNewNpcs = [];
    const updatedNames = [];
    for (const [name, card] of Object.entries(npcUpdates)) {
        // 顶层保留键(防止 AI 误把受孕事件/剧情时间/思考流程等放顶层被当成 NPC 建档)
        if (isReservedTopLevelKey(name)
            || typeof card !== 'object' || card === null || Array.isArray(card))
            continue;
        // 主角: 跳过合并, 并清理误建的主角卡/名单项
        if (playerName && name === playerName) {
            delete newData.NPC[name];
            newData.名单 = newData.名单.filter(n => n !== name);
            continue;
        }
        // 自动建档关闭: 新角色(未在名单且无卡)不建档不追踪, 记录后跳过
        if (!autoTrack && !isTrackedNpc(name)) {
            skippedNewNpcs.push(name);
            continue;
        }
        const resolved = resolveRenamedNpc(newData, name, card, playerName);
        newData.NPC[resolved.name] = mergeCard(resolved.oldCard, card, storyTimeText);
        updatedNames.push(resolved.name);
        if (!newData.名单.includes(resolved.name))
            newData.名单.push(resolved.name);
    }
    // 兼容旧版输出格式: 旧提示词会让 AI 返回「在场NPC」数组(对象=完整状态卡), 照常建档合并,
    // 不丢数据; 新提示词不再要求该数组, 所有 NPC 一律顶层返回
    if (Array.isArray(parsed['在场NPC'])) {
        for (const item of parsed['在场NPC']) {
            if (!item || typeof item !== 'object' || Array.isArray(item))
                continue;
            // 优先取 "姓名/名字" 字段; 没有则把对象里第一个键当作 NPC 名, 其值为状态卡
            let name = String(item['姓名'] ?? item['名字'] ?? '').trim();
            let card = item;
            if (!name) {
                const first = Object.entries(item).find(([key, value]) => key !== '姓名' && key !== '名字' && value && typeof value === 'object');
                if (first) {
                    name = String(first[0]).trim();
                    card = first[1];
                }
            }
            if (name && name !== playerName) {
                // 自动建档关闭: 旧格式数组里的新角色同样不建档
                if (!autoTrack && !isTrackedNpc(name)) {
                    skippedNewNpcs.push(name);
                    continue;
                }
                const resolved = resolveRenamedNpc(newData, name, card, playerName);
                newData.NPC[resolved.name] = mergeCard(resolved.oldCard, card, storyTimeText);
                if (!updatedNames.includes(resolved.name))
                    updatedNames.push(resolved.name);
                if (!newData.名单.includes(resolved.name))
                    newData.名单.push(resolved.name);
            }
        }
    }
    const removedNpcs = [];
    if (typeof parsed['移除NPC'] !== 'undefined') {
        removedNpcs.push(...(Array.isArray(parsed['移除NPC']) ? parsed['移除NPC'].map(String).filter(Boolean) : []));
    }
    for (const name of removedNpcs) {
        delete newData.NPC[name];
        delete newData.卡字段计数[name];
    }
    if (removedNpcs.length > 0) {
        newData.名单 = newData.名单.filter(name => !removedNpcs.includes(name));
    }
    // 自动建档关闭时, 提示本次被跳过的新角色(仅提示, 不影响其他更新)
    if (skippedNewNpcs.length > 0) {
        console.info(`[彼方] 「自动建档」已关闭, 本次跳过新角色(未建档): ${skippedNewNpcs.join('、')}`);
    }
    // 已追踪但本次整卡未被 AI 返回的 NPC: 警告(增量更新下核心三字段应每次必返, 整卡省略=状态停留旧值——
    // 如大幅时间跳跃时 AI 只更新了部分 NPC, 其余卡会停留在上次日期)
    const notUpdatedNpcs = newData.名单.filter(name => !updatedNames.includes(name) && !removedNpcs.includes(name));
    if (notUpdatedNpcs.length > 0) {
        console.warn(`[彼方] 以下已追踪NPC本次整卡未返回(状态保持旧值, 剧情已推进时可能漏更新): ${notUpdatedNpcs.join('、')}`);
    }
    newData.统计.更新次数 = (newData.统计.更新次数 ?? 0) + 1;
    newData.统计.最后更新 = Date.now();
    return newData;
}

export { applyUpdate, extractCurrentTimeHint, maskBaseUrl };
