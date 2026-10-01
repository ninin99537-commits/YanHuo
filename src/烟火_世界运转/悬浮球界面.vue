<script setup lang="ts">
import {
  PhCaretDown,
  PhCheck,
  PhCopySimple,
  PhEye,
  PhEyeSlash,
  PhGraph,
  PhLightning,
  PhMoonStars,
  PhPause,
  PhPencilSimple,
  PhPlay,
  PhPlus,
  PhScroll,
  PhSun,
  PhTrash,
  PhWind,
  PhX,
} from '@phosphor-icons/vue';
import { klona } from 'klona';
import { storeToRefs } from 'pinia';
import { computed, ref, watch } from 'vue';
import { chatCompletion, fetchModelList } from './api';
import { syncWorldbookEntry } from './inject';
import { buildInjectionPrompt } from './prompts';
import type { WorldData, WorldEvent } from './schema';
import { getSettings, useSettingsStore } from './settings';
import { useConsoleStore, useDebugStore, useStateStore, useUpdatingStore } from './state';
import { toastError, toastInfo, toastSuccess, toastWarning } from './toast';
import { updateWorld } from './update';
import { 有世界数据 } from './世界数据';
import { 事件枚举, 取层, 表单定义 } from './世界字段表';
import type { 任意编辑会话, 事件编辑会话, 势力编辑会话, 条目编辑会话, 概述编辑会话 } from './世界编辑会话';
import { 取消会话, 打开事件会话, 打开势力会话, 打开概述会话, 打开条目会话, 提交会话 } from './世界编辑会话';
import type { 世界条目层 } from './世界数据变更';
import { 建世界数据环境, 清空世界, 移除事件, 移除势力, 移除世界条目 } from './世界数据变更';
import { 取根变量 } from './主题';
import WorldEditForm from './世界编辑表单.vue';
import { 使用面板机制 } from './面板机制';

// ---------------------------------------------------------------------------
// stores
// ---------------------------------------------------------------------------

const settingsStore = useSettingsStore();
const { settings } = storeToRefs(settingsStore);
const stateStore = useStateStore();
const { data } = storeToRefs(stateStore);
const debugStore = useDebugStore();
const { log: debugLog } = storeToRefs(debugStore);
const consoleStore = useConsoleStore();
const { lines: consoleLines } = storeToRefs(consoleStore);
const consoleLinesReversed = computed(() => [...consoleLines.value].reverse());
const updatingStore = useUpdatingStore();
const { active: updatingActive, message: updatingMessage } = storeToRefs(updatingStore);

// ---------------------------------------------------------------------------
// 面板机制(位置偏好 / 主题 / iframe 尺寸 / 拖动 / 阴影 / 弹条)全在 面板机制.ts;
// 配色与球直径 / 层序 token 全在 主题.ts —— 这里只把它们接到模板上
// ---------------------------------------------------------------------------

const {
  rootEl,
  panelRef,
  headerEl,
  parentWin,
  theme,
  panelOpen,
  isDragging,
  isPanelDragging,
  orbStyle,
  panelStyleRef,
  onOrbPointerDown,
  onOrbClick,
  onPanelPointerDown,
  closePanel,
} = 使用面板机制({
  推进中: updatingActive,
  推进文案: updatingMessage,
  中断推进: () => updatingStore.cancel(),
});

/** 面板的全部 CSS 变量(配色 / 球直径 / 层序)只在 主题.ts 里写一次, 这里绑到根元素上:
 *  这是"TS 的值 → CSS 的变量"之间唯一的那一个映射点(样式表里一律 var(...) 引用) */
const 根样式 = computed(() => 取根变量(theme.value));

const tab = ref<'now' | 'chronicle' | 'factions' | 'world' | 'logs' | 'settings'>('now');

// ---------------------------------------------------------------------------
// 世界数据视图
// ---------------------------------------------------------------------------

const world = computed<WorldData>(() => data.value);
// 「这个世界有没有数据」问同一处(有世界数据): 别处再写一遍, 迟早两处口径不一致
const hasWorld = computed(() => 有世界数据(world.value));
const activeEvents = computed(() =>
  world.value.事件
    .filter(event => event.阶段 !== '已结束')
    .slice(-4)
    .reverse(),
);
const factionEntries = computed(() => Object.entries(world.value.势力));
const regionEntries = computed(() => Object.entries(world.value.地域 ?? {}));
const trendEntries = computed(() => Object.entries(world.value.大势 ?? {}));
const seedList = computed(() => world.value.伏笔 ?? []);
const occasionList = computed(() => world.value.节令 ?? []);
const metricEntries = computed(() => Object.entries(world.value.指标 ?? {}));

// ---- 世界页手动编辑: 五层共用一套「名称+字段」增删改 ----
// 改数据一律走 世界数据变更.ts 那道门(它负责上限/同名/id 签发/落快照/同步世界书);
// "正在编辑什么"由 世界编辑会话.ts 收着(候选 5): 打开/比较基准/冲突判定/提交/取消 全在那边,
// 这里只消费它——以前五层条目/世界概述/事件/势力各写一份镜像草稿, 每份都自己"打开时拷进去、
// 保存时拷出来", 三处手动同步, 还漏掉了"打开时那一条还在不在"的判断。
// 字段清单(名字/标签/枚举/多行)只在 世界字段表.ts 一处(候选 4): 这里按层取, 不再手抄字段名。
type WorldLayer = 世界条目层;
const layerFields: Record<WorldLayer, { key: string; label: string; enum?: readonly string[]; multiline?: boolean }[]> = {
  地域: 表单定义(取层('地域')),
  大势: 表单定义(取层('大势')),
  伏笔: 表单定义(取层('伏笔')),
  节令: 表单定义(取层('节令')),
  指标: 表单定义(取层('指标')),
};
/** 唯一的编辑会话: 五层条目 / 事件 / 势力 / 世界概述 四类编辑共用这一个 */
const 会话 = ref<任意编辑会话 | null>(null);
/** 四个按种类收窄的视图: 只是让模板拿到自己那一份, 草稿仍然只有会话里那一个对象。
 *  事件的这一个仍叫 editingEvent(模板与面板用例里的调用点都是这个名字): 它现在指向"在编的那条事件的会话",
 *  认哪一条看的是会话里的 基准(打开时的原值), 不再是对象引用。 */
const 条目会话 = computed<条目编辑会话 | null>(() => (会话.value?.目标.种类 === '条目' ? (会话.value as 条目编辑会话) : null));
const editingEvent = computed<事件编辑会话 | null>(() => (会话.value?.目标.种类 === '事件' ? (会话.value as 事件编辑会话) : null));
const 势力会话 = computed<势力编辑会话 | null>(() => (会话.value?.目标.种类 === '势力' ? (会话.value as 势力编辑会话) : null));
const 概述会话 = computed<概述编辑会话 | null>(() => (会话.value?.目标.种类 === '概述' ? (会话.value as 概述编辑会话) : null));

/** 取消: 会话丢掉就是取消(草稿只在会话里, 数据仓与快照一个字都不动) */
function 取消编辑() {
  会话.value = 取消会话();
}

/** 打开五层里的一条编辑(按层+名字从数据仓取当前那一条作基准, 不认模板里那个对象) */
function startWorldEdit(layer: WorldLayer, key: string) {
  会话.value = 打开条目会话(data.value, layer, key);
}
function startWorldAdd(layer: WorldLayer) {
  会话.value = 打开条目会话(data.value, layer, '');
}
function saveWorldEdit() {
  const 结果 = 提交会话(条目会话.value, data.value, 建世界数据环境());
  if (!结果) return;
  if (结果.拒绝) {
    toastWarning(结果.拒绝, '烟火');
    return;
  }
  data.value = 结果.数据;
  取消编辑();
  toastSuccess(结果.说明, '烟火');
}
function removeWorldItem(layer: WorldLayer, key: string) {
  const 结果 = 移除世界条目(data.value, layer, key, 建世界数据环境());
  if (结果.拒绝) {
    toastWarning(结果.拒绝, '烟火');
    return;
  }
  data.value = 结果.数据;
  // 删掉的正好是编辑框里那一条 → 编辑框跟着收起来
  if (条目会话.value && 条目会话.value.草稿.layer === layer && 条目会话.value.草稿.key === key) 取消编辑();
  toastInfo(结果.说明, '烟火');
}

const stageFilter = ref<'全部' | '进行中' | '已结束'>('全部');
const scaleFilter = ref<'全部' | '要事' | '大事'>('全部');
/** 事件表单的下拉与筛选的枚举只有 世界字段表.ts 一处来源(以前模板里手抄了六组字面量) */
const 规模选项 = 事件枚举.规模;
const 传播选项 = 事件枚举.传播;
const 阶段选项 = 事件枚举.阶段;
const 隐秘选项 = 事件枚举.隐秘;
const 阶段筛选项: readonly string[] = ['全部', '进行中', '已结束'];
const 规模筛选项: readonly string[] = ['全部', ...事件枚举.规模];
const chronicleEvents = computed(() => {
  const events = [...world.value.事件].reverse();
  return events.filter(event => {
    if (stageFilter.value === '进行中' && event.阶段 === '已结束') return false;
    if (stageFilter.value === '已结束' && event.阶段 !== '已结束') return false;
    if (scaleFilter.value !== '全部' && event.规模 !== scaleFilter.value) return false;
    return true;
  });
});
const selectedFaction = ref<string>('');
watch(factionEntries, entries => {
  if (!entries.some(([name]) => name === selectedFaction.value)) {
    selectedFaction.value = entries[0]?.[0] ?? '';
  }
});
const selectedFactionData = computed(
  () => factionEntries.value.find(([name]) => name === selectedFaction.value)?.[1] ?? null,
);

function trendArrow(trend: string): string {
  return trend === '上升' ? '↑' : trend === '下降' ? '↓' : '→';
}

function fmtTimestamp(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '';
}

// ---------------------------------------------------------------------------
// 手动编辑(修笔) — 所有编辑都经 世界数据变更.ts: 它落快照 + 同步世界书注入 + 返回新数据
// ---------------------------------------------------------------------------

/** 切换「启用世界运转」/「注入世界动向到主AI」时立即生效: 关=删条目, 开=建/刷新条目 */
watch(
  () => [settings.value.启用运转, settings.value.运转.注入世界书条目],
  ([启用运转, 注入]) => {
    syncWorldbookEntry(stateStore.data, 启用运转 && 注入, settings.value).catch(error => {
      console.error('[烟火] 切换注入开关后同步世界书条目失败:', error);
    });
  },
);

/** 打开世界概述编辑(时间/氛围/总览) */
function openEdit() {
  会话.value = 打开概述会话(data.value);
}
function saveEdit() {
  const 结果 = 提交会话(概述会话.value, data.value, 建世界数据环境());
  if (!结果) return;
  if (结果.拒绝) {
    toastWarning(结果.拒绝, '烟火');
    return;
  }
  data.value = 结果.数据;
  取消编辑();
  toastSuccess(结果.说明);
}
function removeEvent(event: WorldEvent) {
  const 结果 = 移除事件(data.value, event.id, 建世界数据环境());
  if (结果.拒绝) {
    toastWarning(结果.拒绝, '烟火');
    return;
  }
  data.value = 结果.数据;
  toastInfo(结果.说明, '烟火');
}
function removeFaction(name: string) {
  const 结果 = 移除势力(data.value, name, 建世界数据环境());
  if (结果.拒绝) {
    toastWarning(结果.拒绝, '烟火');
    return;
  }
  data.value = 结果.数据;
  toastInfo(结果.说明, '烟火');
}
function selectFaction(name: string) {
  selectedFaction.value = name;
  tab.value = 'factions';
}

