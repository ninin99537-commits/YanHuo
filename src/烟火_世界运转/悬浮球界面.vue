<script setup lang="ts">
import {
  PhCaretDown,
  PhCaretLeft,
  PhCheck,
  PhCopySimple,
  PhEye,
  PhEyeSlash,
  PhGear,
  PhGraph,
  PhLightning,
  PhMapPin,
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
import { computed, nextTick, ref, watch } from 'vue';
import { chatCompletion, fetchModelList } from './api';
import { 版本标签 } from './版本';   // 2026-11-13: :446 用了它但从来没 import（悬空引用）
import { syncWorldbookEntry } from './inject';
import { buildInjectionPrompt } from './prompts';
import type { WorldData, WorldEvent } from './schema';
import { 传讯速度表, type 传讯速度 } from './schema';
import { 设传讯速度 } from './保存世界状态';
import { 取节奏 } from './节奏';
import { 解析日期 } from './时间校验';
import { 取近期日程, 取数据变化, 构建公开摘要, 相对日 } from './公开摘要';
import { getSettings, useSettingsStore } from './settings';
import { UI_KEY, useConsoleStore, useDebugStore, useStateStore, useUpdatingStore } from './state';
import { useHost } from './host';
import { setToastAnchor, setToastColors, setToastSuppressed, toastError, toastInfo, toastSuccess, toastWarning } from './toast';
import { updateWorld } from './update';
import { 有世界数据 } from './世界数据';
import { 事件枚举, 取层, 表单定义 } from './世界字段表';
import type { 任意编辑会话, 事件编辑会话, 组织编辑会话, 条目编辑会话, 概述编辑会话 } from './世界编辑会话';
import { 取消会话, 打开事件会话, 打开组织会话, 打开概述会话, 打开条目会话, 提交会话 } from './世界编辑会话';
import type { 世界条目层 } from './世界数据变更';
import { 建世界数据环境, 清空世界, 移除事件, 移除组织, 移除世界条目 } from './世界数据变更';
// 面板里与渲染无关的规则(筛事件 / 两段日志文本)收在 面板动作.ts, 视图只做绑定
import { 筛事件, 构建推进记录, 构建报错报告 } from './面板动作';
// 列表类设置的文本 → 名单: 三家统一按换行切(逗号/顿号不再当分隔符)
import { 解析名单 } from '../共用/世界书排除';
import { 层序, 取弹窗配色, 取根变量, 悬浮球直径 } from './主题';
import { 使用面板机制 } from '../共用/面板机制';
import { 使用推进弹条 } from './推进弹条';

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
// 面板机制(位置偏好 / 主题 / iframe 尺寸 / 拖动 / 阴影)全在 ../共用/面板机制.ts, 推进中弹条在 推进弹条.ts;
// 配色与球直径 / 层序 token 全在 主题.ts —— 这里只把它们接到模板上
// ---------------------------------------------------------------------------

// 窗口机制是共用的(几何/拖动/阴影/偏好), 这里只交"烟火长什么样"+ 存储接缝
const 面板 = 使用面板机制({
  面板类名: 'yh-panel',
  阴影变量: '--yh-shadow',
  球直径: 悬浮球直径,
  阴影层序: 层序.面板阴影,
  // v2.9.7「简报」: 窄而高(以前 880×620 横排两栏), 一页从上读到下
  面板宽: 400,
  面板高: 660,
  提示条: { 取配色: 取弹窗配色, 设配色: setToastColors, 设锚点: setToastAnchor, 设抑制: setToastSuppressed },
  存储: {
    读全局: () => useHost().vars.get({ type: 'global' })?.[UI_KEY],
    写全局: 值 => useHost().vars.insertOrAssign({ [UI_KEY]: 值 }, { type: 'global' }),
    读本地: () => localStorage.getItem('烟火_界面'),
    写本地: 文本 => localStorage.setItem('烟火_界面', 文本),
  },
});

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
} = 面板;
// 供模板 ref="rootEl/panelRef/headerEl" 绑定，实际读写在 使用面板机制 内部完成
void rootEl;
void panelRef;
void headerEl;

// 推进中弹条是烟火独有的下游(建立在 贴球锚点 之上), 不属于共用的窗口机制
使用推进弹条(
  { 推进中: updatingActive, 推进文案: updatingMessage, 中断推进: () => updatingStore.cancel() },
  面板,
);

/** 面板的全部 CSS 变量(配色 / 球直径 / 层序)只在 主题.ts 里写一次, 这里绑到根元素上:
 *  这是"TS 的值 → CSS 的变量"之间唯一的那一个映射点(样式表里一律 var(...) 引用) */
const 根样式 = computed(() => 取根变量(theme.value));

/** 日志 / 设置是两张子页(右上角两个图标); 为 null 时是简报——此刻/动态/组织/世界在同一页里从上往下排 */
const 子页 = ref<'logs' | 'settings' | null>(null);
const scrollEl = ref<HTMLElement | null>(null);
type 分区键 = 'now' | 'chronicle' | 'factions' | 'world';
/** 跳到简报里的某一段(顶上那排按钮、"关联事件"之类的链接都走这里)。
 *  只滚面板自己的滚动区: scrollIntoView 在某些浏览器里会连带滚动酒馆页面, 不用它。 */
function 跳到(键: 分区键) {
  子页.value = null;
  nextTick(() => {
    const 盒 = scrollEl.value;
    const 段 = 盒?.querySelector<HTMLElement>(`[data-sec="${键}"]`);
    if (盒 && 段) 盒.scrollTo({ top: Math.max(0, 段.offsetTop - 6), behavior: 'smooth' });
  });
}
function 开子页(页: 'logs' | 'settings') {
  子页.value = 子页.value === 页 ? null : 页;
  nextTick(() => scrollEl.value?.scrollTo({ top: 0 }));
}

// ---------------------------------------------------------------------------
// 世界数据视图
// ---------------------------------------------------------------------------

