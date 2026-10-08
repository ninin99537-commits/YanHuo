// 烟火 · 面板 token 与机制(候选 9) —— 球直径 / z-index 层序 / 配色各只有一处来源, 机制离开 <script setup>
//
// 起因: 改球直径要动三处(视图里的 const、.yh-orb 的 CSS、外层 iframe 的尺寸), 改一个颜色要动三处
// (样式表一套、同步给贴球弹窗的 JS 又抄一套回退色、更新弹条的内联样式第三套), 漏一处就是"弹窗贴不到球"
// 或"面板换了白天而弹窗还是深色"。约 450 行窗口机制又和六个页签挤在同一个 <script setup> 里, 整块无法执行测试。
// .vue 在 node 里只能当文本读(打包器只有 ?raw, 没有 jsdom), 所以这条用例直接断言源码文本 + 主题 module 的导出。
import vueSource from '../src/烟火_世界运转/悬浮球界面.vue?raw';
import entrySource from '../src/烟火_世界运转/悬浮球界面.ts?raw';
import panelSource from '../src/烟火_世界运转/面板机制.ts?raw';
import themeSource from '../src/烟火_世界运转/主题.ts?raw';
import {
  主题表,
  取根变量,
  取弹窗配色,
  弹窗变量,
  层序,
  深色,
  白天,
  悬浮球直径,
} from '../src/烟火_世界运转/主题';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  PASS  ${label}`);
  }
  else {
    fail++;
    console.log(`  FAIL  ${label}\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`);
  }
}
function ok(label: string, cond: boolean) {
  check(label, !!cond, true);
}

/** 去掉注释, 免得注释里提到的旧常数(例: "以前这里手抄 40")被当成代码 */
function 去注释(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
/** 一段文本里用到的全部主题 CSS 变量(含 var(...) / setProperty('...') / getPropertyValue('...')) */
function 用到的变量(文本: string): Set<string> {
  const 结果 = new Set<string>();
  for (const m of 文本.matchAll(/var\(\s*(--yh-[\w-]+)/g))
    结果.add(m[1]);
  for (const m of 文本.matchAll(/setProperty\(\s*['"](--yh-[\w-]+)['"]/g))
    结果.add(m[1]);
  for (const m of 文本.matchAll(/getPropertyValue\(\s*['"](--yh-[\w-]+)['"]/g))
    结果.add(m[1]);
  return 结果;
}
/** 界面 + 面板机制(去掉注释)里用到的变量 */
function 界面用到的变量(): Set<string> {
  const 结果 = new Set([...用到的变量(vueSource), ...用到的变量(panelSource)]);
  return 结果;
}

console.log('\n[1] 主题 token: 深色 / 白天两套键完全一致, 都有值');
{
  check('键一致', Object.keys(深色).sort(), Object.keys(白天).sort());
  ok('token 数量够用(≥18)', Object.keys(深色).length >= 18);
  ok(
    '没有空值',
    [...Object.values(深色), ...Object.values(白天)].every(v => typeof v === 'string' && v.length > 0),
  );
  check('主题表按模式取', [主题表.dark === 深色, 主题表.light === 白天], [true, true]);
  ok('深色与白天确实是两套色(强调色不同)', 深色.accent !== 白天.accent || 深色.panel !== 白天.panel);
}

console.log('\n[2] 球直径只有一处数字: 三处消费点(CSS 球宽高 / 面板机制 / 外层 iframe)全部引用 token');
{
  const 直径 = Number(/export const 悬浮球直径 = (\d+)/.exec(themeSource)?.[1]);
  ok('主题.ts 里定义了一个正数直径', Number.isFinite(直径) && 直径 > 0);
  check('主题.ts 就是代码里那个常数', 悬浮球直径, 直径);
  check('--yh-orb-size 由 token 生成', 取根变量('dark')['--yh-orb-size'], `${直径}px`);

  ok('面板机制从 token 取直径(不再自己写死)', panelSource.includes('const CLOSED_SIZE = 悬浮球直径'));
  ok('面板机制里没有球直径的数字字面量', !/\bCLOSED_SIZE\s*=\s*\d/.test(去注释(panelSource)));
  ok('面板机制里干脆没有 40 这个数(去注释后)', !/\b40\b/.test(去注释(panelSource)));
  ok('弹条仍按同一个直径贴球(球心 ± 直径/2)', /CLOSED_SIZE \/ 2/.test(panelSource));

  const 球 = /\.yh-orb \{[\s\S]*?width:\s*([^;]+);[\s\S]*?height:\s*([^;]+);/.exec(vueSource);
  check(
    '.yh-orb 的宽高 = --yh-orb-size(CSS 写不出 import, 只能读变量)',
    [球?.[1]?.trim(), 球?.[2]?.trim()],
    ['var(--yh-orb-size)', 'var(--yh-orb-size)'],
  );
  ok('界面里已经不剩球直径的常数', !vueSource.includes('CLOSED_SIZE'));

  ok(
    '外层 iframe 的宽高用 token(曾经手抄 40px 两处)',
    entrySource.includes('${悬浮球直径}px') && !/'40px'/.test(entrySource) && !/'2147483000'/.test(entrySource),
  );
}

console.log('\n[3] z-index 层序只有一处: 界面与入口里没有魔数, 样式表三个层读变量');
{
  ok('界面源码里没有 2147482xxx 魔数', !/2147482\d{3}/.test(vueSource));
  ok('入口源码里没有 2147482xxx 魔数', !/2147482\d{3}/.test(entrySource));
  ok('界面样式里没有数字 z-index', !/z-index:\s*[\d'"]/.test(vueSource));
  ok('面板根读 --yh-z-root', /z-index:\s*var\(--yh-z-root\)/.test(vueSource));
  ok('球读 --yh-z-orb', /z-index:\s*var\(--yh-z-orb\)/.test(vueSource));
  ok('面板读 --yh-z-panel', /z-index:\s*var\(--yh-z-panel\)/.test(vueSource));
  ok(
    '层序表给出了四个高层值',
    [层序.面板阴影, 层序.提示条堆栈, 层序.更新弹条, 层序.球iframe].every(v => v > 2147482000),
  );
  ok(
    '层序是有序的: 阴影 < 弹窗 < 弹条 ≤ 球',
    层序.面板阴影 < 层序.提示条堆栈 && 层序.提示条堆栈 < 层序.更新弹条 && 层序.更新弹条 <= 层序.球iframe,
  );
  ok('面板内的球压在面板上', 层序.球 > 层序.面板);
  ok(
    '酒馆页面上的两个浮层从 token 取',
    panelSource.includes('z-index:${层序.面板阴影}') && panelSource.includes('z-index:${层序.更新弹条}'),
  );
  ok('入口从 token 取 iframe 层序', entrySource.includes('zIndex: String(层序.球iframe)'));
  check('三个 CSS 变量由 token 生成', Object.keys(取根变量('dark')).filter(k => k.startsWith('--yh-z-')).sort(), [
    '--yh-z-orb',
    '--yh-z-panel',
    '--yh-z-root',
  ]);
}

console.log('\n[4] 配色只在 token 文件里: 界面与机制不再手抄色值 / 不再从 DOM 反读');
{
  ok('界面源码里没有 oklch 色值', !vueSource.includes('oklch('));
  ok('面板机制里没有 oklch 色值', !panelSource.includes('oklch('));
  ok('界面里不再从 DOM 反读主题色(getComputedStyle)', !vueSource.includes('getComputedStyle'));
  // 这三处以前各抄一份: 样式表一组 oklch、applyToastTheme 一组 hex 回退、弹条内联样式一组 hex 回退
  const 手抄色 = ['#202024', '#3c3c42', '#e9e8e6', '#e0574a', '#2a1413', '#fbe9e7', '#8c3125', '#ffe3de'];
  check('界面与机制里没有那批手抄色', 手抄色.filter(c => vueSource.includes(c) || panelSource.includes(c)), []);
  ok('弹窗专有的两个底色在主题.ts 里', themeSource.includes('#2a1413') && themeSource.includes('#8c3125'));
  ok(
    '界面把变量绑在根元素上(唯一映射点)',
    vueSource.includes(':style="根样式"') && vueSource.includes('取根变量(theme.value)'),
  );
  ok('界面样式里没有自己声明的 --yh-x: 值', !/--yh-[\w-]+\s*:/.test(去注释(vueSource)));
  ok('用的是主题变量(不是为了通过而没东西可查)', 界面用到的变量().size >= 15);
}

console.log('\n[5] 面板确实引用了这两个 module(机制与 token 都不在 <script setup> 里重写一遍)');
{
  ok('界面引用了面板机制', vueSource.includes("from './面板机制'") && vueSource.includes('使用面板机制('));
  ok('界面引用了主题 token', vueSource.includes("from './主题'"));
  ok('面板机制引用了主题 token', panelSource.includes("from './主题'"));
  ok('外层入口引用了主题 token', entrySource.includes("from './主题'"));
  const 该搬走的 = [
    'function ensurePanelShadow',
    'function syncPanelShadow',
    'function applyFrame',
    'function positionUpdatePill',
    'function ensureUpdatePill',
    'function onOrbPointerDown',
    'function onPanelPointerDown',
    'function readUiPrefs',
    'function persistPrefs',
  ];
  check('这些实现已经不在界面里', 该搬走的.filter(片段 => vueSource.includes(片段)), []);
  check('这些实现确实在面板机制里', 该搬走的.filter(片段 => !panelSource.includes(片段)), []);
  ok('界面里也没有 iframe 尺寸/watch 那些散件', !vueSource.includes('const panelW = ref') && !vueSource.includes('const anchorX = ref'));
}

console.log('\n[6] 模板侧一个名字没改: class / ref / 事件名与搬走前一致');
{
  ok('球的 class 与事件没变', vueSource.includes('class="yh-orb"') && vueSource.includes('@click="onOrbClick"') && vueSource.includes('@pointerdown="onOrbPointerDown"'));
  ok('面板的 class 与 ref 没变', vueSource.includes('class="yh-panel"') && vueSource.includes('ref="panelRef"') && vueSource.includes('ref="headerEl"'));
  ok('根元素 ref 与主题属性没变', vueSource.includes('ref="rootEl"') && vueSource.includes(':data-theme="theme"'));
  ok('拖动面板的入口没变', vueSource.includes('@pointerdown="onPanelPointerDown"'));
  ok('收起面板的入口没变', vueSource.includes('@click="closePanel"'));
  ok('球位置样式仍绑 orbStyle', vueSource.includes(':style="orbStyle"'));
  ok('面板位置样式仍绑 panelStyleRef', vueSource.includes(':style="panelStyleRef"'));
  ok('拖动中的 class 仍绑 isDragging / isPanelDragging', vueSource.includes("'is-dragging': isDragging") && vueSource.includes("'is-dragging': isPanelDragging"));
  const 暴露的名字 = [
    'rootEl',
    'panelRef',
    'headerEl',
    'parentWin',
    'theme',
    'panelOpen',
    'isDragging',
    'isPanelDragging',
    'orbStyle',
    'panelStyleRef',
    'onOrbPointerDown',
    'onOrbClick',
    'onPanelPointerDown',
    'closePanel',
  ];
  check('这些名字都由面板机制返回', 暴露的名字.filter(名 => !new RegExp(`\\b${名},`).test(panelSource)), []);
}

console.log('\n[7] 行为细节跟着搬: 拖动跟手 / 吸附 / 阴影 / 弹条动画 / 跨 document 挂载');
{
  ok('拖动同时听两侧窗口(iframe 与酒馆页面)', panelSource.includes('frameWin.value?.addEventListener') && panelSource.includes('parentWin.value?.addEventListener'));
  ok('松手在两侧都解绑', panelSource.includes('frameWin.value?.removeEventListener') && panelSource.includes('parentWin.value?.removeEventListener'));
  ok('拖动跟手用父窗口坐标(parentClient)', panelSource.includes('function parentClient') && panelSource.includes('rect.left + e.clientX'));
  ok('锚点夹在视口内(clamp + 直径/2)', panelSource.includes('clamp(startAnchorX + (point.x - startX), CLOSED_SIZE / 2'));
  ok('面板与球重叠时自动推开', panelSource.includes('const overlaps = ()') && panelSource.includes('spaceRight >= panelW.value'));
  ok('iframe 裁成"球 ∪ 面板"两个子形状', panelSource.includes("A ${r} ${r} 0 1 1") && panelSource.includes('V ${py + ph} H ${px} Z'));
  ok('阴影层挂在酒馆页面上(不是 iframe 内)', panelSource.includes('parentWin.value?.document') && panelSource.includes('panelShadowEl'));
  ok('阴影读主题变量 --yh-shadow 与圆角', panelSource.includes("getPropertyValue('--yh-shadow')") && panelSource.includes('style.borderRadius'));
  ok('关闭面板时阴影层收起', panelSource.includes("shadow.style.display = 'none'"));
  ok('面板打开时阴影淡入', panelSource.includes('shadow.animate([{ opacity: 0 }, { opacity: 1 }]'));
  ok('弹条关键帧跟着搬(yhPillIn / yhPillBreath)', panelSource.includes('@keyframes yhPillIn') && panelSource.includes('yhPillBreath'));
  ok('弹条贴在球左方(不够则右方)', panelSource.includes('let left = 心x - 半径 - w - 10;') && panelSource.includes('if (left < 8) left = 心x + 半径 + 10;'));
  // 被收纳插件搬走后仍然贴球: 收纳类插件**直接改 iframe 本体的 style.left/top**、且不发任何事件,
  // 逻辑球位(anchorX/anchorY)与真实位置就此脱节 —— 贴球定位必须以 iframe 的真实矩形为准。
  ok('贴球定位以**真实矩形**为准(收纳后仍然跟得住)', panelSource.includes('const 球矩形 = ref<') && panelSource.includes('if (实) return { x: 实.cx, y: 实.cy, r: Math.max(实.w, 实.h) / 2 };'));
  // 收纳坞把球**藏起来**(visibility:hidden + data-floating-dock-hidden)却**没搬走球 iframe**,
  // 所以只贴 iframe 会落在"球原来的位置" —— 必须认领坞里那个代理图标。
  ok('被收纳时贴坞里的代理图标(不是隐形 iframe 的老位置)',
    panelSource.includes('取收纳坞入口(parentWin.value?.document, frame.value)') &&
    panelSource.includes('if (r.width || r.height) return { x: r.left + r.width / 2'));
  ok('锚点按**值**判重: 坞拖动/折叠也能跟上(球 iframe 一动没动)',
    panelSource.includes('if (!强制 && Math.abs(旧.x - 锚.x) < 0.5'));
  ok('矩形盯守: 属性观察器(瞬时) + 慢轮询(兜底) + 卸载清理',
    panelSource.includes('量球观察器 = new MutationObserver(() => 同步贴球锚点())') &&
    panelSource.includes('量球定时器 = window.setInterval(() => 同步贴球锚点(), 2000)') &&
    panelSource.includes('量球观察器?.disconnect()'));
  ok('盯住收纳坞 + 卸载清理', panelSource.includes('坞观察器 = new MutationObserver') && panelSource.includes('坞观察器?.disconnect()'));
  ok('球一动就立刻重量(不等下一次轮询)', panelSource.includes('requestAnimationFrame(() => 同步贴球锚点(true))'));
  ok('跨 document 挂载仍在(挂到酒馆页面 body)', panelSource.includes('parentDoc.body.appendChild(el)'));
  ok('挂载/卸载接线也搬了(阴影层与 resize)', panelSource.includes('ensurePanelShadow();') && panelSource.includes('removePanelShadow();') && panelSource.includes('onViewportResize'));
  ok('偏好仍落全局变量 + localStorage 兜底', panelSource.includes('insertOrAssign') && panelSource.includes('localStorage.setItem'));
  ok('推进中弹条仍可中断', panelSource.includes('依赖.中断推进()'));
}

console.log('\n[8] 弹窗配色: 7 项都来自面板 token, 两套主题都完整');
{
  for (const mode of ['dark', 'light'] as const) {
    const 配色 = 取弹窗配色(mode);
    const token = 主题表[mode];
    ok(`${mode}: 7 项都有值`, Object.values(配色).every(v => typeof v === 'string' && v.length > 0));
    check(`${mode}: 底色取面板卡片色`, 配色.bg, token.panel);
    check(`${mode}: 文字色取面板文字色`, 配色.text, token.ink);
    check(`${mode}: 强调色取面板强调色`, 配色.accent, token.seal);
    check(`${mode}: 边框取面板描边色`, 配色.border, token.lineStrong);
    check(`${mode}: 错误边框取面板危险色`, 配色.errorBorder, token.seal);
  }
  check('深色与白天的弹窗底色不同', 取弹窗配色('dark').bg === 取弹窗配色('light').bg, false);

  const 名字 = Object.values(弹窗变量);
  check('弹窗变量 7 个', 名字.length, 7);
  check('互不相同', new Set(名字).size, 7);
  ok('都带 --yh-toast- 前缀', 名字.every(n => n.startsWith('--yh-toast-')));
  ok(
    '界面把配色推给弹窗与弹条(setToastColors + 那 4 个变量)',
    panelSource.includes('setToastColors(配色)') && panelSource.includes('弹窗变量.bg') && panelSource.includes('弹窗变量.accent'),
  );
}

console.log('\n[9] 用到的每个主题变量都有定义(错别字无处藏: CSS 与 token 的键必须对得上)');
{
  const 允许 = new Set<string>([
    ...Object.keys(取根变量('dark')),
    ...Object.keys(取根变量('light')),
    ...Object.values(弹窗变量),
  ]);
  const 没定义 = [...界面用到的变量()].filter(名 => !允许.has(名)).sort();
  // --yh-bg-hover 是**改造前就存在**的空洞(.yh-icon-btn:hover 的背景一直取不到值, 一直是初始值 transparent):
  // 这次只搬机制与 token, 不顺手补色——补了 hover 底色就会变, 那属于外观改动。除它以外一个新空洞都不许有。
  const 已知空洞 = ['--yh-bg-hover'];
  check('用了但没定义的变量(只允许改造前就有的那一个)', 没定义, 已知空洞);
  ok('两套主题的键一致, 所以同一批变量两套主题都给得出', Object.keys(取根变量('dark')).sort().join() === Object.keys(取根变量('light')).sort().join());
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0)
  process.exit(1);
