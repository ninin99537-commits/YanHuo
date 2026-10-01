// 依赖按实际用到的符号具名导入(形态守卫见 tests/no-bundle-artifacts.test.ts)
import { pinia } from './pinia';
import { getSettings } from './settings';
import { loadData } from './快照';
import { useStateStore } from './数据仓';
import { captureConsole, useDebugStore } from './日志仓';
import { createTextFilterExported, getAllAssistantMessagesCached, resetChatCaches, updateNpcStates } from './update';
import { resetWorldbookCaches } from './worldbook';
import { syncNpcStatesWorldbook } from './worldbook-inject';
import './悬浮球界面';
import { setActivePinia } from 'pinia';
import { useHost } from './host';

// 脚本入口就是平台边界: 真实宿主在这里构造一次, 往下只传窄能力(host.worldbook 等)或直接传值。
// 平台全局(getVariables/getChatMessages/getWorldbook…)只在 host.ts 里出现, 见那边的约定。
const host = useHost();

setActivePinia(pinia);
captureConsole();
function handleChatChanged() {
    // 切聊天只刷新数据与注入，不再整页重载，避免悬浮球闪烁消失
    resetChatCaches();
    resetWorldbookCaches();
    useStateStore().reload();
    useDebugStore().clear();
    if (getSettings().启用幕后)
        maybeInjectNpcStates();
}
async function handleMessageReceived(message_id) {
    const settings = getSettings();
    if (!settings.启用幕后)
        return; // 幕后总开关: 关闭时不调用 API 不更新
    if (!settings.更新.自动更新)
        return;
    let latest;
    try {
        const messages = host.chat.messages(message_id);
        latest = messages[messages.length - 1];
    }
    catch {
        return;
    }
    if (!latest || latest.role !== 'assistant' || latest.is_hidden)
        return;
    // 正文回复过短(疑似被截断/内容太少、没有足够剧情)时跳过自动更新, 避免浪费一次更新请求。
    // 用**标签过滤后**的文本判断——与实际发送给接口的内容同口径: 思维链占比高的回复
    // 用原文判断会误以为很长, 过滤后才是真正的剧情正文。
    // 长度统计: 仅剔除换行/制表等结构空白, 保留普通空格——对中文/英文/代码块都更接近真实字数;
    // 旧版把所有 \s+ 全删掉, 英文文本会被严重低估(空格全没, 单词粘连算 1 字)。
    const filter = createTextFilterExported(settings);
    const replyText = filter(String(latest.message || '')).replace(/[\r\n\t]+/g, '').trim();
    if (replyText.length < 500) {
        console.warn(`[彼方] 最新正文回复过短(过滤后 ${replyText.length}字), 疑似被截断, 已跳过本次自动更新`);
        return;
    }
    const frequency = Math.max(1, settings.更新.更新频率);
    if (frequency > 1) {
        // 用带缓存的全部 AI 楼层列表(getAllAssistantMessages: 已排除隐藏楼层,
        // 按 lastId 缓存避免每次都全量拉取), 与 getRecentAssistantMessages 的
        // 可见口径一致——用 getChatMessages 全量扫会包含隐藏楼层导致频率算错
        const assistantCount = getAllAssistantMessagesCached().length;
        if (assistantCount % frequency !== 0)
            return;
    }
    await updateNpcStates();
}
function maybeInjectNpcStates() {
    const settings = getSettings();
    const data = loadData();
    // 开了"注入世界书条目"时: 写入角色主世界书(蓝灯常驻), 主AI与数据库剧情推进都会读取激活世界书;
    // 无论有无 NPC 都同步(无则删除条目), 保证切换聊天后不会残留上一个聊天的内容
    if (!settings.更新.注入世界书条目)
        return;
    syncNpcStatesWorldbook(host, data, true);
}
$(function () {
    // 状态快照存在楼层变量里, 随楼层存亡——删除楼层/重roll(新swipe页没有快照)时状态
    // 自动回退, 楼层被编辑时由楼层hash校验作废。因此事件处理只剩"刷新界面与世界书注入":
    // - MESSAGE_DELETED 只"延迟"刷新, 若 2 秒内收到新消息(regenerate/重roll)则取消,
    //   由 MESSAGE_RECEIVED 的正常更新流程自然同步, 避免中间态闪烁;
    //   手动删除楼层(无后续新消息)才真正刷新。
    // - MESSAGE_SWIPED(切分支): 切回旧swipe页会恢复该页当时的快照, 新页则回退到更早
    //   楼层的快照, 刷新即可。
    let refreshTimer = null;
    function clearPendingRefresh() {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }
    }
    function refreshAfterFloorChange() {
        useStateStore().reload();
        if (getSettings().启用幕后)
            maybeInjectNpcStates();
    }
    host.events.onMessageReceived(message_id => {
        // 重roll/regenerate 的新消息到达: 取消待处理的删除刷新(更新完成后会自然同步)
        clearPendingRefresh();
        handleMessageReceived(message_id).catch(error => {
            console.error('[彼方] 消息处理失败:', error);
        });
    });
    host.events.onMessageDeleted(() => {
        clearPendingRefresh();
        // 延迟执行: 若是重roll/regenerate 的"删旧", 新消息到达时 clearPendingRefresh 取消;
        // 手动删除楼层(无后续新消息)才真正刷新
        refreshTimer = setTimeout(function () {
            refreshTimer = null;
            refreshAfterFloorChange();
        }, 2000);
    });
    host.events.onMessageSwiped(() => {
        refreshAfterFloorChange();
    });
    host.events.onGenerationAfterCommands(() => {
        if (getSettings().启用幕后)
            maybeInjectNpcStates();
    });
    // 读不到时返回 null, 此时首次 CHAT_CHANGED 事件直接刷新
    let lastChatId = host.chat.currentChatId();
    host.events.onChatChanged(new_chat_id => {
        if (lastChatId !== new_chat_id) {
            lastChatId = new_chat_id;
            handleChatChanged();
        }
    });
    console.info('[彼方] NPC幕后生命状态系统已加载');
});