const world = computed<WorldData>(() => data.value);
// 「这个世界有没有数据」问同一处(有世界数据): 别处再写一遍, 迟早两处口径不一致
const hasWorld = computed(() => 有世界数据(world.value));
// 活跃事件: `事件` 里本来就没有墓碑(v2.5 起已结束独立成桶), 所以件数就是长度(球上那个角标)
const 进行中件数 = computed(() => world.value.事件.length);
/** 抬头的时间: 末尾是"时:分"就把它放大、前面的日期放小字; 否则整串放大(古代历法之类) */
const 时间显示 = computed(() => {
  const 原 = String(world.value.世界.时间 || '').trim();
  const 拆 = /^(.*?)[\s·T]*(\d{1,2}:\d{2})$/.exec(原);
  return 拆 && 拆[1] ? { 大: 拆[2], 小: 拆[1].trim() } : { 大: 原 || '未知', 小: '' };
});
const factionEntries = computed(() => Object.entries(world.value.组织));
const regionEntries = computed(() => Object.entries(world.value.地区 ?? {}));
const trendEntries = computed(() => Object.entries(world.value.形势 ?? {}));
const seedList = computed(() => world.value.暗线 ?? []);
const occasionList = computed(() => world.value.日程 ?? []);
const metricEntries = computed(() => Object.entries(world.value.指标 ?? {}));
const 主角所在 = computed(() => String(world.value.世界.主角所在 ?? '').trim());
/** 所在地: 主角所在正好是某个地区名才有(和注入里的【所在地】同一口径) */
const 所在地 = computed(() => {
  const 地区 = 主角所在.value ? world.value.地区?.[主角所在.value] : undefined;
  return 地区 && (地区.局势 || 地区.主事方 || 地区.外部关系 || 地区.概况) ? { 名: 主角所在.value, 地区 } : null;
});
/** 近期日程 / 数据变化: 与注入共用同一份挑选规则(公开摘要.ts), 面板上看到的就是主 AI 拿到的那几条 */
const 近期日程 = computed(() => 取近期日程(world.value, settings.value, 解析日期(world.value.世界.时间)?.天, 主角所在.value));
const 数据变化 = computed(() => 取数据变化(world.value, settings.value, 主角所在.value));
const 分区 = computed<{ 键: 分区键; 名: string; 数: number | null }[]>(() => [
  { 键: 'now', 名: '概况', 数: null },
  { 键: 'chronicle', 名: '动态', 数: world.value.事件.length + (world.value.已结束?.length ?? 0) },
  { 键: 'factions', 名: '组织', 数: factionEntries.value.length },
  { 键: 'world', 名: '档案', 数: null },
]);

// ---- 世界页手动编辑: 五层共用一套「名称+字段」增删改 ----
// 改数据一律走 世界数据变更.ts 那道门(它负责上限/同名/id 签发/落快照/同步世界书);
// "正在编辑什么"由 世界编辑会话.ts 收着(候选 5): 打开/比较基准/冲突判定/提交/取消 全在那边,
// 这里只消费它——以前五层条目/世界概述/事件/组织各写一份镜像草稿, 每份都自己"打开时拷进去、
// 保存时拷出来", 三处手动同步, 还漏掉了"打开时那一条还在不在"的判断。
// 字段清单(名字/标签/枚举/多行)只在 世界字段表.ts 一处(候选 4): 这里按层取, 不再手抄字段名。
type WorldLayer = 世界条目层;
const layerFields: Record<WorldLayer, { key: string; label: string; enum?: readonly string[]; multiline?: boolean }[]> = {
  地区: 表单定义(取层('地区')),
  形势: 表单定义(取层('形势')),
  暗线: 表单定义(取层('暗线')),
  日程: 表单定义(取层('日程')),
  指标: 表单定义(取层('指标')),
};
/** 唯一的编辑会话: 五层条目 / 事件 / 组织 / 世界概述 四类编辑共用这一个 */
const 会话 = ref<任意编辑会话 | null>(null);
/** 四个按种类收窄的视图: 只是让模板拿到自己那一份, 草稿仍然只有会话里那一个对象。
 *  事件的这一个仍叫 editingEvent(模板与面板用例里的调用点都是这个名字): 它现在指向"在编的那条事件的会话",
 *  认哪一条看的是会话里的 基准(打开时的原值), 不再是对象引用。 */
const 条目会话 = computed<条目编辑会话 | null>(() => (会话.value?.目标.种类 === '条目' ? (会话.value as 条目编辑会话) : null));
const editingEvent = computed<事件编辑会话 | null>(() => (会话.value?.目标.种类 === '事件' ? (会话.value as 事件编辑会话) : null));
const 组织会话 = computed<组织编辑会话 | null>(() => (会话.value?.目标.种类 === '组织' ? (会话.value as 组织编辑会话) : null));
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
  
  取消编辑();
  toastSuccess(结果.说明, '烟火');
}
function removeWorldItem(layer: WorldLayer, key: string) {
  const 结果 = 移除世界条目(data.value, layer, key, 建世界数据环境());
  if (结果.拒绝) {
    toastWarning(结果.拒绝, '烟火');
    return;
  }
  
  // 删掉的正好是编辑框里那一条 → 编辑框跟着收起来
  if (条目会话.value && 条目会话.value.草稿.layer === layer && 条目会话.value.草稿.key === key) 取消编辑();
  toastInfo(结果.说明, '烟火');
}

const stageFilter = ref<'全部' | '未结束' | '已结束'>('全部');
const scaleFilter = ref<'全部' | '一般' | '重大'>('全部');
/** 事件表单的下拉与筛选的枚举只有 世界字段表.ts 一处来源(以前模板里手抄了六组字面量) */
const 规模选项 = 事件枚举.规模;
const 传播选项 = 事件枚举.传播;
const 阶段选项 = 事件枚举.阶段;
const 公开性选项 = 事件枚举.公开性;
// 元素类型跟筛选变量走: 以前写成 readonly string[], 模板里 `stageFilter = option` / `scaleFilter = option`
// 把 string 赋给三值联合, vue-tsc 报 TS2322(运行时值本来就对, 纯类型错)。
// 现在数组里写错一个值(比如 '进行')会在这里直接报出来。
const 阶段筛选项: readonly (typeof stageFilter.value)[] = ['全部', '未结束', '已结束'];
const 规模筛选项: readonly (typeof scaleFilter.value)[] = ['全部', ...事件枚举.规模];
// 两个桶 + 两道筛选的规则在 面板动作.ts(可单测); 「全部」时活跃的排在墓碑上面
const chronicleEvents = computed(() => 筛事件(world.value.事件, world.value.已结束 ?? [], stageFilter.value, scaleFilter.value));
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
// 手动编辑 — 所有编辑都经 世界数据变更.ts: 它落快照 + 同步世界书注入 + 返回新数据
// ---------------------------------------------------------------------------

