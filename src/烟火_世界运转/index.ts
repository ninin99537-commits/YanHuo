import { setActivePinia } from 'pinia';
import { pinia } from './pinia';
import { getSettings } from './settings';
import { captureConsole, STORAGE_KEY, useDebugStore, useStateStore } from './state';
import { updateWorld, 取消世界推进 } from './update';
import { syncWorldbookEntry } from './inject';
import { useHost } from './host';
import { 有世界数据 } from './世界数据';
import { 版本标签 } from './版本';
import './悬浮球界面';

setActivePinia(pinia);
captureConsole();

let epoch = 0;
let busy = false;
let pendingLatest = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}
function clearPendingTick() {
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = null;
}
function invalidateWork() {
  epoch++;
  pendingLatest = false;
  clearPendingTick();
  取消世界推进();
}
async function reloadAndSync() {
  const ticket = epoch;
  useStateStore().reload();
  const settings = getSettings();
  if (!settings.启用运转) return;
  const data = useStateStore().data;
  const result = await syncWorldbookEntry(data, settings.运转.注入世界书条目, settings);
  if (ticket !== epoch) return; // 已换聊天/分支的晚结果不驱动当前界面
  if (result.状态 === '待同步') console.warn(`[烟火] ${result.说明}`);
}
function handleChatChanged() {
  invalidateWork();
  clearPendingRefresh();
  useDebugStore().clear();
  reloadAndSync().catch(error => console.error('[烟火] 切聊天重载失败:', error));
}
function refreshAfterFloorChange() {
  invalidateWork();
  reloadAndSync().catch(error => console.error('[烟火] 删楼/切分支后重载失败:', error));
}
async function runLatest() {
  if (busy) { pendingLatest = true; return; }
  busy = true;
  const ticket = epoch;
  try {
    const result = await updateWorld();
    if (ticket !== epoch) return;
    if (result.状态 === '已提交' || result.状态 === '待同步') clearPendingRefresh();
  } finally {
    busy = false;
    // 忙碌期间可能来了多条回复；只跑最新请求，它会完整收集此前未处理楼层。
    if (pendingLatest && ticket === epoch) {
      pendingLatest = false;
      await runLatest();
    }
  }
}
async function handleMessageReceived(message_id: number) {
  const settings = getSettings();
  if (!settings.启用运转 || !settings.运转.自动更新) return;
  if (busy) { pendingLatest = true; return; }
  try {
    const latest = useHost().chat.messages(message_id).at(-1);
    if (!latest || latest.role !== 'assistant' || latest.is_hidden) return;
    const replyText = String(latest.message || '').replace(/\s+/g, '').trim();
    if (replyText.length < 500) {
      console.warn(`[烟火] 最新正文回复过短(${replyText.length}字), 疑似被截断, 已跳过本次自动推进`);
      return;
    }
    const frequency = Math.max(1, settings.运转.更新频率);
    if (frequency > 1) {
      const world = useStateStore().data;
      const lastId = useHost().chat.lastMessageId();
      const from = Math.max(0, (world.处理到楼层 ?? 0) + 1);
      if (lastId >= from) {
        const fresh = useHost().chat.messages(`${from}-${lastId}`, { role: 'assistant' }).filter(message => !message.is_hidden);
        if (fresh.length < frequency) return;
      }
    }
  } catch { return; }
  await runLatest();
}

$(() => {
  useHost().events.onMessageReceived((message_id: number) => {
    clearPendingTick();
    const ticket = epoch;
    tickTimer = setTimeout(() => {
      tickTimer = null;
      if (ticket !== epoch) return;
      handleMessageReceived(message_id).catch(error => console.error('[烟火] 消息处理失败:', error));
    }, 800);
  });
  useHost().events.onMessageDeleted(() => {
    invalidateWork();
    clearPendingRefresh();
    const ticket = epoch;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (ticket === epoch) refreshAfterFloorChange();
    }, 2000);
  });
  useHost().events.onMessageSwiped(() => {
    clearPendingRefresh();
    refreshAfterFloorChange();
  });
  let lastChatId: string | null = null;
  try { lastChatId = useHost().chat.currentChatId(); } catch { /* 等首次事件 */ }
  useHost().events.onChatChanged((new_chat_id: string) => {
    if (lastChatId !== new_chat_id) {
      lastChatId = new_chat_id;
      handleChatChanged();
    }
  });
  setTimeout(() => {
    try {
      const store = useStateStore();
      const meta = useHost().vars.get({ type: 'chat' })?.[STORAGE_KEY];
      const hasSnapshots = Array.isArray(meta?.快照楼层) && meta.快照楼层.length > 0;
      if (hasSnapshots && !有世界数据(store.data)) reloadAndSync().catch(error => console.error('[烟火] 启动补读失败:', error));
      else if (有世界数据(store.data)) reloadAndSync().catch(error => console.error('[烟火] 启动同步失败:', error));
    } catch { /* 聊天尚未就绪 */ }
  }, 3000);
  console.info(`[烟火] 世界运转系统已加载 ${版本标签()}`);
});
