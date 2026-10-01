import { setActivePinia } from 'pinia';
import { pinia } from './pinia';
import { getSettings } from './settings';
import { captureConsole, STORAGE_KEY, useDebugStore, useStateStore } from './state';
import { updateWorld } from './update';
import { syncWorldbookEntry } from './inject';
import { useHost } from './host';
import './悬浮球界面';

// 消息事件回调与 console 捕获都在组件外使用 pinia store, 必须先激活 pinia 实例再捕获
setActivePinia(pinia);
captureConsole();

function handleChatChanged() {
  // 切聊天只刷新数据与注入, 不再整页重载, 避免悬浮球闪烁消失。
  // 世界状态存在聊天/楼层变量里, 天然按聊天隔离——切到别的聊天就是别的世界。
  useStateStore().reload();
  useDebugStore().clear();
  const settings = getSettings();
  if (settings.启用运转) {
    syncWorldbookEntry(useStateStore().data, settings.运转.注入世界书条目, settings).catch(error => {
      console.error('[烟火] 切聊天同步世界书条目失败:', error);
    });
  }
}

async function handleMessageReceived(message_id: number) {
  const settings = getSettings();
  if (!settings.启用运转) return; // 总开关: 关闭时不调用 API 不推进
  if (!settings.运转.自动更新) return;
  let latest;
  try {
    const messages = useHost().chat.messages(message_id);
    latest = messages[messages.length - 1];
  } catch {
    return;
  }
  if (!latest || latest.role !== 'assistant' || latest.is_hidden) return;
  // 正文回复过短(疑似被截断/内容太少、没有足够剧情)时跳过自动推进, 避免浪费一次请求
  const replyText = String(latest.message || '').replace(/\s+/g, '').trim();
  if (replyText.length < 500) {
    console.warn(`[烟火] 最新正文回复过短(${replyText.length}字), 疑似被截断, 已跳过本次自动推进`);
    return;
  }
  const frequency = Math.max(1, settings.运转.更新频率);
  if (frequency > 1) {
    // 数"上次推进之后"新增的未隐藏 AI 回复(不再拉全量楼层, 也不把隐藏楼层计进去):
    // 攒够 N 条才推进, 与"每 N 条回复推进一次"的语义一致
    const world = useStateStore().data;
    const lastId = useHost().chat.lastMessageId();
    const from = Math.max(0, (world.处理到楼层 ?? 0) + 1);
    if (lastId >= from) {
      const fresh = useHost().chat.messages(`${from}-${lastId}`, { role: 'assistant' }).filter(message => !message.is_hidden);
      if (fresh.length % frequency !== 0) return;
    }
  }
  await updateWorld();
}

$(() => {
  // 状态快照存在楼层变量里, 随楼层存亡——删除楼层/重roll(新swipe页没有快照)时世界自动回退,
  // 楼层被编辑时由楼层hash校验作废。因此事件处理只剩"刷新界面与世界书注入":
  // - MESSAGE_DELETED 延迟刷新: 若 2 秒内收到新消息(regenerate/重roll)则取消;
  // - MESSAGE_SWIPED(切分支): 切回旧swipe页会恢复该页当时的快照, 刷新即可。
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  function clearPendingRefresh() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }
  function refreshAfterFloorChange() {
    useStateStore().reload();
  }
  // 推进防抖: 正文流式/重 roll 时可能短时间连发多条 MESSAGE_RECEIVED,
  // 只对最后一条触发推进(前面的楼层会被 updateWorld 的"最近 N 条"一并读到, 不丢上下文)
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  function clearPendingTick() {
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
  }
  useHost().events.onMessageReceived((message_id: number) => {
    // 重roll/regenerate 的新消息到达: 取消待处理的删除刷新(推进完成后会自然同步)
    clearPendingRefresh();
    // 防抖: 短时间连发(重roll/群聊连出)时只推进最后一条, 前面的楼层会被"最近 N 条"一并读到
    clearPendingTick();
    tickTimer = setTimeout(() => {
      tickTimer = null;
      handleMessageReceived(message_id).catch(error => {
        console.error('[烟火] 消息处理失败:', error);
      });
    }, 800);
  });
  useHost().events.onMessageDeleted(() => {
    clearPendingRefresh();
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshAfterFloorChange();
    }, 2000);
  });
  useHost().events.onMessageSwiped(() => {
    refreshAfterFloorChange();
  });
  let lastChatId: string | null = null;
  try {
    lastChatId = useHost().chat.currentChatId();
  } catch {
    // 读取失败则首次 CHAT_CHANGED 事件直接刷新
  }
  useHost().events.onChatChanged((new_chat_id: string) => {
    if (lastChatId !== new_chat_id) {
      lastChatId = new_chat_id;
      handleChatChanged();
    }
  });
  // 脚本可能在聊天尚未加载完时启动(此刻读到的是空状态): 延迟补读一次世界快照
  setTimeout(() => {
    try {
      const store = useStateStore();
      const meta = useHost().vars.get({ type: 'chat' })?.[STORAGE_KEY];
      const hasSnapshots = Array.isArray(meta?.快照楼层) && meta.快照楼层.length > 0;
      const looksEmpty = !store.data.世界.时间 && store.data.事件.length === 0;
      if (hasSnapshots && looksEmpty) {
        store.reload();
        console.info('[烟火] 聊天就绪后补读世界快照');
      }
    } catch {
      // 忽略
    }
  }, 3000);
  console.info('[烟火] 世界运转系统已加载');
});