/** 切换「启用世界运转」/「注入世界动向到主AI」/「写入世界书」/「传播时滞」时立即生效 */
watch(
  () => [settings.value.启用运转, settings.value.运转.注入世界书条目, settings.value.运转.世界书写入目标, settings.value.运转.传播时滞],
  ([启用运转, 注入]) => {
    syncWorldbookEntry(stateStore.data, !!(启用运转 && 注入), settings.value).catch(error => {
      console.error('[烟火] 切换注入开关后同步世界书条目失败:', error);
    });
  },
);

/** 本聊天的传讯速度(v2.9.2): 存在聊天变量里(不是全局设置), 改完重读数据并刷新世界书条目 */
const 传讯速度说明: Record<传讯速度, string> = {
  未选: '未选——远方消息不按时差过滤',
  古代: '古代——传遍全域约 7 日、邻近地区约 4 日',
  近代: '近代——传遍全域约 2 日、邻近地区约 1 日',
  现代: '现代——传得到就立刻知道（本地小事仍传不出当地）',
};
const 当前传讯速度 = computed<传讯速度>(() => world.value.传讯速度 ?? '未选');
/** 此刻页的节奏一行(v2.9.5): 只给人看, 与请求里那句【节奏事实】同源(取节奏) */
const 节奏行 = computed(() => {
  if (!world.value.世界.时间) return '';
  const { 上次重大事件时间, 上次新增时间 } = 取节奏(world.value);
  return `上次重大事件 ${上次重大事件时间 || '—'} · 上次新增 ${上次新增时间 || '—'}`;
});
function 改传讯速度(event: Event) {
  const 值 = (event.target as HTMLSelectElement).value as 传讯速度;
  if (!设传讯速度(值)) {
    toastError('传讯速度未能保存（聊天尚未就绪？）', '烟火');
    return;
  }
  stateStore.reload();
  syncWorldbookEntry(stateStore.data, settings.value.启用运转 && settings.value.运转.注入世界书条目, settings.value).catch(error => {
    console.error('[烟火] 改传讯速度后同步世界书条目失败:', error);
  });
  toastSuccess(`本聊天的传讯速度：${值}`);
}

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
  
  取消编辑();
  toastSuccess(结果.说明);
}
function removeEvent(event: WorldEvent) {
  const 结果 = 移除事件(data.value, event.id, 建世界数据环境());
  if (结果.拒绝) {
    toastWarning(结果.拒绝, '烟火');
    return;
  }
  
  toastInfo(结果.说明, '烟火');
}
function removeFaction(name: string) {
  const 结果 = 移除组织(data.value, name, 建世界数据环境());
  if (结果.拒绝) {
    toastWarning(结果.拒绝, '烟火');
    return;
  }
  
  toastInfo(结果.说明, '烟火');
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
  
  取消编辑();
  toastSuccess(结果.说明);
}

