import type { Host } from './host';
// 依赖按实际用到的符号具名导入(形态守卫见 tests/no-bundle-artifacts.test.ts)
import { buildInjectionPrompt } from './prompts';
import { BIFANG_WORLDBOOK_ENTRY_NAME, isBifangEntry, sanitizeBifangEntryName } from './彼方条目';
import { useMainPromptStore } from './日志仓';

/**
 * 把彼方幕后状态写入**当前角色卡主世界书**里的常驻条目(蓝灯常开):
 * - 主AI读取激活世界书时读到; 数据库剧情推进读取角色绑定世界书(主世界书)时也读到;
 * - 角色主世界书是共享的, 因此切换聊天时(handleChatChanged)会重新注入当前聊天的内容;
 * - 关闭或无NPC时删除该条目。
 * 彼方自己读取世界书时会在 getActiveWorldbookText 里排除本条目。
 *
 * 平台访问全部走 host.worldbook / host.toast(见 host.ts), 本函数不直接碰酒馆全局——
 * 于是测试里能塞一本假世界书进来, 把"新建 / 更新 / 改名 / 删除 / 没绑世界书"几种情形都跑一遍。
 * 这里保留的是**领域规则**(条目叫什么名、蓝灯常开、防递归、内容怎么渲染), 与平台无关。
 *
 * `未回票` 是**逐轮临时**的(来自本轮合并, 不落库): 本轮没被模型过问的进行中编号, 用来给那几条
 * 加上"（未表态，待确认）"。切聊天时 `handleChatChanged` 会不带它重写世界书 → 标记自然消失,
 * 语义正确——它描述的只是"这一轮"。
 */
async function syncNpcStatesWorldbook(host: Pick<Host, 'worldbook' | 'toast'>, data, enabled, 未回票?: Record<string, string[]>) {
    try {
        const wbName = host.worldbook.boundNames().primary;
        if (!wbName) {
            if (enabled)
                host.toast.warn('当前角色卡没有绑定主世界书，无法注入「NPC幕后生活」条目。请先在角色卡上绑定一本世界书。', '彼方');
            return;
        }
        const npcEntries = Object.entries(data.NPC ?? {});
        if (!enabled || npcEntries.length === 0) {
            await host.worldbook.remove(wbName, isBifangEntry);
            return;
        }
        const content = buildInjectionPrompt(npcEntries, 未回票);
        // 日志页「彼方写入世界书的内容」记录: 与写入条目的内容完全一致(同一个渲染函数),
        // 主AI 以及任何读取该世界书的环节读到的就是这一段
        useMainPromptStore().record(content);
        const existing = (await host.worldbook.entries(wbName)).find(isBifangEntry);
        if (existing) {
            // 保留其它字段, 只刷新内容; 确保防递归开启; 名字若命中 ACU 屏蔽词则改回安全名
            await host.worldbook.update(wbName, wb => wb.map(entry => isBifangEntry(entry)
                ? {
                    ...entry,
                    name: sanitizeBifangEntryName(entry.name || BIFANG_WORLDBOOK_ENTRY_NAME),
                    content,
                    recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
                }
                : entry));
        }
        else {
            // 条目被删除/改名后找不到, 重新创建
            await host.worldbook.create(wbName, [
                {
                    name: BIFANG_WORLDBOOK_ENTRY_NAME,
                    content,
                    enabled: true,
                    probability: 100,
                    strategy: {
                        type: 'constant',
                        keys: [],
                        keys_secondary: { logic: 'not_any', keys: [] },
                        scan_depth: 'same_as_global',
                    },
                    position: { type: 'after_character_definition', role: 'system', depth: 0, order: 100 },
                    recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
                    extra: { bifang: true },
                },
            ]);
        }
    }
    catch (error) {
        console.error('[彼方] 同步幕后状态到世界书失败:', error);
    }
}

export { syncNpcStatesWorldbook };