/** 事件编辑: 一次编辑一条。定位靠 id(不是对象引用)——AI 推进一次就会换掉整棵数据树, 引用当场失效。
 *  编辑框认的是"点开时那一条"(会话里的基准): id 对上就是同一条, 老快照没 id 时退回按标题认。 */
function 同一条事件(在编: 任意编辑会话 | null, 候选: WorldEvent) {
  if (!在编 || 在编.目标.种类 !== '事件') return false;
  const 原 = 在编.基准 as WorldEvent | null;
  if (!原) return false;
  return 原.id && 候选.id ? 原.id === 候选.id : 原.标题 === 候选.标题;
}
function startEditEvent(event: WorldEvent) {
  会话.value = 打开事件会话(event);
}
function saveEventEdit() {
  const 结果 = 提交会话(editingEvent.value, data.value, 建世界数据环境());
  if (!结果) return;
  if (结果.拒绝) {
    toastWarning(结果.拒绝, '烟火');
    return;
  }
  data.value = 结果.数据;
  取消编辑();
  toastSuccess(结果.说明);
}

/** 势力编辑(在脉络详情页) */
/** 选中势力关联的进行中/最近事件(从事件的势力字段派生, 不让 AI 写) */
const factionRelatedEvents = computed(() =>
  world.value.事件
    .filter(event => event.势力 === selectedFaction.value)
    .slice(-6)
    .reverse(),
);
function startEditFaction() {
  // 名字不在清单里(那一行刚被推进换掉)就不打开, 与以前"没有可编辑的势力就不进编辑态"一致
  const 新会话 = 打开势力会话(data.value, selectedFaction.value);
  if (新会话) 会话.value = 新会话;
}
function saveFactionEdit() {
  const 结果 = 提交会话(势力会话.value, data.value, 建世界数据环境());
  if (!结果) return;
  if (结果.拒绝) {
    toastWarning(结果.拒绝, '烟火');
    return;
  }
  data.value = 结果.数据;
  取消编辑();
  toastSuccess(结果.说明);
}
watch(selectedFaction, () => {
  // 换势力只关正在编辑的势力, 别的编辑(条目/事件/概述)不受影响
  if (会话.value?.目标.种类 === '势力') 取消编辑();
});

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

async function tickNow() {
  await updateWorld(true);
  stateStore.reload();
}
const confirmClear = ref(false);
let confirmClearTimer: ReturnType<typeof setTimeout> | null = null;
async function clearWorld() {
  if (!confirmClear.value) {
    confirmClear.value = true;
    if (confirmClearTimer) clearTimeout(confirmClearTimer);
    confirmClearTimer = setTimeout(() => {
      confirmClear.value = false;
    }, 3000);
    return;
  }
  confirmClear.value = false;
  const 结果 = 清空世界(建世界数据环境());
  data.value = 结果.数据;
  toastSuccess(结果.说明);
}

// ---------------------------------------------------------------------------
// 设置操作
// ---------------------------------------------------------------------------

const showKey = ref(false);
const fetchingModels = ref(false);
const testing = ref(false);
async function onFetchModels() {
  fetchingModels.value = true;
  try {
    const list = await fetchModelList();
    settings.value.接口.模型列表 = list;
    toastSuccess(`获取到 ${list.length} 个模型`);
  } catch (error) {
    toastError(error instanceof Error ? error.message : String(error), '烟火·获取模型失败');
  } finally {
    fetchingModels.value = false;
  }
}
async function onTestConnection() {
  testing.value = true;
  try {
    const content = await chatCompletion([{ role: 'user', content: '收到请只回复两个字: 成功' }], { max_tokens: 16 });
    toastSuccess(`连接成功: ${content.trim().slice(0, 40)}`);
  } catch (error) {
    toastError(error instanceof Error ? error.message : String(error), '烟火·测试失败');
  } finally {
    testing.value = false;
  }
}

// 接口配置预设: 保存/加载/删除多套接口配置
const presetName = ref('');
const selectedPreset = ref('');
const presetNames = computed(() => Object.keys(settings.value.接口预设 ?? {}));
function saveApiPreset() {
  const name = String(presetName.value).trim();
  if (!name) {
    toastWarning('请填写预设名');
    return;
  }
  if (!settings.value.接口预设) settings.value.接口预设 = {};
  settings.value.接口预设[name] = klona(settings.value.接口);
  presetName.value = '';
  selectedPreset.value = name;
  toastSuccess(`已保存接口配置预设「${name}」`);
}
function loadApiPreset() {
  const name = String(selectedPreset.value).trim();
  if (!name || !settings.value.接口预设?.[name]) {
    toastWarning('请选择要加载的预设');
    return;
  }
  settings.value.接口 = klona(settings.value.接口预设[name]);
  toastSuccess(`已加载接口配置预设「${name}」`);
}
function deleteApiPreset() {
  const name = String(selectedPreset.value).trim();
  if (!name || !settings.value.接口预设?.[name]) {
    toastWarning('请选择要删除的预设');
    return;
  }
  delete settings.value.接口预设[name];
  selectedPreset.value = '';
  toastSuccess(`已删除接口配置预设「${name}」`);
}

/** 列表设置(排除条目/标签)的文本双向绑定: 逗号/顿号/空格分隔 */
function listText(key: '世界书排除' | '标签列表') {
  if (key === '世界书排除') {
    return computed({
      get: () => (settings.value.运转.世界书排除 ?? []).join('、'),
      set: (text: string) => {
        settings.value.运转.世界书排除 = text
          .split(/[,,、\s]+/)
          .map(item => item.trim())
          .filter(Boolean);
      },
    });
  }
  return computed({
    get: () => (settings.value.标签.列表 ?? []).join('、'),
    set: (text: string) => {
      settings.value.标签.列表 = text
        .split(/[,,、\s]+/)
        .map(item => item.trim().replace(/^<|>$/g, ''))
        .filter(Boolean);
    },
  });
}
const worldbookExcludeText = listText('世界书排除');
const tagListText = listText('标签列表');

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

