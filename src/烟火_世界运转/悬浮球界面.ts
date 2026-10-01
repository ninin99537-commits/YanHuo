import { useHost } from './host';
import { pinia } from './pinia';
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
      width: '40px',
      height: '40px',
      border: 'none',
      outline: 'none',
      boxShadow: 'none',
      pointerEvents: 'auto',
      zIndex: '2147483000',
    })
    .appendTo('body');
  $app.on('load', () => {
    const nestedDoc = $app[0].contentDocument;
    if (!nestedDoc) return;
    copyStylesTo(nestedDoc);
    app.mount(nestedDoc.body);
    window.setTimeout(() => copyStylesTo(nestedDoc), 300);
    window.setTimeout(() => copyStylesTo(nestedDoc), 1200);
  });
  $(window).on('pagehide', () => {
    app.unmount();
    $app.remove();
  });
});
