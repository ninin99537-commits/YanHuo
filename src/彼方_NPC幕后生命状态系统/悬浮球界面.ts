// 依赖按实际用到的符号具名导入(形态守卫见 tests/no-bundle-artifacts.test.ts)。
// .vue 用**默认导入**: 组件本身就是它的默认导出(原先写成从命名空间取 ["default"])。
import { pinia } from './pinia';
import 悬浮球界面 from './悬浮球界面.vue';
import { createApp } from 'vue';
import { useHost } from './host';

const SRCDOC = `<!DOCTYPE html><html><head><style>*,*::before,*::after{box-sizing:border-box;}html,body{margin:0;padding:0;height:100%;overflow:hidden;background:transparent;}body:focus,html:focus{outline:none;}</style></head><body></body></html>`;
function copyStylesTo(nestedDoc) {
    const existing = new Set([...nestedDoc.head.querySelectorAll('style')].map(style => style.textContent));
    document.head.querySelectorAll('style').forEach(style => {
        if (style.textContent && !existing.has(style.textContent)) {
            nestedDoc.head.appendChild(style.cloneNode(true));
        }
    });
}
$(() => {
    const app = createApp(悬浮球界面).use(pinia);
    // 强制父页面不给悬浮球 iframe 画任何边框/焦点框（Chrome 会对聚焦的 iframe 显示默认外框）
    if (!document.getElementById('bf-orb-force-style')) {
        const style = document.createElement('style');
        style.id = 'bf-orb-force-style';
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
    const $app = $(`<iframe>`)
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
        // 挂载成功前绝不吃指针事件：壳一插进 DOM 就停在 [0,0] 且 40×40，
        // 挂载一旦抛错它就永久钉在那里吃掉左上角全部指针事件，压住别的插件。
        pointerEvents: 'none',
        zIndex: '2147483000',
    })
        .appendTo('body');
    $app.on('load', () => {
        const nestedDoc = $app[0].contentDocument;
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
        // 清理彼方写到酒馆页面(父文档)上的元素: 弹窗容器/锚点/更新弹窗/样式,
        // 脚本停用后不留残迹(重载时会重新创建, 不影响热重载)
        try {
            const pdoc = window.parent !== window ? window.parent.document : null;
            if (pdoc) {
                ['bf-toast-stack', 'bf-toast-anchor', '彼方_更新弹窗', 'bf-orb-force-style'].forEach(id => {
                    pdoc.getElementById(id)?.remove();
                });
                pdoc.querySelector('style[data-bf-pop]')?.remove();
            }
        }
        catch {
            // 跨域等异常忽略
        }
    });
});