function joinRecord(): string {
  const log = debugLog.value;
  if (!log) return '(暂无推进记录)';
  const parts = [
    '[烟火] 推进记录',
    `时间: ${fmtTimestamp(log.time)} / 模型: ${log.model || '(未选)'} / 楼层: ${log.replyIds.length > 0 ? log.replyIds.map(id => `#${id}`).join(', ') : '(无)'} / 小结: ${log.summary || '(无)'}`,
    ...(log.addedEvents.length > 0 ? [`新增事件: ${log.addedEvents.join('、')}`] : []),
    ...(log.updatedEvents.length > 0 ? [`推进事件: ${log.updatedEvents.join('、')}`] : []),
    ...(log.removedEvents.length > 0 ? [`了结事件: ${log.removedEvents.join('、')}`] : []),
    ...(log.request ? ['\n── 发送给世界引擎的内容 ──\n' + log.request] : []),
    ...(log.response ? ['\n── 世界引擎输出 ──\n' + log.response] : []),
    ...(log.error ? ['\n── 报错 ──\n' + log.error] : []),
  ];
  return parts.join('\n');
}
function buildErrorReport(): string {
  const log = debugLog.value;
  const settingsNow = getSettings();
  const parts = [
    '[烟火] 报错报告',
    `时间: ${fmtTimestamp(log?.time)} / 模型: ${settingsNow.接口.模型 || '(未选)'}`,
    ...(log?.replyIds?.length ? [`楼层: ${log.replyIds.map(id => `#${id}`).join(', ')}`] : []),
    ...(log?.request ? ['\n── 发送给世界引擎的内容 ──\n' + log.request] : []),
    ...(log?.response ? ['\n── 世界引擎输出 ──\n' + log.response] : []),
    ...(log?.error ? ['\n── 报错 ──\n' + log.error] : ['\n(无报错记录——请描述你遇到的问题)']),
  ];
  return parts.join('\n');
}
async function copyText(text: string, tip = '已复制到剪贴板') {
  // iframe 内 navigator.clipboard 常被权限策略禁用, 优先用父窗口的剪贴板
  const clipboard = parentWin.value?.navigator.clipboard ?? navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      toastSuccess(tip);
      return;
    } catch {
      // 落入降级
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    toastSuccess(tip);
  } catch {
    toastError('复制失败, 请手动选择文本复制', '烟火');
  }
}
const injectionPreview = ref<string | null>(null);
function showInjection() {
  injectionPreview.value = buildInjectionPrompt(world.value, getSettings());
}
const collapsed = ref<Record<string, boolean>>({});
function toggleCollapse(key: string) {
  collapsed.value[key] = !collapsed.value[key];
}

/** 风闻页事件「演变」时间线的展开状态(键=事件 id, 无 id 时退回标题——id 稳定, 改名/重排不丢展开状态) */
const trailOpen = ref<Record<string, boolean>>({});
function toggleTrail(key: string) {
  trailOpen.value[key] = !trailOpen.value[key];
}

// (挂载/卸载的接线随面板机制一起搬到了 面板机制.ts: 恢复偏好 → 定默认锚点 → 挂阴影层 → 应用 iframe 尺寸)

const tabs = [
  { key: 'now', label: '此刻' },
  { key: 'chronicle', label: '风闻' },
  { key: 'factions', label: '势力' },
  { key: 'world', label: '世界' },
  { key: 'logs', label: '日志' },
  { key: 'settings', label: '设置' },
] as const;

const scaleLabel: Record<string, string> = { 要事: '要事', 大事: '大事' };
</script>

<template>
  <div ref="rootEl" class="yh-root" :data-theme="theme" :style="根样式">
    <!-- 悬浮球: 扁平墨印, 一点青瓷 -->
    <button
      class="yh-orb"
      :class="{ 'is-dragging': isDragging, 'is-updating': updatingActive, 'is-open': panelOpen }"
      :style="orbStyle"
      title="烟火 · 世界运转"
      @pointerdown="onOrbPointerDown"
      @click="onOrbClick"
    >
      <svg class="yh-orb-mark" viewBox="0 0 24 24" aria-hidden="true">
        <path class="yh-flame" d="M13.6 4.8 17.9 15.6 16.4 18.8 8 18.8 6.5 15.4 10.6 8.4 12.4 11.2Z" />
      </svg>
    </button>

    <!-- 面板: 小窗悬在酒馆上空, iframe 只罩住面板+球, 其余区域酒馆照常可点; 点外部不关闭 -->
    <section
      v-if="panelOpen"
      ref="panelRef"
      class="yh-panel"
      :class="{ 'is-dragging': isPanelDragging }"
      :style="panelStyleRef"
      role="dialog"
      aria-label="烟火 · 世界运转"
    >
      <header ref="headerEl" class="yh-header" @pointerdown="onPanelPointerDown">
        <div class="yh-brand">
          <svg class="yh-mark" viewBox="0 0 24 24" aria-hidden="true">
            <rect class="yh-seal-base" x="2.6" y="2.6" width="18.8" height="18.8" rx="5.4" />
            <path class="yh-seal-cut" d="M13.6 4.8 17.9 15.6 16.4 18.8 8 18.8 6.5 15.4 10.6 8.4 12.4 11.2Z" />
          </svg>
          <div class="yh-brand-text">
            <span class="yh-brand-name">烟火</span>
            <span class="yh-brand-sub">世界运转 · 楼层之外，人间照常</span>
          </div>
        </div>
        <div class="yh-header-side">
          <span class="yh-status" :class="{ 'is-on': settings.启用运转 && settings.运转.自动更新 }">
            <i class="yh-status-dot" aria-hidden="true"></i>
            {{ !settings.启用运转 ? '已停转' : settings.运转.自动更新 ? '自动运转' : '手动' }}
          </span>
          <button
            v-if="updatingActive"
            class="yh-btn yh-btn-sm yh-interrupt"
            title="中断本次推进, 不会写入任何数据"
            @click="updatingStore.cancel()"
          >
            中断
          </button>
          <button
            class="yh-icon-btn"
            :title="theme === 'dark' ? '切换白天' : '切换夜晚'"
            @click="theme = theme === 'dark' ? 'light' : 'dark'"
          >
            <PhSun v-if="theme === 'dark'" :size="16" weight="regular" />
            <PhMoonStars v-else :size="16" weight="regular" />
          </button>
          <button class="yh-icon-btn" title="收起" @click="closePanel"><PhX :size="16" weight="regular" /></button>
        </div>
      </header>

      <div class="yh-frame">
        <nav class="yh-rail">
          <button
            v-for="item in tabs"
            :key="item.key"
            class="yh-rail-item"
            :class="{ 'is-active': tab === item.key }"
            @click="tab = item.key"
          >
            <span class="yh-rail-text">{{ item.label }}</span>
          </button>
        </nav>

        <div class="yh-body">
          <!-- ============ 此刻 ============ -->
          <div v-if="tab === 'now'" class="yh-page">
            <div class="yh-now-head">
              <div class="yh-now-time">
                <span class="yh-time-label">世界时间</span>
                <strong class="yh-time-value">{{ world.世界.时间 || '未知' }}</strong>
              </div>
              <p v-if="world.世界.氛围" class="yh-now-mood">{{ world.世界.氛围 }}</p>
              <p v-if="world.世界.总览" class="yh-now-trend">{{ world.世界.总览 }}</p>
              <p v-if="!hasWorld" class="yh-now-empty">
                世界尚无档案——生成一条 AI 回复后自动建立；或在设置里配好接口后点下方「推进世界」。
              </p>
              <div class="yh-now-actions">
                <button class="yh-btn yh-btn-primary" :disabled="updatingActive" @click="tickNow">
                  <PhLightning :size="13" weight="fill" />
                  推进世界
                </button>
                <button class="yh-btn" @click="settings.运转.自动更新 = !settings.运转.自动更新">
                  <PhPause v-if="settings.运转.自动更新" :size="13" weight="regular" />
                  <PhPlay v-else :size="13" weight="regular" />
                  {{ settings.运转.自动更新 ? '暂停自动' : '恢复自动' }}
                </button>
                <button class="yh-btn" @click="概述会话 ? saveEdit() : openEdit()">
                  <PhCheck v-if="概述会话" :size="13" weight="regular" />
                  {{ 概述会话 ? '保存概述' : '修笔' }}
                </button>
                <button class="yh-btn yh-btn-danger" :class="{ 'is-confirm': confirmClear }" @click="clearWorld">
                  <PhTrash :size="13" weight="regular" />
                  {{ confirmClear ? '再点一次确认' : '清空' }}
                </button>
              </div>
            </div>

            <div v-if="概述会话" class="yh-edit-grid">
              <label class="yh-field">
                <span class="yh-field-label">世界时间</span>
                <input v-model="概述会话.草稿.时间" type="text" class="yh-input" placeholder="如 0137-06-12 07:45" />
              </label>
              <label class="yh-field">
                <span class="yh-field-label">氛围</span>
                <input
                  v-model="概述会话.草稿.氛围"
                  type="text"
                  class="yh-input"
                  placeholder="一句当前世界整体氛围，非主角身边的氛围，而是整个世界的主调"
                />
              </label>
              <label class="yh-field yh-field-wide">
                <span class="yh-field-label">总览</span>
                <textarea
                  v-model="概述会话.草稿.总览"
                  class="yh-input yh-textarea"
                  rows="2"
                  placeholder="一两句世界总体走向"
                ></textarea>
              </label>
            </div>

            <div class="yh-now-columns">
              <div class="yh-now-col">
                <h3 class="yh-col-title">事态</h3>
                <ul v-if="activeEvents.length > 0" class="yh-mini-list">
                  <li v-for="event in activeEvents" :key="event.标题">
                    <span class="yh-mini-title" @click="tab = 'chronicle'">{{ event.标题 }}</span>
                    <span class="yh-mini-desc">{{ event.描述 }}</span>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无进行中的事</p>
              </div>
              <div class="yh-now-col">
                <h3 class="yh-col-title">势力</h3>
                <ul v-if="factionEntries.length > 0" class="yh-mini-list">
                  <li v-for="[name, faction] in factionEntries.slice(0, 4)" :key="name">
                    <span class="yh-mini-title" @click="selectFaction(name)">{{ name }}</span>
                    <span class="yh-mini-desc">{{ faction.动向 || faction.目标 }}</span>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无追踪的势力</p>
              </div>
            </div>

            <p class="yh-now-meta">
              已推进 {{ world.统计.推进次数 }} 次 · 上次 {{ fmtTimestamp(world.统计.最后推进)
              }}{{ world.小结 ? ` · ${world.小结}` : '' }}
            </p>
          </div>

          <!-- ============ 风闻 ============ -->
          <div v-else-if="tab === 'chronicle'" class="yh-page">
            <div class="yh-filter-row">
              <div class="yh-chip-group">
                <button
                  v-for="option in 阶段筛选项"
                  :key="option"
                  class="yh-chip"
                  :class="{ 'is-active': stageFilter === option }"
                  @click="stageFilter = option"
                >
                  {{ option }}
                </button>
              </div>
              <div class="yh-chip-group">
                <button
                  v-for="option in 规模筛选项"
                  :key="option"
                  class="yh-chip"
                  :class="{ 'is-active': scaleFilter === option }"
                  @click="scaleFilter = option"
                >
                  {{ option }}
                </button>
              </div>
            </div>
            <ol v-if="chronicleEvents.length > 0" class="yh-feed">
              <li
                v-for="(event, index) in chronicleEvents"
                :key="event.id || `${event.标题}-${index}`"
                class="yh-feed-item"
                :class="[`is-${event.阶段}`, `scale-${event.规模}`]"
              >
                <div class="yh-feed-when">
                  <span class="yh-feed-time">{{ event.时间 || '时间未知' }}</span>
                  <span v-if="event.地点" class="yh-feed-place">{{ event.地点 }}</span>
                </div>
                <div class="yh-feed-main">
                  <template v-if="同一条事件(editingEvent, event)">
                    <div class="yh-inline-edit">
                      <div class="yh-edit-row">
                        <input v-model="editingEvent!.草稿.标题" class="yh-input" placeholder="标题" />
                        <input v-model="editingEvent!.草稿.时间" class="yh-input" placeholder="时间" />
                        <input v-model="editingEvent!.草稿.地点" class="yh-input" placeholder="地点" />
                      </div>
                      <textarea
                        v-model="editingEvent!.草稿.描述"
                        class="yh-input yh-textarea"
                        rows="2"
                        placeholder="描述"
                      ></textarea>
                      <input v-model="editingEvent!.草稿.前情" class="yh-input" placeholder="前情（来龙去脉总结）" />
                      <div class="yh-edit-row">
                        <select v-model="editingEvent!.草稿.规模" class="yh-input yh-select">
                          <option v-for="s in 规模选项" :key="s" :value="s">{{ s }}</option>
                        </select>
                        <select v-model="editingEvent!.草稿.传播" class="yh-input yh-select">
                          <option v-for="s in 传播选项" :key="s" :value="s">{{ s }}</option>
                        </select>
                        <select v-model="editingEvent!.草稿.阶段" class="yh-input yh-select">
                          <option v-for="s in 阶段选项" :key="s" :value="s">{{ s }}</option>
                        </select>
                      </div>
                      <div class="yh-edit-row">
                        <input v-model="editingEvent!.草稿.渠道" class="yh-input" placeholder="渠道" />
                        <input v-model="editingEvent!.草稿.势力" class="yh-input" placeholder="关联势力" />
                      </div>
                      <div class="yh-edit-row">
                        <input
                          v-model="editingEvent!.草稿.代表人物"
                          class="yh-input"
                          placeholder="代表人物（头衔+名字，如 首席信息官·林素问）"
                        />
                      </div>
                      <div class="yh-edit-row">
                        <select v-model="editingEvent!.草稿.隐秘" class="yh-input yh-select">
                          <option v-for="s in 隐秘选项" :key="s" :value="s">{{ s }}</option>
                        </select>
                      </div>
                      <div class="yh-edit-actions">
                        <button class="yh-btn yh-btn-primary yh-btn-sm" @click="saveEventEdit">
                          <PhCheck :size="12" weight="bold" />保存
                        </button>
                        <button class="yh-btn yh-btn-sm" @click="取消编辑()">取消</button>
                      </div>
                    </div>
                  </template>
                  <template v-else>
                    <div class="yh-feed-head">
                      <strong class="yh-feed-title">{{ event.标题 }}</strong>
                      <span class="yh-badge" :class="`yh-badge-${event.规模}`">{{
                        scaleLabel[event.规模] ?? event.规模
                      }}</span>
                      <span v-if="event.阶段 === '已结束'" class="yh-badge yh-badge-done">已了结</span>
                      <span v-if="event.隐秘 === '隐秘'" class="yh-badge yh-badge-secret">隐秘</span>
                      <button class="yh-icon-btn yh-feed-edit" title="编辑此事件" @click="startEditEvent(event)">
                        <PhPencilSimple :size="11" weight="regular" />
                      </button>
                      <button class="yh-icon-btn yh-feed-remove" title="移除此事件" @click="removeEvent(event)">
                        <PhX :size="11" weight="bold" />
                      </button>
                    </div>
                    <p class="yh-feed-desc">{{ event.描述 }}</p>
                    <p v-if="event.前情" class="yh-feed-cause">前情 · {{ event.前情 }}</p>
                    <button
                      v-if="event.演变.length > 0"
                      class="yh-collapse yh-trail-toggle"
                      @click="toggleTrail(event.id || event.标题)"
                    >
                      <PhCaretDown :size="11" :class="{ 'is-flipped': !trailOpen[event.id || event.标题] }" />
                      演变 · {{ event.演变.length }}
                    </button>
                    <ul v-if="event.演变.length > 0 && trailOpen[event.id || event.标题]" class="yh-feed-trail">
                      <li v-for="(step, stepIndex) in event.演变" :key="stepIndex">
                        <span class="yh-trail-time">{{ step.时间 || '时间未知' }}</span>
                        <span class="yh-trail-text">{{ step.变化 }}</span>
                      </li>
                    </ul>
                    <div class="yh-feed-meta">
                      <span v-if="event.传播">传播:{{ event.传播 }}</span>
                      <span v-if="event.渠道">渠道:{{ event.渠道 }}</span>
                      <span v-if="event.势力">关联:{{ event.势力 }}</span>
                      <span v-if="event.代表人物">人物:{{ event.代表人物 }}</span>
                      <span>阶段:{{ event.阶段 }}</span>
                    </div>
                  </template>
                </div>
              </li>
            </ol>
            <div v-else class="yh-empty">
              <PhWind :size="26" weight="light" />
              <p>{{ stageFilter === '已结束' ? '还没有了结的事' : '无事发生——世界很安静' }}</p>
            </div>
          </div>

          <!-- ============ 势力 ============ -->
          <div v-else-if="tab === 'factions'" class="yh-page yh-page-master">
            <aside class="yh-master">
              <div v-if="factionEntries.length > 0" class="yh-master-list">
                <button
                  v-for="[name, faction] in factionEntries"
                  :key="name"
                  class="yh-master-item"
                  :class="{ 'is-active': selectedFaction === name }"
                  @click="selectedFaction = name"
                >
                  <strong>{{ name }}</strong>
                  <span>{{ faction.动向 || faction.目标 || '（无动向）' }}</span>
                </button>
              </div>
              <div v-else class="yh-empty yh-empty-slim">
                <PhGraph :size="22" weight="light" />
                <p>尚无势力档案<br />世界推进后自动识别</p>
              </div>
            </aside>
            <div class="yh-detail">
              <template v-if="selectedFactionData">
                <div class="yh-detail-head">
                  <h3>{{ selectedFaction }}</h3>
                  <div class="yh-detail-actions">
                    <button v-if="!势力会话" class="yh-icon-btn" title="编辑此势力" @click="startEditFaction()">
                      <PhPencilSimple :size="13" weight="regular" />
                    </button>
                    <button class="yh-icon-btn" title="移除此势力" @click="removeFaction(selectedFaction)">
                      <PhTrash :size="13" weight="regular" />
                    </button>
                  </div>
                </div>
                <dl v-if="!势力会话" class="yh-detail-rows">
                  <div class="yh-detail-row">
                    <dt>目标</dt>
                    <dd>{{ selectedFactionData.目标 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>头面人物</dt>
                    <dd>{{ selectedFactionData.头面人物 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>动向</dt>
                    <dd>{{ selectedFactionData.动向 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>势力范围</dt>
                    <dd>{{ selectedFactionData.势力范围 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>对外关系</dt>
                    <dd>{{ selectedFactionData.对外关系 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>关联事件</dt>
                    <dd>
                      <template v-if="factionRelatedEvents.length > 0">
                        <span
                          v-for="event in factionRelatedEvents"
                          :key="event.id || event.标题"
                          class="yh-mini-title"
                          style="display: inline-block; margin-right: 10px"
                          @click="tab = 'chronicle'"
                          >{{ event.标题 }}（{{ event.阶段 }}）</span
                        >
                      </template>
                      <template v-else>—</template>
                    </dd>
                  </div>
                </dl>
                <div v-else class="yh-inline-edit">
                  <label class="yh-field">
                    <span class="yh-field-label">目标</span>
                    <textarea v-model="势力会话!.草稿.目标" class="yh-input yh-textarea" rows="2"></textarea>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">动向</span>
                    <textarea v-model="势力会话!.草稿.动向" class="yh-input yh-textarea" rows="2"></textarea>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">前情（来龙去脉滚动总结）</span>
                    <textarea v-model="势力会话!.草稿.前情" class="yh-input yh-textarea" rows="3"></textarea>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">势力范围（地盘与影响：地区/行业/阶层/渠道）</span>
                    <input
                      v-model="势力会话!.草稿.势力范围"
                      type="text"
                      class="yh-input"
                      placeholder="如 北境三城；垄断盐铁 / 好莱坞六大制片厂主导；无明确地盘"
                    />
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">对外关系（与其他势力的关系，每方一条）</span>
                    <textarea
                      v-model="势力会话!.草稿.对外关系"
                      class="yh-input yh-textarea"
                      rows="2"
                      placeholder="如 与X商团盟约渐固；与Y帮派摩擦升级"
                    ></textarea>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">头面人物（首领/掌门/对外代言人，头衔+名字）</span>
                    <input v-model="势力会话!.草稿.头面人物" type="text" class="yh-input" placeholder="如 家主·林远山" />
                  </label>
                  <div class="yh-edit-actions">
                    <button class="yh-btn yh-btn-primary yh-btn-sm" @click="saveFactionEdit">
                      <PhCheck :size="12" weight="bold" />保存
                    </button>
                    <button class="yh-btn yh-btn-sm" @click="取消编辑()">取消</button>
                  </div>
                </div>
                <p class="yh-detail-hint">势力动向由世界推进自动维护, 也可在此手动修改(保存后同步注入)。</p>
              </template>
              <div v-else class="yh-empty">
                <PhGraph :size="26" weight="light" />
                <p>选择一个势力查看详情</p>
              </div>
            </div>
          </div>

          <!-- ============ 世界 ============ -->
          <div v-else-if="tab === 'world'" class="yh-page">
            <p v-if="!hasWorld" class="yh-world-hint">世界尚无档案——推进世界后自动建立, 也可用各区块的「添一笔」手动建档</p>
            <div class="yh-world-body">
              <details class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>大势</span>
                  <em>{{ trendEntries.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('大势')">
                    <PhPlus :size="11" weight="bold" />添一笔
                  </button>
                </summary>
                <world-edit-form
                  v-if="条目会话 && 条目会话.草稿.layer === '大势'"
                  :draft="条目会话.草稿"
                  :defs="layerFields['大势']"
                  @save="saveWorldEdit"
                  @cancel="取消编辑()"
                />
                <ul v-if="trendEntries.length > 0" class="yh-world-list">
                  <li v-for="[name, t] in trendEntries" :key="name" class="yh-world-card">
                    <div class="yh-world-card-head">
                      <strong>{{ name }}</strong>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('大势', name)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('大势', name)">
                          <PhTrash :size="12" weight="regular" />
                        </button>
                      </div>
                    </div>
                    <p v-if="t.进展" class="yh-world-main">{{ t.进展 }}</p>
                    <dl class="yh-world-fields">
                      <div v-if="t.概况">
                        <dt>概况</dt>
                        <dd>{{ t.概况 }}</dd>
                      </div>
                      <div v-if="t.走向">
                        <dt>走向</dt>
                        <dd>{{ t.走向 }}</dd>
                      </div>
                      <div v-if="t.前情">
                        <dt>前情</dt>
                        <dd>{{ t.前情 }}</dd>
                      </div>
                    </dl>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无大势</p>
              </details>

              <details class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>地域</span>
                  <em>{{ regionEntries.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('地域')">
                    <PhPlus :size="11" weight="bold" />添一笔
                  </button>
                </summary>
                <world-edit-form
                  v-if="条目会话 && 条目会话.草稿.layer === '地域'"
                  :draft="条目会话.草稿"
                  :defs="layerFields['地域']"
                  @save="saveWorldEdit"
                  @cancel="取消编辑()"
                />
                <ul v-if="regionEntries.length > 0" class="yh-world-list">
                  <li v-for="[name, r] in regionEntries" :key="name" class="yh-world-card">
                    <div class="yh-world-card-head">
                      <strong>{{ name }}</strong>
                      <span v-if="r.当权者" class="yh-world-delta">{{ r.当权者 }}</span>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('地域', name)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('地域', name)">
                          <PhTrash :size="12" weight="regular" />
                        </button>
                      </div>
                    </div>
                    <p v-if="r.局势" class="yh-world-main">{{ r.局势 }}</p>
                    <dl class="yh-world-fields">
                      <div v-if="r.概况">
                        <dt>概况</dt>
                        <dd>{{ r.概况 }}</dd>
                      </div>
                      <div v-if="r.对外关系">
                        <dt>对外关系</dt>
                        <dd>{{ r.对外关系 }}</dd>
                      </div>
                      <div v-if="r.前情">
                        <dt>前情</dt>
                        <dd>{{ r.前情 }}</dd>
                      </div>
                    </dl>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无地域</p>
              </details>

              <details class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>伏笔</span>
                  <em>{{ seedList.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('伏笔')">
                    <PhPlus :size="11" weight="bold" />添一笔
                  </button>
                </summary>
                <world-edit-form
                  v-if="条目会话 && 条目会话.草稿.layer === '伏笔'"
                  :draft="条目会话.草稿"
                  :defs="layerFields['伏笔']"
                  @save="saveWorldEdit"
                  @cancel="取消编辑()"
                />
                <ul v-if="seedList.length > 0" class="yh-world-list">
                  <li v-for="seed in seedList" :key="seed.标题" class="yh-world-card">
                    <div class="yh-world-card-head">
                      <strong>{{ seed.标题 }}</strong>
                      <span class="yh-badge" :class="'yh-maturity-' + seed.成熟度">{{ seed.成熟度 }}</span>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('伏笔', seed.标题)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('伏笔', seed.标题)">
                          <PhTrash :size="12" weight="regular" />
                        </button>
                      </div>
                    </div>
                    <p v-if="seed.指向" class="yh-world-main">指向 · {{ seed.指向 }}</p>
                    <dl class="yh-world-fields">
                      <div v-if="seed.埋设">
                        <dt>埋设</dt>
                        <dd>{{ seed.埋设 }}</dd>
                      </div>
                      <div v-if="seed.前情">
                        <dt>前情</dt>
                        <dd>{{ seed.前情 }}</dd>
                      </div>
                    </dl>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无伏笔</p>
              </details>

              <details v-if="settings.运转.节令历法" class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>节令</span>
                  <em>{{ occasionList.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('节令')">
                    <PhPlus :size="11" weight="bold" />添一笔
                  </button>
                </summary>
                <world-edit-form
                  v-if="条目会话 && 条目会话.草稿.layer === '节令'"
                  :draft="条目会话.草稿"
                  :defs="layerFields['节令']"
                  @save="saveWorldEdit"
                  @cancel="取消编辑()"
                />
                <ul v-if="occasionList.length > 0" class="yh-world-list">
                  <li v-for="o in occasionList" :key="o.名称" class="yh-world-card">
                    <div class="yh-world-card-head">
                      <strong>{{ o.名称 }}</strong>
                      <span v-if="o.时间" class="yh-badge">{{ o.时间 }}</span>
                      <span v-if="o.周期" class="yh-world-delta">{{ o.周期 }}</span>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('节令', o.名称)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('节令', o.名称)">
                          <PhTrash :size="12" weight="regular" />
                        </button>
                      </div>
                    </div>
                    <p v-if="o.概况" class="yh-world-main">{{ o.概况 }}</p>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无节令</p>
              </details>

              <details v-if="settings.运转.世界指标" class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>指标</span>
                  <em>{{ metricEntries.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('指标')">
                    <PhPlus :size="11" weight="bold" />添一笔
                  </button>
                </summary>
                <world-edit-form
                  v-if="条目会话 && 条目会话.草稿.layer === '指标'"
                  :draft="条目会话.草稿"
                  :defs="layerFields['指标']"
                  @save="saveWorldEdit"
                  @cancel="取消编辑()"
                />
                <ul v-if="metricEntries.length > 0" class="yh-world-grid">
                  <li v-for="[name, m] in metricEntries" :key="name" class="yh-world-card yh-metric-card">
                    <div class="yh-metric-top">
                      <span class="yh-metric-name">{{ name }}</span>
                      <span class="yh-metric-value">{{ m.值 }}</span>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('指标', name)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('指标', name)">
                          <PhTrash :size="12" weight="regular" />
                        </button>
                      </div>
                    </div>
                    <span class="yh-metric-trend">{{ trendArrow(m.趋势) }} {{ m.趋势 }}</span>
                    <p v-if="m.说明" class="yh-metric-note">{{ m.说明 }}</p>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无指标</p>
              </details>
            </div>
          </div>

          <!-- ============ 日志 ============ -->
          <div v-else-if="tab === 'logs'" class="yh-page yh-page-logs">
            <div class="yh-log-left">
              <div v-if="debugLog" class="yh-log-record">
                <p class="yh-log-meta">
                  {{ fmtTimestamp(debugLog.time) }} · {{ debugLog.model || '(未选模型)' }} · 楼层
                  {{ debugLog.replyIds.length > 0 ? debugLog.replyIds.map(id => `#${id}`).join(', ') : '—' }}
                </p>
                <p v-if="debugLog.summary" class="yh-log-summary">{{ debugLog.summary }}</p>
                <div
                  v-if="debugLog.addedEvents.length || debugLog.updatedEvents.length || debugLog.removedEvents.length"
                  class="yh-log-diff"
                >
                  <span v-if="debugLog.addedEvents.length" class="yh-badge yh-badge-add"
                    >新增 {{ debugLog.addedEvents.join('、') }}</span
                  >
                  <span v-if="debugLog.updatedEvents.length" class="yh-badge yh-badge-upd"
                    >推进 {{ debugLog.updatedEvents.join('、') }}</span
                  >
                  <span v-if="debugLog.removedEvents.length" class="yh-badge yh-badge-done"
                    >了结 {{ debugLog.removedEvents.join('、') }}</span
                  >
                </div>
                <div class="yh-log-section">
                  <button class="yh-collapse" @click="toggleCollapse('request')">
                    <PhCaretDown :size="12" :class="{ 'is-flipped': collapsed.request }" />
                    发送给世界引擎的内容
                  </button>
                  <pre v-if="!collapsed.request" class="yh-pre">{{ debugLog.request || '（空）' }}</pre>
                </div>
                <div class="yh-log-section">
                  <button class="yh-collapse" @click="toggleCollapse('response')">
                    <PhCaretDown :size="12" :class="{ 'is-flipped': collapsed.response }" />
                    世界引擎输出
                  </button>
                  <pre v-if="!collapsed.response" class="yh-pre">{{ debugLog.response || '（空）' }}</pre>
                </div>
                <div v-if="debugLog.error" class="yh-log-section">
                  <button class="yh-collapse" @click="toggleCollapse('error')">
                    <PhCaretDown :size="12" :class="{ 'is-flipped': collapsed.error }" />
                    报错
                  </button>
                  <pre v-if="!collapsed.error" class="yh-pre yh-pre-error">{{ debugLog.error }}</pre>
                </div>
                <div class="yh-log-actions">
                  <button class="yh-btn" @click="copyText(joinRecord(), '已复制推进记录')">
                    <PhCopySimple :size="13" weight="regular" />复制推进记录
                  </button>
                  <button class="yh-btn" @click="copyText(buildErrorReport(), '已复制报错报告，可直接发给助手排查')">
                    <PhCopySimple :size="13" weight="regular" />复制报错发给助手
                  </button>
                </div>
              </div>
              <div v-else class="yh-empty">
                <PhScroll :size="26" weight="light" />
                <p>还没有推进记录</p>
              </div>
            </div>
            <div class="yh-log-right">
              <div class="yh-log-right-head">
                <h3 class="yh-col-title">注入给主AI的内容</h3>
                <div class="yh-log-right-actions">
                  <button class="yh-btn yh-btn-sm" @click="showInjection">生成预览</button>
                  <button v-if="injectionPreview" class="yh-btn yh-btn-sm" @click="copyText(injectionPreview)">
                    <PhCopySimple :size="11" weight="regular" />
                  </button>
                </div>
              </div>
              <pre v-if="injectionPreview" class="yh-pre yh-pre-short">{{ injectionPreview }}</pre>
              <p v-else class="yh-mini-empty">点「生成预览」查看当前世界动向会注入给主AI的文本</p>
              <h3 class="yh-col-title">控制台输出</h3>
              <div class="yh-console">
                <p
                  v-for="(line, index) in consoleLinesReversed"
                  :key="`${line.time}-${index}`"
                  class="yh-console-line"
                  :class="`is-${line.type}`"
                >
                  <span class="yh-console-time">{{
                    new Date(line.time).toLocaleTimeString('zh-CN', { hour12: false })
                  }}</span>
                  {{ line.text }}
                </p>
                <p v-if="consoleLines.length === 0" class="yh-mini-empty">（无输出）</p>
              </div>
              <button class="yh-btn yh-btn-sm" @click="consoleStore.clear()">清空控制台</button>
            </div>
          </div>

          <!-- ============ 设置 ============ -->
          <div v-else class="yh-page yh-page-settings">
            <div class="yh-set-stack">
              <div class="yh-set-col">
                <h3 class="yh-col-title">接口配置</h3>
                <div class="yh-preset-row">
                  <select v-model="selectedPreset" class="yh-input yh-select">
                    <option value="">选择预设…</option>
                    <option v-for="name in presetNames" :key="name" :value="name">{{ name }}</option>
                  </select>
                  <button class="yh-btn yh-btn-sm" :disabled="!selectedPreset" @click="loadApiPreset">加载</button>
                  <button class="yh-btn yh-btn-sm yh-btn-danger" :disabled="!selectedPreset" @click="deleteApiPreset">
                    删除
                  </button>
                </div>
                <div class="yh-preset-row">
                  <input
                    v-model="presetName"
                    class="yh-input"
                    placeholder="预设名，如 DeepSeek"
                    @keyup.enter="saveApiPreset"
                  />
                  <button class="yh-btn yh-btn-sm" @click="saveApiPreset">
                    <PhPlus :size="11" weight="bold" />存为预设
                  </button>
                </div>
                <label class="yh-field">
                  <span class="yh-field-label">接口地址（OpenAI 兼容，末尾自动补 /v1）</span>
                  <input
                    v-model="settings.接口.地址"
                    type="text"
                    class="yh-input"
                    placeholder="https://api.example.com"
                  />
                </label>
                <label class="yh-field">
                  <span class="yh-field-label">API 密钥</span>
                  <div class="yh-key-row">
                    <input
                      v-model="settings.接口.密钥"
                      :type="showKey ? 'text' : 'password'"
                      class="yh-input"
                      placeholder="sk-…"
                    />
                    <button class="yh-icon-btn" @click="showKey = !showKey">
                      <PhEye v-if="!showKey" :size="14" weight="regular" />
                      <PhEyeSlash v-else :size="14" weight="regular" />
                    </button>
                  </div>
                </label>
                <div class="yh-field">
                  <span class="yh-field-label">模型</span>
                  <div class="yh-key-row">
                    <select v-model="settings.接口.模型" class="yh-input yh-select">
                      <option value="">未选择</option>
                      <option v-for="model in settings.接口.模型列表" :key="model" :value="model">{{ model }}</option>
                      <option
                        v-if="settings.接口.模型 && !settings.接口.模型列表.includes(settings.接口.模型)"
                        :value="settings.接口.模型"
                      >
                        {{ settings.接口.模型 }}
                      </option>
                    </select>
                    <button class="yh-btn yh-btn-sm" :disabled="fetchingModels" @click="onFetchModels">
                      {{ fetchingModels ? '获取中…' : '获取模型列表' }}
                    </button>
                  </div>
                </div>
                <div class="yh-field-pair">
                  <label class="yh-field">
                    <span class="yh-field-label">温度（越低越稳定）</span>
                    <input
                      v-model.number="settings.接口.温度"
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      class="yh-input"
                    />
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">最大输出Token</span>
                    <input
                      v-model.number="settings.接口.最大token"
                      type="number"
                      min="1"
                      max="131072"
                      class="yh-input"
                    />
                  </label>
                </div>
                <div class="yh-toggles">
                  <!-- 转发开关已删除: 转发是唯一通路, 没有可切换的东西了 -->
                  <label class="yh-toggle">
                    <input v-model="settings.接口.流式" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">流式输出<em>长输出更不易被网关掐断</em></span>
                  </label>
                </div>
                <button class="yh-btn" :disabled="testing" @click="onTestConnection">
                  <PhLightning :size="13" weight="fill" />
                  {{ testing ? '测试中…' : '测试连接' }}
                </button>
              </div>
              <div class="yh-set-col">
                <h3 class="yh-col-title">请求技巧</h3>
                <div class="yh-toggles">
                  <label class="yh-toggle">
                    <input v-model="settings.运转.预填充" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">预填充<em>引导模型直接输出 JSON，减少格式失败</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.破限" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">破限<em>接口有内容政策拦截时使用</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.头部填充" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >头部填充<em>填充文本作为第一条消息单独发送，留空用内置小说原文</em></span
                    >
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.防截断" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">防截断<em>缝在 system 末尾</em></span>
                  </label>
                </div>
                <label class="yh-field" style="margin-top: 2px">
                  <span class="yh-field-label">头部填充文本（留空使用内置小说原文，建议1W字左右）</span>
                  <textarea
                    v-model="settings.运转.头部填充文本"
                    class="yh-input yh-textarea"
                    rows="6"
                    placeholder="开启「头部填充」后，这段文本会作为第一条消息原样发送；留空则使用内置的小说原文"
                  ></textarea>
                </label>
              </div>
            </div>
            <div class="yh-set-stack">
              <div class="yh-set-col">
                <h3 class="yh-col-title">运转</h3>
                <div class="yh-toggles">
                  <label class="yh-toggle">
                    <input v-model="settings.启用运转" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">启用世界运转<em>关闭后不再调用接口、不再自动推进</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.自动更新" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">自动推进<em>每次（或每 N 次）AI 回复后推进一次世界</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.节令历法" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">节令历法<em>按世界观生成节庆/汛期/开市/检阅等周期节点</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.世界指标" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >世界指标<em>少量慢变数值（丰歉/物价/能源/民心等，按世界观取名）</em></span
                    >
                  </label>
                </div>
                <div class="yh-field-pair">
                  <label class="yh-field">
                    <span class="yh-field-label">更新频率</span>
                    <input v-model.number="settings.运转.更新频率" type="number" min="1" max="50" class="yh-input" />
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">读取最近回复数</span>
                    <input
                      v-model.number="settings.运转.读取最近回复数"
                      type="number"
                      min="1"
                      max="20"
                      class="yh-input"
                    />
                  </label>
                </div>
                <div class="yh-field-pair">
                  <label class="yh-field">
                    <span class="yh-field-label">快照保留份数</span>
                    <input
                      v-model.number="settings.运转.快照保留份数"
                      type="number"
                      min="1"
                      max="100"
                      class="yh-input"
                    />
                    <span class="yh-field-label" style="font-weight: 400; color: var(--yh-ink-faint)"
                      >删楼回退的保险窗口：保留最近 N
                      份楼层快照（1~100）。每份几KB~30KB，保留过多时聊天文件随之变大</span
                    >
                  </label>
                </div>
              </div>
              <div class="yh-set-col">
                <h3 class="yh-col-title">注入主AI</h3>
                <div class="yh-toggles">
                  <label class="yh-toggle">
                    <input v-model="settings.运转.注入世界书条目" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >注入世界动向到主AI<em>写入角色卡主世界书常驻条目「【烟火】世界动向」，切聊天自动重写</em></span
                    >
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.注入隐秘事件" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >注入隐秘事件到主AI<em
                        >默认关闭——隐秘事件只进面板，供烟火推演；开启后标注"主角绝不可能知道"注入</em
                      ></span
                    >
                  </label>
                </div>
              </div>
              <div class="yh-set-col">
                <h3 class="yh-col-title">世界书与标签</h3>
                <div class="yh-toggles">
                  <label class="yh-toggle">
                    <input v-model="settings.运转.读取世界书" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >给世界引擎注入世界书<em>与主AI相同的激活方式，主AI读到什么它读到什么</em></span
                    >
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.读取全局世界书" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">包含全局世界书<em>默认只读角色卡与聊天绑定的世界书</em></span>
                  </label>
                </div>
                <label class="yh-field">
                  <span class="yh-field-label">世界书排除条目（顿号分隔）</span>
                  <input
                    v-model="worldbookExcludeText"
                    type="text"
                    class="yh-input"
                    placeholder="如 某条目名、某关键词"
                  />
                </label>
                <div class="yh-field-pair">
                  <label class="yh-field">
                    <span class="yh-field-label">楼层标签过滤·模式</span>
                    <select v-model="settings.标签.模式" class="yh-input yh-select">
                      <option value="排除">排除——删掉这些标签里的内容</option>
                      <option value="只读">只读——只读这些标签里的内容</option>
                    </select>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">标签列表（顿号分隔）</span>
                    <input v-model="tagListText" type="text" class="yh-input" placeholder="如 thinking、aftertalk" />
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <footer class="yh-footer">
        <span>{{ settings.接口.模型 || '未配置接口' }}</span>
        <span>{{ world.世界.时间 || '世界时间未知' }}</span>
        <span>快照 {{ world.锚点楼层 >= 0 ? `#${world.锚点楼层}` : '无' }}</span>
      </footer>
    </section>
  </div>
</template>

<style lang="scss">
// ---------------------------------------------------------------------------
// 「石墨 × 象牙 × 朱砂印」— 按 color-expert 方法构建: OKLCH 极中性石墨面层(无色相倾向),
// 象牙白文字, 交互主色=反相(暗色下象牙按钮/亮色下墨按钮), 朱砂只占 10%(印章/焦点/山雨欲来)
// ---------------------------------------------------------------------------

.yh-root {
  // 配色 token(--yh-*)与球直径/层序都只在 主题.ts 里写一处, 由 取根变量() 生成后绑在本元素的内联样式上
  // (见 <script setup> 的 根样式), 这里只写 var(...) 引用——要改颜色/球径/层序, 改 主题.ts。

  position: fixed;
  inset: 0;
  font-family: 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;
  font-size: 13px;
  line-height: 1.6;
  color: var(--yh-ink);
  pointer-events: none;
  z-index: var(--yh-z-root);

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  button,
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
  }

  // ---- 印章 logo(朱文方印: 实心朱砂 + 镂空火纹) ----
  .yh-seal-base {
    fill: var(--yh-seal);
  }
  .yh-seal-cut {
    fill: var(--yh-panel);
  }
  .yh-flame {
    fill: var(--yh-seal);
  }

  // ---- 悬浮球: 扁平墨印, 一点朱砂 ----
  .yh-orb {
    pointer-events: auto;
    position: absolute;
    // 球直径只有 主题.ts 一处(悬浮球直径 → --yh-orb-size), 锚点偏移与 iframe 尺寸也从那一个数来
    width: var(--yh-orb-size);
    height: var(--yh-orb-size);
    display: grid;
    place-items: center;
    background: var(--yh-panel);
    border: 1px solid var(--yh-line-strong);
    border-radius: 50%;
    cursor: grab;
    padding: 0;
    appearance: none;
    outline: none;
    -webkit-tap-highlight-color: transparent;
    // 触屏拖动: 禁止浏览器把 pointermove 当滚动/长按手势吞掉, 拖球才跟手
    touch-action: none;
    z-index: var(--yh-z-orb);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
    transition:
      border-color 0.2s,
      box-shadow 0.2s;

    .yh-orb-mark {
      width: 22px;
      height: 22px;
      transform-origin: 50% 78%;
    }
    &:hover {
      border-color: var(--yh-accent);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    }
    &.is-dragging {
      cursor: grabbing;
    }
    &.is-open {
      border-color: var(--yh-seal);
    }
    // 推进中: 火苗摇曳(缩放+透明度微抖), 替代原来的状态小圆点
    &.is-updating {
      .yh-orb-mark {
        animation: yh-flicker 1.1s ease-in-out infinite;
      }
    }
  }
  @keyframes yh-flicker {
    0%,
    100% {
      transform: scale(1, 1);
      opacity: 1;
    }
    25% {
      transform: scale(1.06, 0.94);
      opacity: 0.82;
    }
    50% {
      transform: scale(0.95, 1.06);
      opacity: 1;
    }
    75% {
      transform: scale(1.03, 0.97);
      opacity: 0.88;
    }
  }
  @keyframes yh-breath {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }

  // ---- 面板: 小窗 ----
  .yh-panel {
    z-index: var(--yh-z-panel);
    pointer-events: auto;
    position: absolute;
    display: flex;
    flex-direction: column;
    background: var(--yh-panel);
    border: 1px solid var(--yh-line-strong);
    border-radius: 12px;
    // 阴影由酒馆页面上的阴影层绘制(iframe 内绘制会被 clip-path 裁出硬边), 见 syncPanelShadow
    box-shadow: none;
    overflow: hidden;
    animation: yh-panel-in 0.22s cubic-bezier(0.2, 0.9, 0.25, 1);
    &.is-dragging {
      user-select: none;
    }
  }
  @keyframes yh-panel-in {
    from {
      opacity: 0;
      scale: 0.97;
    }
    to {
      opacity: 1;
      scale: 1;
    }
  }

  .yh-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px 10px 16px;
    border-bottom: 1px solid var(--yh-line);
    cursor: grab;
    user-select: none;
    // 触屏拖动面板: 禁止浏览器手势接管 pointermove(同悬浮球)
    touch-action: none;
    &:active {
      cursor: grabbing;
    }
  }
  .yh-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    pointer-events: none;
  }
  .yh-mark {
    width: 26px;
    height: 26px;
  }
  .yh-brand-name {
    font-family: var(--yh-serif);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 0.3em;
    margin-right: -0.3em;
  }
  .yh-brand-sub {
    display: block;
    font-size: 10.5px;
    color: var(--yh-ink-faint);
    letter-spacing: 0.05em;
  }
  .yh-header-side {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .yh-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--yh-ink-dim);
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid var(--yh-line);
    .yh-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--yh-ink-faint);
    }
    &.is-on .yh-status-dot {
      background: var(--yh-seal);
    }
  }
  .yh-icon-btn {
    pointer-events: auto;
    display: inline-grid;
    place-items: center;
    padding: 0;
    line-height: 0;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--yh-ink-dim);
    cursor: pointer;
    transition: all 0.15s;
    svg {
      display: block;
    }
    &:hover {
      background: var(--yh-bg-hover);
      color: var(--yh-ink);
      border-color: var(--yh-line);
    }
  }

  // ---- 左侧竖排文字栏 ----
  .yh-frame {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .yh-rail {
    flex: none;
    width: 56px;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    padding: 14px 0;
    border-right: 1px solid var(--yh-line);
    background: var(--yh-bg);
  }
  .yh-rail-item {
    position: relative;
    display: grid;
    place-items: center;
    padding: 12px 0;
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background 0.15s;
    .yh-rail-text {
      writing-mode: vertical-rl;
      letter-spacing: 0.34em;
      font-size: 12.5px;
      color: var(--yh-ink-faint);
      transition: color 0.15s;
    }
    &::before {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%) scaleY(0);
      width: 2px;
      height: 18px;
      background: var(--yh-seal);
      transition: transform 0.18s ease-out;
    }
    &:hover {
      background: var(--yh-hover);
      .yh-rail-text {
        color: var(--yh-ink-dim);
      }
    }
    &.is-active {
      .yh-rail-text {
        color: var(--yh-accent-strong);
      }
      &::before {
        transform: translateY(-50%) scaleY(1);
      }
    }
  }

  .yh-body {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .yh-page {
    height: 100%;
    overflow-y: auto;
    padding: 16px 18px 18px;
    &.yh-page-master,
    &.yh-page-logs,
    &.yh-page-settings {
      display: grid;
      gap: 16px;
    }
    &.yh-page-master {
      grid-template-columns: 220px 1fr;
      padding: 0;
      overflow: hidden;
    }
    &.yh-page-logs {
      grid-template-columns: 1.15fr 1fr;
    }
    &.yh-page-settings {
      grid-template-columns: 1fr 1fr;
      align-items: start;
    }
  }

  // ---- 此刻 ----
  .yh-now-head {
    padding: 2px 0 14px;
    border-bottom: 1px solid var(--yh-line);
    margin-bottom: 14px;
  }
  .yh-now-time {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  .yh-time-label {
    font-size: 11px;
    color: var(--yh-ink-faint);
    letter-spacing: 0.3em;
  }
  .yh-time-value {
    font-family: var(--yh-serif);
    font-size: 26px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--yh-ink);
    font-variant-numeric: tabular-nums;
  }
  .yh-now-mood {
    margin: 5px 0 0;
    color: var(--yh-accent-strong);
    font-size: 13.5px;
  }
  .yh-now-trend {
    margin: 5px 0 0;
    color: var(--yh-ink-dim);
    max-width: 68ch;
  }
  .yh-now-empty {
    margin: 8px 0 0;
    color: var(--yh-ink-faint);
  }
  .yh-now-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-top: 12px;
  }
  .yh-btn {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid var(--yh-line-strong);
    background: var(--yh-raise);
    color: var(--yh-ink);
    cursor: pointer;
    font-size: 12px;
    transition: all 0.15s;
    &:hover:not(:disabled) {
      border-color: var(--yh-accent-deep);
      background: var(--yh-hover);
    }
    &:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    &.yh-btn-primary {
      background: var(--yh-accent);
      border-color: var(--yh-accent);
      color: var(--yh-on-accent);
      &:hover:not(:disabled) {
        background: color-mix(in oklab, var(--yh-accent) 86%, var(--yh-panel));
        border-color: color-mix(in oklab, var(--yh-accent) 86%, var(--yh-panel));
      }
    }
    &.yh-btn-danger {
      color: var(--yh-seal);
      &.is-confirm {
        background: var(--yh-seal);
        border-color: var(--yh-seal);
        color: #fff5f0;
      }
    }
    &.yh-btn-sm {
      padding: 3px 9px;
      font-size: 11.5px;
      border-radius: 6px;
    }
    &.yh-interrupt {
      color: var(--yh-seal);
      border-color: color-mix(in srgb, var(--yh-seal) 60%, transparent);
      &:hover:not(:disabled) {
        background: color-mix(in srgb, var(--yh-seal) 12%, transparent);
        border-color: var(--yh-seal);
      }
    }
  }

  .yh-edit-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 9px 12px;
    padding: 11px 13px;
    margin-bottom: 14px;
    background: var(--yh-raise);
    border: 1px solid var(--yh-line);
    border-radius: 10px;
    .yh-field-wide {
      grid-column: 1 / -1;
    }
  }

  .yh-urgent {
    display: flex;
    gap: 11px;
    align-items: flex-start;
    padding: 11px 14px;
    margin-bottom: 14px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--yh-seal) 45%, transparent);
    background: color-mix(in srgb, var(--yh-seal) 8%, transparent);
    color: var(--yh-seal);
    strong {
      font-size: 12.5px;
      letter-spacing: 0.2em;
    }
    p {
      margin: 2px 0 0;
      color: var(--yh-ink-dim);
    }
  }

  .yh-now-columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }
  .yh-col-title {
    margin: 0 0 9px;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.22em;
    color: var(--yh-ink-dim);
  }
  .yh-mini-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
    li {
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: 7px 11px;
      border-radius: 8px;
      background: var(--yh-raise);
      border: 1px solid var(--yh-line);
    }
  }
  .yh-mini-title {
    font-weight: 600;
    font-size: 12.5px;
    cursor: pointer;
    &:hover {
      color: var(--yh-accent-strong);
    }
  }
  .yh-mini-desc {
    font-size: 11.5px;
    color: var(--yh-ink-dim);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .yh-mini-empty {
    color: var(--yh-ink-faint);
    font-size: 12px;
    margin: 0;
  }
  .yh-now-meta {
    margin: 14px 0 0;
    font-size: 11.5px;
    color: var(--yh-ink-faint);
  }

  // ---- 风闻 ----
  .yh-filter-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    margin-bottom: 13px;
  }
  .yh-chip-group {
    display: flex;
    gap: 5px;
  }
  .yh-chip {
    padding: 3px 11px;
    border-radius: 999px;
    border: 1px solid var(--yh-line);
    background: transparent;
    color: var(--yh-ink-dim);
    cursor: pointer;
    font-size: 11.5px;
    transition: all 0.15s;
    &:hover {
      color: var(--yh-ink);
      border-color: var(--yh-line-strong);
    }
    &.is-active {
      background: var(--yh-accent);
      border-color: var(--yh-accent);
      color: var(--yh-on-accent);
    }
  }
  .yh-feed {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .yh-feed-item {
    display: grid;
    grid-template-columns: 132px 1fr;
    gap: 14px;
    padding: 11px 4px;
    border-bottom: 1px solid var(--yh-line);
    &.scale-大事 .yh-feed-title {
      color: var(--yh-seal);
    }
    &.is-已结束 {
      opacity: 0.55;
      .yh-feed-title {
        color: var(--yh-ink-dim);
      }
    }
    &:hover .yh-feed-remove {
      opacity: 1;
    }
  }
  .yh-feed-when {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 2px;
  }
  .yh-feed-time {
    font-size: 11.5px;
    color: var(--yh-ink-dim);
    font-variant-numeric: tabular-nums;
  }
  .yh-feed-place {
    font-size: 11px;
    color: var(--yh-ink-faint);
  }
  .yh-feed-main {
    min-width: 0;
  }
  .yh-feed-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .yh-feed-title {
    font-size: 13.5px;
    font-weight: 600;
  }
  .yh-feed-desc {
    margin: 3px 0 4px;
    color: var(--yh-ink-dim);
    max-width: 66ch;
  }
  .yh-feed-cause {
    margin: 0 0 3px;
    font-size: 11.5px;
    color: var(--yh-ink-faint);
    max-width: 66ch;
  }
  .yh-trail-toggle {
    font-size: 11px;
    padding: 1px 0;
    margin: 0 0 4px;
    color: var(--yh-ink-faint);
    &:hover {
      color: var(--yh-accent-strong);
    }
  }
  .yh-feed-trail {
    list-style: none;
    margin: 0 0 5px;
    padding: 3px 0 3px 13px;
    border-left: 2px solid var(--yh-line-strong);
    display: flex;
    flex-direction: column;
    gap: 4px;
    li {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .yh-trail-time {
      flex: none;
      font-size: 10.5px;
      color: var(--yh-ink-faint);
      font-variant-numeric: tabular-nums;
    }
    .yh-trail-text {
      font-size: 11.5px;
      color: var(--yh-ink-dim);
    }
  }
  .yh-feed-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 11px;
    font-size: 11px;
    color: var(--yh-ink-faint);
  }
  .yh-feed-remove {
    opacity: 0;
    width: 20px;
    height: 20px;
    border-radius: 6px;
    color: var(--yh-ink-faint);
    &:hover {
      color: var(--yh-seal);
    }
  }
  .yh-feed-edit {
    width: 20px;
    height: 20px;
    border-radius: 6px;
    color: var(--yh-ink-faint);
    opacity: 0.6;
    &:hover {
      color: var(--yh-accent-strong);
      opacity: 1;
    }
  }
  .yh-inline-edit {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .yh-edit-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 7px;
  }
  .yh-edit-actions {
    display: flex;
    gap: 6px;
  }
  .yh-detail-actions {
    display: flex;
    gap: 4px;
  }
  .yh-badge {
    display: inline-flex;
    align-items: center;
    padding: 0 7px;
    border-radius: 999px;
    font-size: 10.5px;
    border: 1px solid var(--yh-line-strong);
    color: var(--yh-ink-dim);
    &.yh-badge-大事 {
      border-color: var(--yh-seal);
      color: var(--yh-seal);
      background: color-mix(in srgb, var(--yh-seal) 10%, transparent);
    }
    &.yh-badge-要事 {
      border-color: var(--yh-gold);
      color: var(--yh-gold);
    }
    &.yh-badge-urgent {
      border-color: var(--yh-seal);
      color: var(--yh-seal);
      background: color-mix(in srgb, var(--yh-seal) 10%, transparent);
    }
    &.yh-badge-secret {
      border-style: dashed;
      color: var(--yh-seal);
    }
    &.yh-badge-done {
      color: var(--yh-ink-faint);
    }
    &.yh-badge-add {
      border-color: var(--yh-good);
      color: var(--yh-good);
    }
    &.yh-badge-upd {
      border-color: var(--yh-gold);
      color: var(--yh-gold);
    }
  }

  // ---- 脉络 ----
  .yh-master {
    border-right: 1px solid var(--yh-line);
    overflow-y: auto;
    padding: 16px 0;
    height: 100%;
  }
  .yh-master-list {
    display: flex;
    flex-direction: column;
  }
  .yh-master-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: 9px 16px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    cursor: pointer;
    transition: background 0.15s;
    strong {
      font-size: 13px;
      color: var(--yh-ink);
    }
    span {
      font-size: 11px;
      color: var(--yh-ink-faint);
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    &:hover {
      background: var(--yh-hover);
    }
    &.is-active {
      background: var(--yh-raise);
      border-left-color: var(--yh-accent);
    }
  }
  .yh-detail {
    overflow-y: auto;
    padding: 18px 20px;
    height: 100%;
  }
  .yh-detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    h3 {
      margin: 0;
      font-family: var(--yh-serif);
      font-size: 20px;
      letter-spacing: 0.1em;
    }
  }
  .yh-detail-rows {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .yh-detail-row {
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: 12px;
    padding: 9px 13px;
    background: var(--yh-raise);
    border: 1px solid var(--yh-line);
    border-radius: 9px;
    dt {
      font-size: 11.5px;
      color: var(--yh-ink-faint);
      padding-top: 2px;
      letter-spacing: 0.1em;
    }
    dd {
      margin: 0;
      color: var(--yh-ink);
    }
  }
  .yh-detail-hint {
    margin-top: 14px;
    font-size: 11.5px;
    color: var(--yh-ink-faint);
  }

  // ---- 日志 ----
  .yh-log-left,
  .yh-log-right {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .yh-log-record {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .yh-log-meta {
    margin: 0;
    font-size: 11.5px;
    color: var(--yh-ink-faint);
  }
  .yh-log-summary {
    margin: 0;
    color: var(--yh-accent-strong);
  }
  .yh-log-diff {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;

    // 长标题列表会让徽标折成多行: 限制宽度让其正常换行, 胶囊圆角在多行下会撑破边框, 放宽为小圆角
    .yh-badge {
      max-width: 100%;
      border-radius: 8px;
      white-space: normal;
      word-break: break-word;
      text-align: left;
    }
  }
  .yh-log-section {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .yh-collapse {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: none;
    color: var(--yh-ink-dim);
    cursor: pointer;
    font-size: 12px;
    padding: 2px 0;
    &:hover {
      color: var(--yh-ink);
    }
    svg {
      transition: transform 0.15s;
      &.is-flipped {
        transform: rotate(-90deg);
      }
    }
  }
  .yh-pre {
    margin: 0;
    padding: 9px 11px;
    background: var(--yh-bg);
    border: 1px solid var(--yh-line);
    border-radius: 9px;
    font-size: 11px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 190px;
    overflow-y: auto;
    color: var(--yh-ink-dim);
    &.yh-pre-short {
      max-height: 140px;
    }
    &.yh-pre-error {
      color: var(--yh-seal);
      border-color: color-mix(in srgb, var(--yh-seal) 40%, transparent);
    }
  }
  .yh-log-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-top: 3px;
  }
  .yh-log-right-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .yh-log-right-actions {
    display: flex;
    gap: 5px;
  }
  .yh-console {
    background: var(--yh-bg);
    border: 1px solid var(--yh-line);
    border-radius: 9px;
    padding: 7px 11px;
    max-height: 220px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .yh-console-line {
    margin: 0;
    font-size: 11px;
    color: var(--yh-ink-dim);
    word-break: break-all;
    &.is-warn {
      color: var(--yh-gold);
    }
    &.is-error {
      color: var(--yh-seal);
    }
  }
  .yh-console-time {
    color: var(--yh-ink-faint);
    margin-right: 7px;
    font-variant-numeric: tabular-nums;
  }

  // ---- 设置 ----
  .yh-set-col {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 15px;
    background: var(--yh-bg);
    border: 1px solid var(--yh-line);
    border-radius: 11px;
  }
  .yh-set-col .yh-col-title {
    margin-bottom: 1px;
  }
  .yh-set-stack {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .yh-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .yh-field-label {
    font-size: 11.5px;
    color: var(--yh-ink-dim);
  }
  .yh-field-pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 11px;
  }
  .yh-input {
    pointer-events: auto;
    width: 100%;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--yh-line-strong);
    background: var(--yh-panel);
    color: var(--yh-ink);
    outline: none;
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
    &::placeholder {
      color: var(--yh-ink-faint);
    }
    &:focus {
      border-color: var(--yh-accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--yh-seal) 15%, transparent);
    }
  }
  textarea.yh-input {
    resize: vertical;
    min-height: 52px;
  }
  .yh-select {
    appearance: none;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--yh-ink-dim) 50%),
      linear-gradient(135deg, var(--yh-ink-dim) 50%, transparent 50%);
    background-position:
      calc(100% - 15px) 55%,
      calc(100% - 10px) 55%;
    background-size: 5px 5px;
    background-repeat: no-repeat;
    padding-right: 26px;
  }
  .yh-key-row {
    display: flex;
    gap: 5px;
    align-items: center;
    .yh-input {
      flex: 1;
    }
  }
  .yh-preset-row {
    display: flex;
    gap: 5px;
    align-items: center;
    .yh-input {
      flex: 1;
    }
  }
  .yh-toggles {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .yh-toggle {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    cursor: pointer;
    input {
      display: none;
      &:checked + .yh-toggle-track {
        background: var(--yh-accent);
        border-color: var(--yh-accent);
        &::after {
          left: 14px;
          background: var(--yh-on-accent);
        }
      }
    }
  }
  .yh-toggle-track {
    flex: none;
    position: relative;
    width: 30px;
    height: 17px;
    margin-top: 2px;
    border-radius: 999px;
    border: 1px solid var(--yh-line-strong);
    background: var(--yh-panel);
    transition: all 0.18s;
    &::after {
      content: '';
      position: absolute;
      left: 2px;
      top: 2px;
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: var(--yh-ink-faint);
      transition: all 0.18s;
    }
  }
  .yh-toggle-text {
    font-size: 12px;
    em {
      display: block;
      font-style: normal;
      font-size: 11px;
      color: var(--yh-ink-faint);
    }
  }

  // ---- 空状态 / 滚动条 / 选区 / 焦点 ----
  .yh-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 9px;
    color: var(--yh-ink-faint);
    padding: 40px 0;
    p {
      margin: 0;
      text-align: center;
    }
    &.yh-empty-slim {
      padding: 20px 0;
    }
  }
  ::selection {
    background: color-mix(in srgb, var(--yh-seal) 32%, transparent);
  }
  ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  ::-webkit-scrollbar-thumb {
    background: var(--yh-line-strong);
    border-radius: 999px;
    border: 2px solid transparent;
    background-clip: padding-box;
    &:hover {
      background: var(--yh-ink-faint);
      background-clip: padding-box;
    }
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--yh-seal) 55%, transparent);
    outline-offset: 1px;
  }

  .yh-footer {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    padding: 7px 14px;
    border-top: 1px solid var(--yh-line);
    font-size: 11px;
    color: var(--yh-ink-faint);
  }

  // ---- 白天: 月白 × 黛青 × 朱 ----
  // 白天的色值同样只在 主题.ts(白天)里写一处, 由 取根变量() 跟着内联的 --yh-* 换;
  // 这里只留"白天另有形状/阴影差异"的那几条。
  &[data-theme='light'] {
    .yh-orb {
      background: var(--yh-panel);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
      .yh-orb-status {
        border-color: var(--yh-panel);
      }
    }
  }

  // ---- 窄屏/手机 ----
  // 断点与 computePanelSize 的 isNarrow(<700) 保持一致; 此外面板尺寸由 JS 决定,
  // CSS 只负责面板**内部**布局的收缩
  @media (max-width: 700px) {
    .yh-panel {
      border-radius: 10px;
    }
    // 左侧竖排 rail → 底部横排标签栏(拇指可达): 竖排文字在窄屏挤占宽度,
    // 底栏是手机的原生导航位置
    .yh-frame {
      flex-direction: column-reverse;
    }
    .yh-rail {
      flex-direction: row;
      width: 100%;
      justify-content: space-around;
      gap: 0;
      padding: 4px 2px calc(4px + env(safe-area-inset-bottom, 0px));
      border-right: none;
      border-top: 1px solid var(--yh-line);
      .yh-rail-item {
        flex: 1;
        min-height: 44px; // 触摸目标下限
        padding: 8px 2px;
        &::before {
          // 竖向指示条 → 顶部横向指示条
          left: 50%;
          top: 0;
          transform: translateX(-50%) scaleX(0);
          width: 18px;
          height: 2px;
        }
        &.is-active::before {
          transform: translateX(-50%) scaleX(1);
        }
        .yh-rail-text {
          writing-mode: horizontal-tb;
          letter-spacing: 0.18em;
          font-size: 11.5px;
        }
      }
    }
    .yh-page {
      padding: 12px;
      &.yh-page-master,
      &.yh-page-logs,
      &.yh-page-settings {
        grid-template-columns: 1fr;
      }
      &.yh-page-master {
        padding: 12px;
        overflow-y: auto;
        display: block;
      }
      &.yh-page-logs,
      &.yh-page-settings {
        overflow-y: auto;
      }
    }
    .yh-master {
      border-right: none;
      border-bottom: 1px solid var(--yh-line);
      padding: 10px 0;
      height: auto; // block 布局下不占满, 由页容器统一滚动
    }
    // 选中指示从左竖条改为顶部横条(与底部标签栏视觉一致)
    .yh-master-item {
      border-left: none;
      border-top: 2px solid transparent;
      padding: 12px 14px;
      &.is-active {
        border-top-color: var(--yh-accent);
      }
    }
    .yh-now-columns,
    .yh-edit-grid,
    .yh-field-pair {
      grid-template-columns: 1fr;
    }
    .yh-feed-item {
      grid-template-columns: 1fr;
      gap: 5px;
    }
    .yh-feed-when {
      flex-direction: row;
      gap: 8px;
    }
    // 触屏没有 hover: 靠 hover 显形的操作按钮(移除/编辑)常显, 避免功能不可达
    @media (hover: none) {
      .yh-feed-remove,
      .yh-feed-edit {
        opacity: 0.85;
      }
    }
    .yh-footer {
      flex-wrap: wrap;
      gap: 3px 10px;
    }
    // 详情行的字段名列在超窄下折到值上方, 避免挤压
    .yh-detail-row {
      grid-template-columns: 1fr;
      gap: 3px;
    }
    // 表单行内编辑在窄屏改为纵向
    .yh-edit-row {
      grid-template-columns: 1fr 1fr;
    }
    // 触摸目标: 图标按钮与状态胶囊放大到 ≥40px 触达面积(视觉尺寸不变, 用 padding 扩)
    .yh-icon-btn {
      width: 40px;
      height: 40px;
    }
    .yh-btn {
      padding: 9px 14px; // 按钮 ≥40px 高
    }
    .yh-status {
      padding: 6px 12px;
    }
    // 品牌副标语在窄屏塞不下, 收起(名字保留)
    .yh-brand-sub {
      display: none;
    }
  }
}

/* ---- 世界 ---- */
.yh-world-sec {
  margin-bottom: 6px;
  > summary {
    display: flex;
    align-items: center;
    gap: 7px;
    cursor: pointer;
    list-style: none;
    padding: 5px 0 7px;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.22em;
    color: var(--yh-ink-dim);
    user-select: none;
    &::-webkit-details-marker {
      display: none;
    }
    em {
      font-style: normal;
      font-weight: 400;
      font-size: 11px;
      letter-spacing: 0;
      color: var(--yh-ink-faint);
    }
    .yh-world-caret {
      color: var(--yh-ink-faint);
      transition: transform 0.15s ease;
    }
    &:hover {
      color: var(--yh-accent-strong);
    }
  }
  &:not([open]) > summary .yh-world-caret {
    transform: rotate(-90deg);
  }
}
.yh-world-list {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.yh-world-grid {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
}
.yh-world-card {
  background: var(--yh-raise);
  border: 1px solid var(--yh-line);
  border-radius: 9px;
  padding: 9px 12px 10px;
}
.yh-world-card-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  strong {
    font-size: 13px;
    font-weight: 600;
    color: var(--yh-ink);
  }
}
.yh-world-delta {
  font-size: 11px;
  line-height: 1.45;
  color: var(--yh-ink-faint);
}
.yh-world-main {
  margin: 5px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--yh-ink);
}
.yh-world-fields {
  margin: 7px 0 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 10px;
  align-items: baseline;
  > div {
    display: contents;
  }
  dt {
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--yh-ink-faint);
  }
  dd {
    margin: 0;
    font-size: 12px;
    line-height: 1.55;
    color: var(--yh-ink-dim);
  }
}
.yh-maturity-酝酿 {
  color: var(--yh-ink-faint);
}
.yh-maturity-将熟 {
  border-color: var(--yh-gold);
  color: var(--yh-gold);
  background: color-mix(in srgb, var(--yh-gold) 10%, transparent);
}
.yh-maturity-已爆发 {
  border-color: var(--yh-seal);
  color: var(--yh-seal);
  background: color-mix(in srgb, var(--yh-seal) 12%, transparent);
}
.yh-metric-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.yh-metric-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.yh-metric-name {
  font-size: 12px;
  color: var(--yh-ink-dim);
}
.yh-metric-value {
  font-size: 15px;
  font-weight: 700;
  color: var(--yh-ink);
}
.yh-metric-trend {
  font-size: 11px;
  color: var(--yh-ink-faint);
}
.yh-metric-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--yh-ink-faint);
}
.yh-world-hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--yh-ink-faint);
}
.yh-world-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--yh-raise);
  border: 1px solid var(--yh-line-strong);
  border-radius: 9px;
  padding: 10px 12px 12px;
  margin-bottom: 10px;
}
.yh-world-edit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
}
.yh-world-add {
  margin-left: auto;
  padding: 2px 8px;
}
.yh-world-card-actions {
  display: flex;
  gap: 2px;
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.yh-world-card:hover .yh-world-card-actions {
  opacity: 1;
}
.yh-world-act {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--yh-ink-faint);
  cursor: pointer;
  transition:
    color 0.12s ease,
    background 0.12s ease;
  &:hover {
    color: var(--yh-ink);
    background: var(--yh-hover);
  }
}
.yh-metric-top .yh-metric-value {
  margin-left: auto;
}
.yh-metric-top .yh-world-card-actions {
  margin-left: 4px;
}
@media (hover: none) {
  .yh-world-card-actions {
    opacity: 0.85;
  }
  .yh-world-act {
    width: 28px;
    height: 28px;
  }
}
</style>
