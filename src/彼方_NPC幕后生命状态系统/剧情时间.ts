// 彼方 · 剧情时间: 解析 / 格式化 / 日历日差(纯函数, 不依赖酒馆平台)
// 从 update.ts 原样搬出(仅改归属, 行为未变)。剧情时间是彼方的全局基准——受孕日期、
// 生理周期日期、哺乳期到期、生活状态日期都按它计算, 因此解析规则收在这一个模块里。

/**
 * 时间戳的"日期"部分时间戳(忽略时分, 用于按**日历日**计算天数差)。
 * 用 setFullYear 构造, 避免 JS 对 0~99 年份自动映射到 1900+。
 */
function dateOnlyTs(ts) {
    const d = new Date(ts);
    const t = new Date(0);
    t.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    return t.getTime();
}
/**
 * 把生活状态里的相对时间("今天18:45"/"今天18点45"/"昨天15:30"等)补全为**剧情日期**。
 * 剧情日期取自本次更新的剧情时间文本(storyTimeText, 形如 "2026-08-15 18:41 至 2026-08-15 18:48"),
 * 取结束时刻所在日期作为"今天", 前一天作为"昨天"。
 */
function withStoryDate(text, storyTimeText) {
    if (!text || !storyTimeText)
        return text;
    // 从剧情时间文本里提取日期(取最后一个出现的 YYYY-MM-DD, 通常为结束时刻)
    const dates = String(storyTimeText).match(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g);
    if (!dates || dates.length === 0)
        return text;
    const lastDate = dates[dates.length - 1].replace(/[./]/g, '-');
    const parts = lastDate.split('-');
    const today = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    // 昨天 = 剧情日期 - 1 天
    const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    d.setDate(d.getDate() - 1);
    const yesterday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return String(text)
        .replace(/今天\s*(\d{1,2})\s*[:：]\s*(\d{1,2})/g, `${today} $1:$2`)
        .replace(/今天\s*(\d{1,2})\s*点\s*(\d{1,2})?\s*分?/g, (_, h, m) => `${today} ${h}:${m ? m.padStart(2, '0') : '00'}`)
        .replace(/昨天\s*(\d{1,2})\s*[:：]\s*(\d{1,2})/g, `${yesterday} $1:$2`)
        .replace(/昨天\s*(\d{1,2})\s*点\s*(\d{1,2})?\s*分?/g, (_, h, m) => `${yesterday} ${h}:${m ? m.padStart(2, '0') : '00'}`);
}
/** 解析剧情时间为时间戳（支持 YYYY-MM-DD HH:mm、YYYY.MM.DD HH:mm、YYYY/MM/DD 等，分钟可省略）。
 * 年份固定 4 位数字(如 0004/0025/0137); 用 setFullYear 构造, 避免 JS 对 0~99 年份自动映射到 1900+ */
function parseStoryTime(text) {
    const t = text.trim().replace(/[./]/g, '-');
    const match = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?$/);
    if (!match)
        return null;
    const [, year, month, day, hour, minute] = match;
    const d = new Date(0);
    d.setFullYear(+year, +month - 1, +day);
    d.setHours(+(hour ?? 0), +(minute ?? 0), 0, 0);
    const ts = d.getTime();
    return Number.isNaN(ts) ? null : ts;
}
/** 时间戳格式化为 "YYYY-MM-DD HH:mm"（年份固定 4 位补零, 如 0137-06-12 07:45） */
function fmtStoryTime(ts) {
    const date = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** 解析 AI 返回的"剧情时间"（兼容字符串或 {开始, 结束} 对象）为起止时间戳 */
function parseStoryTimeRange(raw) {
    if (typeof raw === 'string') {
        const text = raw.trim();
        // 兼容 "开始 至 结束" 时间段字符串(如 mergeCard 收到的 storyTimeText):
        // 拆成起止两段分别解析, 否则整串解析失败 → startTs=null, 受孕判定的窗口过滤会失效
        const parts = text.split(/\s*(?:至|到|~)\s*/);
        if (parts.length >= 2) {
            const start = parts[0].trim().replace(/[./]/g, '-');
            const end = parts[parts.length - 1].trim().replace(/[./]/g, '-');
            return { text, startTs: parseStoryTime(start), endTs: parseStoryTime(end) };
        }
        const ts = text ? parseStoryTime(text) : null;
        return { text, startTs: ts, endTs: ts };
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const start = String(raw['开始'] ?? '').trim();
        const end = String(raw['结束'] ?? '').trim();
        const text = start && end && start !== end ? `${start} 至 ${end}` : end || start;
        return { text, startTs: parseStoryTime(start), endTs: parseStoryTime(end) };
    }
    return { text: '', startTs: null, endTs: null };
}

export { dateOnlyTs, fmtStoryTime, parseStoryTime, parseStoryTimeRange, withStoryDate };
