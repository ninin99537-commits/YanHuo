import { useHost } from './host';
import { pinia } from './pinia';
import { 层序, 悬浮球直径 } from './主题';
import 悬浮球界面 from './悬浮球界面.vue';
import { createApp } from 'vue';

const SRCDOC = `<!DOCTYPE html><html><head><style>*,*::before,*::after{box-sizing:border-box;}html,body{margin:0;padding:0;height:100%;overflow:hidden;background:transparent;}body:focus,html:focus{outline:none;}</style></head><body></body></html>`;

function copyStylesTo(nestedDoc: Document) {
  const existing = new Set([...nestedDoc.head.querySelectorAll('style')].map(style => style.textContent));
  document.head.querySelectorAll('style').forEach(style => {
    if (style.textContent && !existing.has(style.textContent)) {
      nestedDoc.head.appendChild(style.cloneNode(true));
    }
  });
}

$(() => {
  const app = createApp(悬浮球界面).use(pinia);
  // 强制父页面不给悬浮球 iframe 画任何边框/焦点框(Chrome 会对聚焦的 iframe 显示默认外框)
  if (!document.getElementById('yh-orb-force-style')) {
    const style = document.createElement('style');
    style.id = 'yh-orb-force-style';
    style.textContent = `
      iframe[script_id] {
        border: none !important;
        outline: none !important;
        box-shadow: none !important;
        background: transparent !important;
      }
      iframe[script_id]:focus,
      iframe[script_id]:focus-visible,
      iframe[script_id]:focus-within {
        outline: none !important;
      }`;
    document.head.appendChild(style);
  }
  const $app = $('<iframe>')
    .attr({ script_id: useHost().vars.scriptId(), frameborder: 0, tabindex: -1, srcdoc: SRCDOC })
    .css({
      position: 'fixed',
      left: '0px',
      top: '0px',
      // 球直径与层序都从 主题.ts 取(以前这里是手抄的 40px 与 2147483000)
      width: `${悬浮球直径}px`,
      height: `${悬浮球直径}px`,
      border: 'none',
      outline: 'none',
      boxShadow: 'none',
      // 挂载成功前绝不吃指针事件：壳一插进 DOM 就停在 [0,0] 且 40×40，
      // 挂载一旦抛错它就永久钉在那里吃掉左上角全部指针事件，压住别的插件。
      pointerEvents: 'none',
      zIndex: String(层序.球iframe),
    })
    .appendTo('body');
  $app.on('load', () => {
    const nestedDoc = $app[0].contentDocument;
    if (!nestedDoc) return;
    copyStylesTo(nestedDoc);
    app.mount(nestedDoc.body);
    // mount 走通 ⇒ onMounted 已把球迁走，此刻才接管指针事件
    $app[0].style.pointerEvents = 'auto';
    window.setTimeout(() => copyStylesTo(nestedDoc), 300);
    window.setTimeout(() => copyStylesTo(nestedDoc), 1200);
  });
  $(window).on('pagehide', () => {
    app.unmount();
    $app.remove();
  });
});
