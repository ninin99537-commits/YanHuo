// 依赖按实际用到的符号具名导入(形态守卫见 tests/no-bundle-artifacts.test.ts)
import { chatCompletion } from './api';
import { getSettings } from './settings';
import { syncNpcStatesWorldbook } from './worldbook-inject';
import { writeStateSnapshot } from './快照';
import { useStateStore } from './数据仓';
import { useDebugStore } from './日志仓';
import { useUpdatingStore } from './任务中断';
import { toastError, toastInfo, toastSuccess, toastWarning } from './toast';
import { useHost } from './host';
import { THINKING_FIELD_KEYS, 请求并校验 } from './模型请求';
import { applyUpdate, extractCurrentTimeHint, maskBaseUrl } from './应用更新';
import { 收集本轮输入 } from './更新输入';

// 这里属于流水线顶层(收尾时要写世界书), 按边界处理, 所以自己构造一次真实宿主。
// 待 updateNpcStates 拆分(候选2)后, 宿主应从调用方传进来, 而不是在本文件里自己造。
// 当前宿主: 在 updateNpcStates 开头重新取一次(用例会替换它, 见 host.ts 的 injectHostForTest)。
// 刻意不在模块加载时抓死: 那样用例注入的假平台到不了这条流水线, 整条更新流程就只能靠真酒馆验证。
let host = useHost();

