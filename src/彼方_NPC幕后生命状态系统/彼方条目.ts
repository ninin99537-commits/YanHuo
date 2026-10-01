// 彼方写进角色卡主世界书的那一条常驻条目: 叫什么名、怎么认出它、名字撞上别的脚本屏蔽词时改叫什么。
//
// 这三件事以前散在三个地方, 而且三份判定不一致:
// - worldbook.ts 里两份一模一样的(读世界书时"把自己排除", 免得把上一轮状态卡当设定);
// - worldbook-inject.ts 一份(注入时寻找/更新/删除自己那条), 少了"备注命中"与"内容开头"两样信号。
// 后果: 条目名被改到 comment 上(酒馆插件/用户改名都可能), 或只剩 extra 标记时, 读取那侧认得出来,
// 注入那侧认不出来 → 找不到既有条目 → 又建一条重复的。
//
// 现在四样信号合成一处判定: 正文开头 / 名字 / 备注 / 标记, 命中任意一样就算我们自己写的。
import { BIFANG_ENTRY_CONTENT_PREFIX } from './prompts';

/** 彼方写入角色卡主世界书的常驻条目名（用于识别、更新与排除）。
 * 注意: 数据库脚本(ACU)剧情推进会屏蔽名字含"状态/规则/变量/检定/叙事"等关键词的条目,
 * 因此条目名必须避开这些词, 否则剧情推进读不到。 */
const BIFANG_WORLDBOOK_ENTRY_NAME = '【彼方】NPC幕后生活';
/** 数据库脚本(ACU)剧情推进的"条目屏蔽"关键词：命中则条目不进剧情推进上下文 */
const ACU_BLOCKED_KEYWORDS = ['规则', '思维链', 'cot', 'MVU', 'mvu', '变量', '状态', 'Status', 'Rule', 'rule', '检定', '判断', '叙事', '文风', 'InitVar', '格式'];

/** 这条世界书条目是不是彼方自己写的。
 * 名字与备注都会因用户/插件操作而变, 正文开头是最强特征, 所以四样一起看。 */
function isBifangEntry(entry) {
    if (!entry)
        return false;
    const 正文 = String(entry.content || '').trim();
    return 正文.startsWith(BIFANG_ENTRY_CONTENT_PREFIX)
        || entry.name === BIFANG_WORLDBOOK_ENTRY_NAME
        || entry.comment === BIFANG_WORLDBOOK_ENTRY_NAME
        || entry.extra?.bifang === true;
}
/** 若条目名命中 ACU 屏蔽词(如旧名"…幕后NPC状态"含"状态"), 改回安全条目名, 否则保留用户自定义名 */
function sanitizeBifangEntryName(currentName) {
    const name = String(currentName || '').trim();
    return ACU_BLOCKED_KEYWORDS.some(keyword => name.includes(keyword)) ? BIFANG_WORLDBOOK_ENTRY_NAME : name;
}

export { ACU_BLOCKED_KEYWORDS, BIFANG_WORLDBOOK_ENTRY_NAME, isBifangEntry, sanitizeBifangEntryName };