/** 组织编辑(在脉络详情页) */
/** 选中组织关联的进行中/最近事件(从事件的组织字段派生, 不让 AI 写) */
const factionRelatedEvents = computed(() =>
  world.value.事件
    .filter(event => event.组织 === selectedFaction.value)
    .slice(-6)
    .reverse(),
);
function startEditFaction() {
  // 名字不在清单里(那一行刚被推进换掉)就不打开, 与以前"没有可编辑的组织就不进编辑态"一致
  const 新会话 = 打开组织会话(data.value, selectedFaction.value);
  if (新会话) 会话.value = 新会话;
}
function saveFactionEdit() {
  const 结果 = 提交会话(组织会话.value, data.value, 建世界数据环境());
  if (!结果) return;
  if (结果.拒绝) {
    toastWarning(结果.拒绝, '烟火');
    return;
  }
  
  取消编辑();
  toastSuccess(结果.说明);
}
watch(selectedFaction, () => {
  // 换组织只关正在编辑的组织, 别的编辑(条目/事件/概述)不受影响
  if (会话.value?.目标.种类 === '组织') 取消编辑();
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

/** 列表设置(排除条目/标签)的文本双向绑定: **一行一条**(逗号/顿号/空格都算内容, 不再当分隔符) */
function listText(key: '世界书排除' | '标签列表') {
  if (key === '世界书排除') {
    return computed({
      get: () => (settings.value.运转.世界书排除 ?? []).join('\n'),
      set: (text: string) => {
        settings.value.运转.世界书排除 = 解析名单(text);
      },
    });
  }
  return computed({
    get: () => (settings.value.标签.列表 ?? []).join('\n'),
    set: (text: string) => {
      settings.value.标签.列表 = 解析名单(text)
        .map(item => item.replace(/^<|>$/g, ''))
        .filter(Boolean);
    },
  });
}
const worldbookExcludeText = listText('世界书排除');
const tagListText = listText('标签列表');

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

const joinRecord = () => 构建推进记录(debugLog.value, fmtTimestamp);
const buildErrorReport = () => 构建报错报告(debugLog.value, getSettings().接口.模型 || '(未选)', 版本标签(), fmtTimestamp);
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
const 在途事件们 = computed(() => 构建公开摘要(world.value, settings.value).在途);
function showInjection() {
  injectionPreview.value = buildInjectionPrompt(world.value, getSettings());
}
const collapsed = ref<Record<string, boolean>>({});
function toggleCollapse(key: string) {
  collapsed.value[key] = !collapsed.value[key];
}

/** 动态页事件「演变」时间线的展开状态(键=事件 id, 无 id 时退回标题——id 稳定, 改名/重排不丢展开状态) */
const trailOpen = ref<Record<string, boolean>>({});
function toggleTrail(key: string) {
  trailOpen.value[key] = !trailOpen.value[key];
}

// (挂载/卸载的接线随面板机制一起搬到了 ../共用/面板机制.ts: 恢复偏好 → 定默认锚点 → 挂阴影层 → 应用 iframe 尺寸)

</script>

<template>
  <div ref="rootEl" class="yh-root" :data-theme="theme" :style="根样式">
    <!-- 悬浮球: 40px 圆, 一簇灯火。推进中: 边线内转一段弧; 右上角: 进行中的事件件数(都画在圆里面——
         面板关着时 iframe 只有一个球那么大, 圆外的会被裁掉) -->
    <button
      class="yh-orb"
      :class="{ 'is-dragging': isDragging, 'is-updating': updatingActive, 'is-open': panelOpen }"
      :style="orbStyle"
      title="烟火 · 世界运转"
      @pointerdown="onOrbPointerDown"
      @click="onOrbClick"
    >
      <svg class="yh-orb-mark" viewBox="0 0 24 24" aria-hidden="true">
        <path
          class="yh-flame"
          d="M12 2.8c.6 3 3.9 4.9 4.9 8.4 1 3.7-1.5 8-4.9 8s-5.9-2.8-5.4-6.3c.3-2 1.6-3.2 2.4-4.6.3 1.3.9 2.1 1.8 2.5-.5-3 .1-5.6 1.2-8Z"
        />
      </svg>
      <!-- ⚠ 2026-11-23（需求方 #894）：**不再显示件数，只做一个圆点。**
           件数本身没丢 —— 面板顶部导航本来就有「动态 N」。
           球上只需要"有/没有"这个二值信号。
           title / aria-label 把件数留给鼠标悬停与读屏（信息不丢，只是不画在球上）。 -->
      <span
        v-if="进行中件数 > 0 && !updatingActive"
        class="yh-orb-count"
        :title="`有 ${进行中件数} 条进行中的世界事件`"
        aria-label="有进行中的世界事件"
      ></span>
    </button>

    <!-- 面板: 窄而高的浮动简报, 一页从上读到下(概况 → 所在地 → 近期日程 → 数据变化 → 动态 → 组织 → 档案);
         日志与设置收进右上角两个图标。iframe 只罩住面板+球, 其余区域酒馆照常可点; 点外部不关闭 -->
    <section
      v-if="panelOpen"
      ref="panelRef"
      class="yh-panel"
      :class="{ 'is-dragging': isPanelDragging, 'is-updating': updatingActive }"
      :style="panelStyleRef"
      role="dialog"
      aria-label="烟火 · 世界运转"
    >
      <header ref="headerEl" class="yh-header" @pointerdown="onPanelPointerDown">
        <div class="yh-bar">
          <span class="yh-brand-name">烟火</span>
          <span v-if="updatingActive" class="yh-status is-running">
            <i class="yh-status-dot" aria-hidden="true"></i>
            {{ updatingMessage || '正在推进' }}
          </span>
          <span v-else class="yh-status" :class="{ 'is-on': settings.启用运转 && settings.运转.自动更新 }">
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
          <span class="yh-spacer"></span>
          <button class="yh-icon-btn" :class="{ 'is-on': 子页 === 'logs' }" title="日志" @click="开子页('logs')">
            <PhScroll :size="16" weight="regular" />
          </button>
          <button class="yh-icon-btn" :class="{ 'is-on': 子页 === 'settings' }" title="设置" @click="开子页('settings')">
            <PhGear :size="16" weight="regular" />
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
        <div class="yh-hero">
          <strong class="yh-time-value" :class="{ 'is-long': 时间显示.大.length > 7 }">{{ 时间显示.大 }}</strong>
          <span v-if="时间显示.小" class="yh-time-sub">{{ 时间显示.小 }}</span>
          <p v-if="world.世界.主角所在" class="yh-where">
            <PhMapPin :size="13" weight="bold" />主角所在 · {{ world.世界.主角所在 }}
          </p>
        </div>
        <div class="yh-progress" aria-hidden="true"><i></i></div>
      </header>

      <nav class="yh-jump">
        <button v-if="子页" class="yh-jump-back" @click="子页 = null">
          <PhCaretLeft :size="13" weight="bold" />{{ 子页 === 'logs' ? '日志' : '设置' }}
        </button>
        <template v-else>
          <button v-for="分 in 分区" :key="分.键" class="yh-jump-item" @click="跳到(分.键)">
            {{ 分.名 }}<span v-if="分.数" class="yh-jump-n">{{ 分.数 }}</span>
          </button>
        </template>
      </nav>

      <div ref="scrollEl" class="yh-body">
          <!-- ============ 日志 ============ -->
          <div v-if="子页 === 'logs'" class="yh-page yh-page-logs">
            <div class="yh-log-left">
              <div v-if="debugLog" class="yh-log-record">
                <p class="yh-log-meta">
                  {{ fmtTimestamp(debugLog.time) }} · {{ debugLog.model || '(未选模型)' }} · 楼层
                  {{ debugLog.replyIds.length > 0 ? debugLog.replyIds.map(id => `#${id}`).join(', ') : '—' }}
                  <template v-if="debugLog.版本"> · {{ debugLog.版本 }}</template>
                </p>
                <p v-if="debugLog.summary" class="yh-log-summary">{{ debugLog.summary }}</p>
                <p v-for="(条, i) in debugLog.备注 || []" :key="i" class="yh-log-meta">· {{ 条 }}</p>
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
                <!-- 每次尝试各留一份(v2.8.5 D1): 出过重试时, 失败那次的完整原文就在这里, 线上失败可回放 -->
                <div v-if="debugLog.尝试 && debugLog.尝试.length > 1" class="yh-log-section">
                  <button class="yh-collapse" @click="toggleCollapse('尝试')">
                    <PhCaretDown :size="12" :class="{ 'is-flipped': collapsed['尝试'] }" />
                    每次尝试（{{ debugLog.尝试.length }} 次，失败 {{ debugLog.尝试.filter(项 => 项.错误).length }} 次）
                  </button>
                  <div v-if="!collapsed['尝试']">
                    <div v-for="项 in debugLog.尝试" :key="项.次" class="yh-log-attempt">
                      <p class="yh-log-meta">
                        第 {{ 项.次 }} 次 · {{ 项.错误 ? '失败：' + 项.错误 : '通过' }}
                      </p>
                      <pre class="yh-pre" :class="{ 'yh-pre-error': !!项.错误 }">{{ 项.原文 || '（这次没拿到输出）' }}</pre>
                    </div>
                  </div>
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
              <template v-if="在途事件们.length > 0">
                <h3 class="yh-col-title">传播时滞 · 暂未到达本地（{{ 在途事件们.length }} 件）</h3>
                <ul class="yh-rows yh-transit-list">
                  <li v-for="项 in 在途事件们" :key="`${项.标题}-${项.地点}`">
                    <span class="yh-rows-k">{{ 项.原因 === '在途' && 项.预计剩余天数 != null ? `约 ${项.预计剩余天数} 天后到` : '传不到本地' }}</span>
                    <span class="yh-rows-v"><strong>{{ 项.标题 }}</strong>{{ 项.地点 }} · {{ 项.传播 }}</span>
                  </li>
                </ul>
              </template>
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
          <div v-else-if="子页 === 'settings'" class="yh-page yh-page-settings">
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
                <h3 class="yh-col-title">请求与重试</h3>
                <div class="yh-toggles">
                  <label class="yh-toggle">
                    <input v-model="settings.运转.预填充" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">预填充<em>引导模型直接输出 JSON，减少格式失败</em></span>
                  </label>
                </div>
                <label class="yh-field">
                  <span class="yh-field-label">失败重试次数</span>
                  <input
                    v-model.number="settings.运转.重试次数"
                    type="number"
                    min="0"
                    max="10"
                    class="yh-input"
                  />
                  <span class="yh-field-hint"
                    >接口报错或输出格式不合格时自动重试的次数（0 = 不重试，默认 2 次）</span
                  >
                </label>
                <label class="yh-field">
                  <span class="yh-field-label">自定义提示词 / 补充规则（可选）</span>
                  <textarea
                    v-model="settings.运转.自定义提示词"
                    class="yh-input yh-textarea"
                    rows="3"
                    placeholder="留空则使用默认规则；可补充本世界观的特殊法则、禁忌或推进偏好"
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
                    <input v-model="settings.运转.世界形势" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">世界形势<em>大趋势（战云/商路/教派/新政等）；关掉后保留旧档案但不再维护</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.世界日程" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text">日程<em>按世界观生成节日、开市、检阅等周期节点</em></span>
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.世界指标" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >世界指标<em>少量慢变数值（丰歉/物价/能源/民心等，按世界观取名）</em></span
                    >
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.到期掷骰" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >到期掷骰<em>事件到了下次判定时间，由脚本掷出推进/僵持/受挫，世界引擎按结果写这一步</em></span
                    >
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.联动彼方" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >联动彼方幕后人物<em
                        >只读彼方人物的身份、目标与暗中打算（不含恋爱/生理/起居），供烟火联动推演暗线、组织动向或保密事件；无数据时自动跳过</em
                      ></span
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
                <!-- ⚠ 2026-11-23（需求方 #885）：这两项原来**各自**包在一个只有一个孩子的
                     `.yh-field-pair` 里。而 `.yh-field-pair` 是**两列网格**：
                       grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
                     ⇒ 第一列填上、第二列空着 = **右边空半行**（用户看着别扭）。
                     合成一个 pair，两个字段并排。**只动结构，不动文案、不动控件、不动 v-model。** -->
                <div class="yh-field-pair">
                  <label class="yh-field">
                    <span class="yh-field-label">运转密度</span>
                    <select v-model="settings.运转.世界密度" class="yh-input yh-select">
                      <option value="稀疏">稀疏——允许长时间没有新事件</option>
                      <option value="正常">正常——每轮主动找，找不到才静止</option>
                      <option value="密集">密集——每轮尽量都有产出</option>
                    </select>
                    <span class="yh-field-hint"
                      >稀疏=允许长时间没有新事件；正常=每轮主动找，找不到才静止；密集=每轮尽量都有产出。只调配额，不改事件合格线。</span
                    >
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">快照保留份数</span>
                    <input
                      v-model.number="settings.运转.快照保留份数"
                      type="number"
                      min="1"
                      max="100"
                      class="yh-input"
                    />
                    <span class="yh-field-hint"
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
                      >注入世界动向到主AI<em>写入世界书常驻条目「【烟火】世界动向」，切聊天自动重写</em></span
                    >
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.注入保密事件" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >保密事件<em
                        >默认关闭——保密事件只进面板，供烟火推演；开启后标注"主角绝不可能知道"注入</em
                      ></span
                    >
                  </label>
                  <label class="yh-toggle">
                    <input v-model="settings.运转.传播时滞" type="checkbox" />
                    <span class="yh-toggle-track"></span>
                    <span class="yh-toggle-text"
                      >传播时滞<em>远方的消息按传讯速度晚几日才传到主角所在地；在首页「传讯速度」按聊天单独选择后生效</em></span
                    >
                  </label>
                </div>
                <label class="yh-field">
                  <span class="yh-field-label">写入世界书</span>
                  <select v-model="settings.运转.世界书写入目标" class="yh-input yh-select">
                    <option value="角色卡主世界书">角色卡主世界书（单聊默认）</option>
                    <option value="聊天世界书">聊天世界书（群聊必选，每场聊天独立一本）</option>
                  </select>
                </label>
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
                  <span class="yh-field-label">世界书排除条目（每行一条）</span>
                  <textarea
                    v-model="worldbookExcludeText"
                    class="yh-input yh-textarea"
                    rows="3"
                    placeholder="标题里含这些字就排除，如&#10;[mvu_update]"
                  ></textarea>
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
                    <span class="yh-field-label">标签列表（每行一条）</span>
                    <textarea v-model="tagListText" class="yh-input yh-textarea" rows="3" placeholder="如&#10;thinking&#10;aftertalk"></textarea>
                  </label>
                </div>
              </div>
            </div>
            <p class="yh-about">
              {{ settings.接口.模型 || '未配置接口' }} · 快照
              {{ world.锚点楼层 >= 0 ? `#${world.锚点楼层}` : '无' }} · {{ 版本标签() }}
            </p>
          </div>

          <!-- ============ 简报 ============ -->
          <div v-else class="yh-page yh-brief">
          <!-- ============ 此刻 ============ -->
          <section class="yh-sec" data-sec="now">
            <p v-if="world.世界.氛围" class="yh-now-mood">{{ world.世界.氛围 }}</p>
            <p v-if="world.世界.总览" class="yh-now-trend">{{ world.世界.总览 }}</p>
            <p v-if="节奏行" class="yh-now-pace">{{ 节奏行 }}</p>
            <p v-if="!hasWorld" class="yh-now-empty">
              世界尚无档案——生成一条 AI 回复后自动建立；或在设置里配好接口后点下方「推进」。
            </p>
            <div class="yh-now-actions">
              <button class="yh-btn yh-btn-primary" :disabled="updatingActive" @click="tickNow">
                <PhLightning :size="13" weight="fill" />
                推进
              </button>
              <button class="yh-btn" @click="settings.运转.自动更新 = !settings.运转.自动更新">
                <PhPause v-if="settings.运转.自动更新" :size="13" weight="regular" />
                <PhPlay v-else :size="13" weight="regular" />
                {{ settings.运转.自动更新 ? '暂停自动' : '恢复自动' }}
              </button>
              <button class="yh-btn" @click="概述会话 ? saveEdit() : openEdit()">
                <PhCheck v-if="概述会话" :size="13" weight="regular" />
                {{ 概述会话 ? '保存' : '编辑' }}
              </button>
              <button class="yh-btn yh-btn-danger" :class="{ 'is-confirm': confirmClear }" @click="clearWorld">
                <PhTrash :size="13" weight="regular" />
                {{ confirmClear ? '再点一次确认' : '清空' }}
              </button>
            </div>
            <div v-if="概述会话" class="yh-edit-grid">
              <label class="yh-field">
                <span class="yh-field-label">当前时间</span>
                <input v-model="概述会话.草稿.时间" type="text" class="yh-input" placeholder="如 0137-06-12 07:45" />
              </label>
              <label class="yh-field">
                <span class="yh-field-label">主角所在</span>
                <input
                  v-model="概述会话.草稿.主角所在"
                  type="text"
                  class="yh-input"
                  placeholder="填地区名；留空 = 未知（不判本地、不出【所在地】）"
                />
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
            <div class="yh-chat-speed">
              <span class="yh-chat-speed-label">传讯速度</span>
              <select
                :value="当前传讯速度"
                class="yh-input yh-select yh-chat-speed-select"
                aria-label="传讯速度（本聊天）"
                title="每个聊天单独保存；选定时代后，远方消息按时差传到主角所在地"
                @change="改传讯速度"
              >
                <option v-for="速度 in 传讯速度表" :key="速度" :value="速度">{{ 传讯速度说明[速度] }}</option>
              </select>
            </div>
            <p v-if="!settings.运转.传播时滞" class="yh-chat-speed-hint">设置中「传播时滞」已关闭，当前不会按距离延迟</p>
            <p class="yh-now-meta">
              已推进 {{ world.统计.推进次数 }} 次 · 上次 {{ fmtTimestamp(world.统计.最后推进)
              }}{{ world.小结 ? ` · ${world.小结}` : '' }}
            </p>
          </section>

          <section v-if="所在地" class="yh-sec">
            <h3 class="yh-sec-title">所在地 · {{ 所在地.名 }}</h3>
            <dl class="yh-kv">
              <template v-if="所在地.地区.局势"><dt>局势</dt><dd>{{ 所在地.地区.局势 }}</dd></template>
              <template v-if="所在地.地区.主事方"><dt>主事方</dt><dd>{{ 所在地.地区.主事方 }}</dd></template>
              <template v-if="所在地.地区.外部关系"><dt>外部关系</dt><dd>{{ 所在地.地区.外部关系 }}</dd></template>
              <template v-if="所在地.地区.概况"><dt>概况</dt><dd>{{ 所在地.地区.概况 }}</dd></template>
            </dl>
          </section>

          <section v-if="近期日程.length > 0" class="yh-sec">
            <h3 class="yh-sec-title">近期日程</h3>
            <ul class="yh-rows">
              <li v-for="项 in 近期日程" :key="项.日程.名称">
                <span class="yh-rows-k">{{ 相对日(项.差) }}</span>
                <span class="yh-rows-v"
                  ><strong>{{ 项.日程.名称 }}</strong>{{ 项.日程.概况 }}</span
                >
              </li>
            </ul>
          </section>

          <section v-if="数据变化.length > 0" class="yh-sec">
            <h3 class="yh-sec-title">数据变化</h3>
            <ul class="yh-rows">
              <li v-for="[名, 指标] in 数据变化" :key="名">
                <span class="yh-rows-k">{{ 名 }}</span>
                <span class="yh-rows-v"
                  ><strong class="yh-arrow">{{ trendArrow(指标.趋势) }} {{ 指标.趋势 }}</strong
                  >{{ [指标.值, 指标.说明].filter(Boolean).join(' · ') }}</span
                >
              </li>
            </ul>
          </section>

<!-- ============ 动态 ============ -->
          <section class="yh-sec" data-sec="chronicle">
            <h3 class="yh-sec-title">动态<span>{{ chronicleEvents.length }} 件</span></h3>
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
                      <input v-model="editingEvent!.草稿.背景" class="yh-input" placeholder="背景（来龙去脉总结）" />
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
                        <input v-model="editingEvent!.草稿.组织" class="yh-input" placeholder="关联组织" />
                      </div>
                      <div class="yh-edit-row">
                        <input
                          v-model="editingEvent!.草稿.代表人物"
                          class="yh-input"
                          placeholder="代表人物（头衔+名字，如 首席信息官·林素问）"
                        />
                      </div>
                      <div class="yh-edit-row">
                        <select v-model="editingEvent!.草稿.公开性" class="yh-input yh-select">
                          <option v-for="s in 公开性选项" :key="s" :value="s">{{ s }}</option>
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
                    <div class="yh-feed-meta-top">
                      <span>{{ event.时间 || '时间未知' }}</span>
                      <span v-if="event.地点">{{ event.地点 }}</span>
                      <span v-if="event.传播">{{ event.传播 }}</span>
                      <span v-if="event.渠道">{{ event.渠道 }}</span>
                    </div>
                    <div class="yh-feed-head">
                      <strong class="yh-feed-title">{{ event.标题 }}</strong>
                      <button class="yh-icon-btn yh-feed-edit" title="编辑此事件" @click="startEditEvent(event)">
                        <PhPencilSimple :size="13" weight="regular" />
                      </button>
                      <button class="yh-icon-btn yh-feed-remove" title="移除此事件" @click="removeEvent(event)">
                        <PhX :size="13" weight="bold" />
                      </button>
                    </div>
                    <p class="yh-feed-desc">{{ event.描述 }}</p>
                    <p v-if="event.背景" class="yh-feed-cause">背景 · {{ event.背景 }}</p>
                    <div class="yh-tags">
                      <span v-if="event.规模 === '重大'" class="yh-badge yh-badge-重大">重大</span>
                      <span class="yh-badge" :class="{ 'yh-badge-done': event.阶段 === '已结束' }">{{
                        event.阶段 === '已结束' ? '已结束' : event.阶段
                      }}</span>
                      <span v-if="event.公开性 === '保密'" class="yh-badge yh-badge-secret">保密</span>
                      <span
                        v-if="event.判定"
                        class="yh-badge yh-badge-urgent"
                        :title="`到期 ${event.判定.到期} 掷出的结果，世界引擎还没写这一步；下一轮沿用`"
                        >到期 · {{ event.判定.结果 }}</span
                      >
                      <span v-if="event.组织" class="yh-badge yh-badge-plain">{{ event.组织 }}</span>
                      <span v-if="event.代表人物" class="yh-badge yh-badge-plain">{{ event.代表人物 }}</span>
                    </div>
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
                  </template>
                </div>
              </li>
            </ol>
            <div v-else class="yh-empty">
              <PhWind :size="26" weight="light" />
              <p>{{ stageFilter === '已结束' ? '还没有了结的事' : '无事发生——世界很安静' }}</p>
            </div>
          </section>

<!-- ============ 组织 ============ -->
          <section class="yh-sec" data-sec="factions">
            <h3 class="yh-sec-title">组织<span>{{ factionEntries.length }} 个</span></h3>
            <div v-if="factionEntries.length > 0" class="yh-fac-chips">
              <button
                v-for="[name] in factionEntries"
                :key="name"
                class="yh-chip"
                :class="{ 'is-active': selectedFaction === name }"
                @click="selectedFaction = name"
              >
                {{ name }}
              </button>
            </div>
            <div v-else class="yh-empty yh-empty-slim">
              <PhGraph :size="22" weight="light" />
              <p>尚无组织档案<br />世界推进后自动识别</p>
            </div>
            <div v-if="selectedFactionData" class="yh-detail">
                <div class="yh-detail-head">
                  <h3>{{ selectedFaction }}</h3>
                  <div class="yh-detail-actions">
                    <button v-if="!组织会话" class="yh-icon-btn" title="编辑此组织" @click="startEditFaction()">
                      <PhPencilSimple :size="13" weight="regular" />
                    </button>
                    <button class="yh-icon-btn" title="移除此组织" @click="removeFaction(selectedFaction)">
                      <PhTrash :size="13" weight="regular" />
                    </button>
                  </div>
                </div>
                <dl v-if="!组织会话" class="yh-detail-rows">
                  <div class="yh-detail-row">
                    <dt>目标</dt>
                    <dd>{{ selectedFactionData.目标 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>负责人</dt>
                    <dd>{{ selectedFactionData.负责人 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>动向</dt>
                    <dd>{{ selectedFactionData.动向 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>覆盖范围</dt>
                    <dd>{{ selectedFactionData.覆盖范围 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>外部关系</dt>
                    <dd>{{ selectedFactionData.外部关系 || '—' }}</dd>
                  </div>
                  <div class="yh-detail-row">
                    <dt>关联事件</dt>
                    <dd>
                      <template v-if="factionRelatedEvents.length > 0">
                        <span
                          v-for="event in factionRelatedEvents"
                          :key="event.id || event.标题"
                          class="yh-mini-title yh-related-event"
                          @click="跳到('chronicle')"
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
                    <textarea v-model="组织会话!.草稿.目标" class="yh-input yh-textarea" rows="2"></textarea>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">动向</span>
                    <textarea v-model="组织会话!.草稿.动向" class="yh-input yh-textarea" rows="2"></textarea>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">背景（来龙去脉滚动总结）</span>
                    <textarea v-model="组织会话!.草稿.背景" class="yh-input yh-textarea" rows="3"></textarea>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">覆盖范围（地盘与影响：地区/行业/阶层/渠道）</span>
                    <input
                      v-model="组织会话!.草稿.覆盖范围"
                      type="text"
                      class="yh-input"
                      placeholder="如 北境三城；垄断盐铁 / 好莱坞六大制片厂主导；无明确地盘"
                    />
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">外部关系（与其他组织的关系，每方一条）</span>
                    <textarea
                      v-model="组织会话!.草稿.外部关系"
                      class="yh-input yh-textarea"
                      rows="2"
                      placeholder="如 与X商团盟约渐固；与Y帮派摩擦升级"
                    ></textarea>
                  </label>
                  <label class="yh-field">
                    <span class="yh-field-label">负责人（首领/掌门/对外代言人，头衔+名字）</span>
                    <input v-model="组织会话!.草稿.负责人" type="text" class="yh-input" placeholder="如 家主·林远山" />
                  </label>
                  <div class="yh-edit-actions">
                    <button class="yh-btn yh-btn-primary yh-btn-sm" @click="saveFactionEdit">
                      <PhCheck :size="12" weight="bold" />保存
                    </button>
                    <button class="yh-btn yh-btn-sm" @click="取消编辑()">取消</button>
                  </div>
                </div>
                <p class="yh-detail-hint">组织动向由世界推进自动维护, 也可在此手动修改(保存后同步注入)。</p>
            </div>
          </section>

<!-- ============ 世界 ============ -->
          <section class="yh-sec" data-sec="world">
            <h3 class="yh-sec-title">档案</h3>
            <p v-if="!hasWorld" class="yh-world-hint">世界尚无档案——推进后自动建立, 也可用各区块的「新增」手动建档</p>
            <div class="yh-world-body">
              <details class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>形势</span>
                  <em>{{ trendEntries.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('形势')">
                    <PhPlus :size="11" weight="bold" />新增
                  </button>
                </summary>
                <world-edit-form
                  v-if="条目会话 && 条目会话.草稿.layer === '形势'"
                  :draft="条目会话.草稿"
                  :defs="layerFields['形势']"
                  @save="saveWorldEdit"
                  @cancel="取消编辑()"
                />
                <ul v-if="trendEntries.length > 0" class="yh-world-list">
                  <li v-for="[name, t] in trendEntries" :key="name" class="yh-world-card">
                    <div class="yh-world-card-head">
                      <strong>{{ name }}</strong>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('形势', name)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('形势', name)">
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
                      <div v-if="t.背景">
                        <dt>背景</dt>
                        <dd>{{ t.背景 }}</dd>
                      </div>
                    </dl>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无形势</p>
              </details>

              <details class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>地区</span>
                  <em>{{ regionEntries.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('地区')">
                    <PhPlus :size="11" weight="bold" />新增
                  </button>
                </summary>
                <world-edit-form
                  v-if="条目会话 && 条目会话.草稿.layer === '地区'"
                  :draft="条目会话.草稿"
                  :defs="layerFields['地区']"
                  @save="saveWorldEdit"
                  @cancel="取消编辑()"
                />
                <ul v-if="regionEntries.length > 0" class="yh-world-list">
                  <li v-for="[name, r] in regionEntries" :key="name" class="yh-world-card">
                    <div class="yh-world-card-head">
                      <strong>{{ name }}</strong>
                      <span v-if="r.主事方" class="yh-world-delta">{{ r.主事方 }}</span>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('地区', name)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('地区', name)">
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
                      <div v-if="r.外部关系">
                        <dt>外部关系</dt>
                        <dd>{{ r.外部关系 }}</dd>
                      </div>
                      <div v-if="r.背景">
                        <dt>背景</dt>
                        <dd>{{ r.背景 }}</dd>
                      </div>
                    </dl>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无地区</p>
              </details>

              <details class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>暗线</span>
                  <em>{{ seedList.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('暗线')">
                    <PhPlus :size="11" weight="bold" />新增
                  </button>
                </summary>
                <world-edit-form
                  v-if="条目会话 && 条目会话.草稿.layer === '暗线'"
                  :draft="条目会话.草稿"
                  :defs="layerFields['暗线']"
                  @save="saveWorldEdit"
                  @cancel="取消编辑()"
                />
                <ul v-if="seedList.length > 0" class="yh-world-list">
                  <li v-for="seed in seedList" :key="seed.标题" class="yh-world-card">
                    <div class="yh-world-card-head">
                      <strong>{{ seed.标题 }}</strong>
                      <span class="yh-badge" :class="'yh-maturity-' + seed.成熟度">{{ seed.成熟度 }}</span>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('暗线', seed.标题)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('暗线', seed.标题)">
                          <PhTrash :size="12" weight="regular" />
                        </button>
                      </div>
                    </div>
                    <p v-if="seed.指向" class="yh-world-main">指向 · {{ seed.指向 }}</p>
                    <dl class="yh-world-fields">
                      <div v-if="seed.线索">
                        <dt>线索</dt>
                        <dd>{{ seed.线索 }}</dd>
                      </div>
                      <div v-if="seed.背景">
                        <dt>背景</dt>
                        <dd>{{ seed.背景 }}</dd>
                      </div>
                    </dl>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无暗线</p>
              </details>

              <details v-if="settings.运转.世界日程" class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>日程</span>
                  <em>{{ occasionList.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('日程')">
                    <PhPlus :size="11" weight="bold" />新增
                  </button>
                </summary>
                <world-edit-form
                  v-if="条目会话 && 条目会话.草稿.layer === '日程'"
                  :draft="条目会话.草稿"
                  :defs="layerFields['日程']"
                  @save="saveWorldEdit"
                  @cancel="取消编辑()"
                />
                <ul v-if="occasionList.length > 0" class="yh-world-list">
                  <li v-for="o in occasionList" :key="o.名称" class="yh-world-card">
                    <div class="yh-world-card-head">
                      <strong>{{ o.名称 }}</strong>
                      <span v-if="o.时间" class="yh-badge">{{ o.时间 }}</span>
                      <span v-if="o.周期" class="yh-world-delta">{{ o.周期 }}</span>
                      <span v-if="o.范围" class="yh-world-delta">{{ o.范围 }}</span>
                      <div class="yh-world-card-actions">
                        <button class="yh-world-act" @click="startWorldEdit('日程', o.名称)">
                          <PhPencilSimple :size="12" weight="regular" />
                        </button>
                        <button class="yh-world-act" @click="removeWorldItem('日程', o.名称)">
                          <PhTrash :size="12" weight="regular" />
                        </button>
                      </div>
                    </div>
                    <p v-if="o.概况" class="yh-world-main">{{ o.概况 }}</p>
                  </li>
                </ul>
                <p v-else class="yh-mini-empty">暂无日程</p>
              </details>

              <details v-if="settings.运转.世界指标" class="yh-world-sec" open>
                <summary>
                  <PhCaretDown class="yh-world-caret" :size="12" weight="bold" />
                  <span>指标</span>
                  <em>{{ metricEntries.length }}</em>
                  <button class="yh-btn yh-btn-sm yh-world-add" @click.stop="startWorldAdd('指标')">
                    <PhPlus :size="11" weight="bold" />新增
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
                      <span v-if="m.范围" class="yh-world-delta">{{ m.范围 }}</span>
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
          </section>
          </div>
      </div>
    </section>
  </div>
</template>

<style lang="scss" src="./面板样式.scss"></style>