let isUpdating = false;
const TIME_JUMP_PATTERN = /(一夜之间|第二天一早|第二天|次日|隔天|几天后|数天后|十几天后|一两周后|两周后|几周后|数周后|几个星期后|几个礼拜后|一个月后|两个月后|数月后|几个月后|半年后|一年后|两年后|几年后|数年后|多年后|若干年后)/;
function detectTimeJump(text) {
    const match = text.match(TIME_JUMP_PATTERN);
    return match ? match[0] : null;
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function stripTagContent(text, tag) {
    const escaped = escapeRegExp(tag);
    // 边界排除 ASCII 字母/数字/下划线/连字符: \b 只对 ASCII 有效, 中文标签需自定边界;
    // 必须排除 _ 和 -, 否则标签 "summary" 会误匹配 "<summary_format>"(下划线不算字母数字),
    // 导致 summary_format 块被当作 summary 误删
    const boundary = '(?![a-zA-Z0-9_-])';
    let result = text.replace(new RegExp(`<${escaped}${boundary}[^>]*>[\\s\\S]*?<\\/${escaped}>`, 'gi'), '');
    result = result.replace(new RegExp(`<${escaped}${boundary}[^>]*\\/?>`, 'gi'), '');
    return result;
}
function extractTagContent(text, tag) {
    const escaped = escapeRegExp(tag);
    const boundary = '(?![a-zA-Z0-9_-])';
    const matches = [];
    const re = new RegExp(`<${escaped}${boundary}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'gi');
    let match;
    while ((match = re.exec(text)) !== null) {
        matches.push(match[1].trim());
    }
    return matches;
}
/**
 * 清除"孤立闭合标签"(只有 </tag> 没有配对 <tag> 的残留)。
 * **只删除闭合标签本身, 绝不从文本开头删到它**——否则正文里若出现某个过滤标签的
 * 孤立闭合(如模型残留 </summary_format> 或正文合法出现的 </xxx>), 会把整段正文删光。
 * (旧逻辑"从楼层开头删到闭合标签"针对无开标签的思维链, 但误伤正文, 已废弃)
 */
function stripLoneClosingBlocks(text, tag) {
    const escaped = escapeRegExp(tag);
    const boundary = '(?![a-zA-Z0-9_-])';
    const closeRe = new RegExp(`</${escaped}${boundary}[^>]*>`, 'gi');
    return text.replace(closeRe, '');
}
function createTextFilter(settings) {
    const tags = (settings.标签?.列表 ?? []).map(tag => tag.trim().replace(/^<|>$/g, '')).filter(Boolean);
    // 去掉 begin_of_X ... end_of_X 的思维链整块（标记是注释、内容却是纯文本，需连同内容一起删）；再清理剩余 HTML 注释
    // (正文中的创作注释如 <!-- 模拟段落 -->/<!-- 草稿优化 --> 等一律删除; 无论标签模式是排除还是只读都删)
    const stripComments = (text) => text
        .replace(/<!--\s*begin_of_[a-zA-Z0-9_\u4e00-\u9fa5]+[\s\S]*?end_of_[a-zA-Z0-9_\u4e00-\u9fa5]+\s*-->/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');
    if (tags.length === 0)
        return stripComments;
    if (settings.标签?.模式 === '只读') {
        return text => {
            const parts = [];
            for (const tag of tags)
                parts.push(...extractTagContent(text, tag));
            return stripComments(parts.join('\n\n') || text);
        };
    }
    return text => stripComments(tags.reduce((acc, tag) => stripLoneClosingBlocks(stripTagContent(acc, tag), tag), text));
}
function isNameMentioned(text, name) {
    const trimmed = name.trim();
    if (!trimmed)
        return false;
    if (trimmed.length >= 2)
        return text.includes(trimmed);
    return new RegExp(`(^|[^\\p{L}])${trimmed}([^\\p{L}]|$)`, 'u').test(text);
}
function collectTrackedNpcs(settings, data) {
    const names = new Set();
    for (const name of data.名单) {
        const trimmed = name.trim();
        if (trimmed)
            names.add(trimmed);
    }
    if (settings.更新.追踪当前角色) {
        const characterName = host.character.name();
        if (characterName)
            names.add(characterName);
    }
    return [...names];
}
function getRecentAssistantMessages(count) {
    try {
        const lastId = host.chat.lastMessageId();
        if (lastId < 0)
            return [];
        // 循环扩大窗口直到取够 N 条可见 AI 回复(或扫完整个聊天)。
        // 旧版固定 count*10 窗口, 隐藏楼层多时会取不够导致本轮更新被跳过。
        let window = Math.max(count * 4, 10);
        for (;;) {
            const start = Math.max(0, lastId - window);
            const messages = host.chat.messages(`${start}-${lastId}`, { role: 'assistant' });
            const visible = messages.filter(message => !message.is_hidden);
            if (visible.length >= count || start === 0)
                return visible.slice(-count);
            window *= 2;
        }
    }
    catch {
        return [];
    }
}
function buildContext(replyMessageId, filter, window, replyIds, minId = 0) {
    try {
        const lastId = host.chat.lastMessageId();
        const start = Math.max(0, Math.min(replyMessageId, lastId) - window * 2);
        const messages = host.chat.messages(`${start}-${lastId}`)
            .filter(message => message.role !== 'system' && !message.is_hidden && message.message_id > minId && !replyIds.has(message.message_id))
            .slice(-window);
        return messages
            .map(message => `${message.role === 'user' ? '玩家' : message.name || 'AI'}: ${filter(message.message)}`)
            .join('\n\n');
    }
    catch {
        return '';
    }
}
let allAssistantCache = null;
function getAllAssistantMessages() {
    try {
        const lastId = host.chat.lastMessageId();
        if (allAssistantCache && allAssistantCache.lastId === lastId)
            return allAssistantCache.messages;
        if (lastId <= 0)
            return [];
        const messages = host.chat.messages(`0-${lastId}`, { role: 'assistant' }).filter(message => !message.is_hidden);
        allAssistantCache = { lastId, messages };
        return messages;
    }
    catch {
        return [];
    }
}
/** 供 index.ts 等外部调用(更新频率判定): 带缓存的全部可见 AI 楼层 */
function getAllAssistantMessagesCached() {
    return getAllAssistantMessages();
}
async function updateNpcStates(force = false) {
    if (isUpdating) {
        console.warn('[彼方] 上一次更新尚未完成, 已跳过本次更新');
        return;
    }
    isUpdating = true;
    host = useHost();
    // 分段计时: 定位"更新慢"的瓶颈(前置/世界书激活/接口请求/解析应用/收尾)
    const timing = { start: Date.now(), 前置: 0, 世界书: 0, 请求: 0, 请求次数: 0, 解析应用: 0, 收尾: 0 };
    const debugStore = useDebugStore();
    const updatingStore = useUpdatingStore();
    const abortSignal = updatingStore.start('正在分析最近楼层…', '幕后');
    let parsed = null;
    let parseError = null;
    try {
        const settings = getSettings();
        const { 地址, 模型 } = settings.接口;
        if (!地址 || !模型) {
            toastWarning('彼方: 尚未配置接口地址或模型, 请先在设置中完成配置', '彼方');
            return;
        }
        const 输入 = await 收集本轮输入({
            host, settings, force, timing, debugStore,
            依赖: {
                过滤: createTextFilter, 追踪: collectTrackedNpcs, 名字出现: isNameMentioned,
                最近回复: getRecentAssistantMessages, 上下文: buildContext,
                时间提示: extractCurrentTimeHint, 时间跳跃: detectTimeJump,
            },
        });
        if (!输入) return; // 前置条件不满足(如没有可用的 AI 回复): 上面已经提示过用户
        const { 锚点, data, messages, playerName, recent, timeJump } = 输入;
        let 请求结果;
        try {
            // 取模型输出这一段已独立成模块(模型请求.ts): 发请求 → 解析 → 校验, 不合格就带着错误原因重试
            请求结果 = await 请求并校验({
                messages,
                锚点,
                预填充: settings.更新.预填充,
                现有卡: data.NPC ?? {},
                名单: data.名单 ?? [],
                玩家名: playerName,
                自动建档: settings.更新.自动建档 !== false,
                signal: abortSignal,
                发请求: chatCompletion,
                记日志: (partial) => debugStore.record(partial),
                报进度: (文字) => { updatingStore.message = 文字; },
            });
        }
        catch (error) {
            // 记下来给外层 catch 判定失败阶段用(与拆分前口径一致: 取模型输出这步失败就记作 JSON 解析)
            parseError = error instanceof Error ? error : Error(String(error));
            throw error;
        }
        timing.请求 += 请求结果.请求耗时;
        timing.请求次数 += 请求结果.请求次数;
        parsed = 请求结果.parsed;
        const applyStart = Date.now();
        const autoTrack = settings.更新.自动建档 !== false;
        const newData = applyUpdate(data, parsed, timeJump, playerName, autoTrack);
        const updatedNpcs = [];
        const removedNpcs = [];
        if (parsed && typeof parsed === 'object') {
            for (const [name, card] of Object.entries(parsed)) {
                // 顶层非 NPC 键(剧情时间/受孕事件/思考流程)不计入"已更新"统计
                if (name === '剧情时间' || name === '受孕事件' || THINKING_FIELD_KEYS.includes(name))
                    continue;
                if (name === '移除NPC') {
                    if (Array.isArray(card))
                        removedNpcs.push(...card.map(String).filter(Boolean));
                    continue;
                }
                if (name === '在场NPC') {
                    if (Array.isArray(card)) {
                        for (const item of card) {
                            if (typeof item === 'string') {
                                updatedNpcs.push(item);
                            }
                            else if (item && typeof item === 'object' && !Array.isArray(item)) {
                                const n = String(item['姓名'] ?? item['名字'] ?? '').trim();
                                if (n) {
                                    updatedNpcs.push(n);
                                }
                                else {
                                    const first = Object.entries(item).find(([, v]) => v && typeof v === 'object');
                                    if (first)
                                        updatedNpcs.push(String(first[0]));
                                }
                            }
                        }
                    }
                    continue;
                }
                if (card && typeof card === 'object')
                    updatedNpcs.push(name);
            }
        }
        // 自动建档关闭时: 被跳过的新角色不计入"已更新"统计(实际未建档), 与提示口径一致
        const skippedNewNpcs = autoTrack ? [] : updatedNpcs.filter(name => !(newData.名单.includes(name) || newData.NPC[name]));
        if (!autoTrack && skippedNewNpcs.length > 0) {
            for (const name of skippedNewNpcs) {
                const idx = updatedNpcs.indexOf(name);
                if (idx >= 0)
                    updatedNpcs.splice(idx, 1);
            }
        }
        debugStore.record({ time: Date.now(), updatedNpcs, removedNpcs });
        timing.解析应用 = Date.now() - applyStart;
        const finalizeStart = Date.now();
        // 把更新后的状态整体写入本次分析的最后一条楼层(快照随该楼层存亡:
        // 删除楼层/重roll时状态自动回退, 楼层被编辑时由楼层hash校验作废), 并同步清空层清零
        const anchorFloor = recent[recent.length - 1].message_id;
        newData.处理到楼层 = anchorFloor;
        newData.清空层 = 0;
        const stateStore = useStateStore();
        if (writeStateSnapshot(newData, anchorFloor, anchorFloor, true)) {
            stateStore.data = { ...newData, 锚点楼层: anchorFloor };
        }
        else {
            stateStore.data = newData;
        }
        // 同步幕后状态到角色卡主世界书(蓝灯常驻条目), 供主AI与数据库剧情推进读取
        if (settings.更新.注入世界书条目) {
            syncNpcStatesWorldbook(host, newData, true).catch(error => {
                console.error('[彼方] 同步世界书条目失败:', error);
            });
        }
        timing.收尾 = Date.now() - finalizeStart;
        const secs = (ms) => (ms / 1000).toFixed(1);
        console.info(`[彼方] 本次更新总耗时 ${secs(Date.now() - timing.start)}s = 前置 ${secs(timing.前置)}s + 世界书 ${secs(timing.世界书)}s + 接口请求 ${secs(timing.请求)}s(${timing.请求次数}次) + 解析应用 ${secs(timing.解析应用)}s + 收尾 ${secs(timing.收尾)}s`);
        console.info(`[彼方] 幕后NPC状态更新完成: ${updatedNpcs.join('、') || '(本次无重要NPC变化)'}${removedNpcs.length > 0 ? `; 已移除: ${removedNpcs.join('、')}` : ''}`);
        toastSuccess(updatedNpcs.length > 0
            ? `彼方: 已更新 ${updatedNpcs.length} 个NPC的幕后状态${removedNpcs.length > 0 ? `，移除 ${removedNpcs.length} 个NPC` : ''}`
            : removedNpcs.length > 0
                ? `彼方: 已移除 ${removedNpcs.length} 个NPC`
                : '彼方: 本次没有重要NPC的幕后状态变化', '彼方');
    }
    catch (error) {
        if (abortSignal.aborted) {
            const message = '更新已中断';
            console.warn(`[彼方] 更新被中断: 已进行 ${((Date.now() - timing.start) / 1000).toFixed(1)}s(接口请求 ${timing.请求次数} 次, 累计 ${((timing.请求) / 1000).toFixed(1)}s)`);
            debugStore.record({ time: Date.now(), error: message });
            toastInfo(`彼方: ${message}`, '彼方');
            return;
        }
        console.error('[彼方] 更新失败:', error);
        const settingsNow = getSettings();
        const stack = error instanceof Error ? (error.stack ?? '') : '';
        const message = error instanceof Error ? error.message : String(error);
        const detail = [
            '[彼方] 更新失败',
            `阶段: ${parseError && parsed === null ? 'JSON 解析' : '接口调用/其他'}`,
            `耗时: 总 ${((Date.now() - timing.start) / 1000).toFixed(1)}s(前置 ${(timing.前置 / 1000).toFixed(1)}s / 世界书 ${(timing.世界书 / 1000).toFixed(1)}s / 接口请求 ${(timing.请求 / 1000).toFixed(1)}s×${timing.请求次数}次 / 解析应用 ${(timing.解析应用 / 1000).toFixed(1)}s)`,
            `接口: ${maskBaseUrl(settingsNow.接口.地址) || '(未填)'} / 模型: ${settingsNow.接口.模型 || '(未选)'} / 最大token: ${settingsNow.接口.最大token}`,
            `错误: ${message}`,
            ...(stack ? ['堆栈:', stack] : []),
        ].join('\n');
        debugStore.record({ time: Date.now(), error: detail });
        toastError(message, '彼方更新失败');
    }
    finally {
        isUpdating = false;
        updatingStore.stop('幕后');
    }
}

/** 切聊天时重置按楼层号缓存的数据(两个聊天楼层号可能相同, 不重置会用到上一聊天的楼层内容) */
function resetChatCaches() {
    allAssistantCache = null;
}
export { createTextFilter as createTextFilterExported, detectTimeJump, getAllAssistantMessagesCached, resetChatCaches, updateNpcStates };
