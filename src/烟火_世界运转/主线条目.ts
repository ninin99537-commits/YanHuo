// 烟火 · 主线世界书条目 —— 把「本幕」的骨架写进**角色卡主世界书**的常驻条目(蓝灯常开)。
//
// 形状照抄 inject.ts(世界动向那条常驻条目), 但两条条目各认各的、互不覆盖:
//   名字固定 '【主线·本幕】' —— 用户的世界书里**已经手工建了一条同名条目**, 我们要做的是更新它,
//   不是再建一条同义的; 认领信号有三条(名字 / comment / extra.主线), 与 inject.ts 的三信号写法一致;
//   extra 用 { 主线: true } 而不是 { yanhuo: true }: 后者是世界动向的认领信号, 用它会把两条条目认成同一条。
// 内容 = 渲染主线(主线); 空主线 = 删除该条目(与世界动向"世界为空就删"同一口径)。
//
// 为什么要写进世界书: 主 AI 每回合都会读到这条(蓝灯常驻、禁递归), 它写的是"这出戏的骨架",
// 主 AI 据此知道这幕的结束条件、欠着哪些债 —— 但条目开头就写明"NPC 不可能知道它", 不是世界动向。
// 而烟火自己读世界书时必须在 worldbook-read.ts 里排除它, 否则会把这段作者视角当成世界线读进去。
import type { Host } from './host';
import { 是空主线, 渲染主线, type 主线 } from './主线';
import { toastWarning } from './toast';

/** 主线条目名(对外只读: 界面/用例/排除名单都按它认这条) */
export const 主线条目名 = '【主线·本幕】';

/** 认自己: 名字 / comment / extra.主线 任一命中(三信号, 与 inject.ts 的 isYanhuoEntry 同款) */
function 是主线条目(entry: any): boolean {
    return entry?.name === 主线条目名 || entry?.comment === 主线条目名 || entry?.extra?.主线 === true;
}

/** "没绑定世界书"只提示一次, 不每轮刷屏(inject.ts 的 warnedNoWorldbook 同款) */
let 提示过没世界书 = false;

/**
 * 把主线写成/更新成当前角色卡主世界书里的常驻条目。
 * - 未绑定主世界书: 记一次提示后放弃(不抛错);
 * - !启用 或 空主线: 删除该条目;
 * - 已有条目: 只刷新内容并确保禁递归(保留条目上其它字段与现有名字);
 * - 没有条目: 按 inject.ts 的字段创建一条(蓝灯常驻、概率 100、extra.主线)。
 * 全过程**不向调用方抛错**(编排是 fire-and-forget 跑在消息回调里, 炸出去会打断调用点)。
 */
export async function 同步主线条目(host: Pick<Host, 'worldbook'>, 主线值: 主线, 启用: boolean): Promise<void> {
    try {
        let 世界书名: string | null = null;
        try {
            世界书名 = host.worldbook.boundNames().primary ?? null;
        }
        catch {
            世界书名 = null;
        }
        if (!世界书名) {
            if (启用 && !提示过没世界书) {
                提示过没世界书 = true;
                toastWarning(`当前角色卡没有绑定主世界书, 无法注入「${主线条目名}」条目。请先在角色卡上绑定一本世界书。`, '主线');
            }
            return;
        }
        if (!启用 || 是空主线(主线值)) {
            await host.worldbook.remove(世界书名, 是主线条目);
            return;
        }
        const 内容 = 渲染主线(主线值);
        const 已有 = (await host.worldbook.entries(世界书名)).find(是主线条目);
        if (已有) {
            // 只刷新内容 + 确保禁递归; 名字保留现有那条(用户手工建的条目可能只有 comment 命中,
            // 这时 entry.name 是空的 —— 补上本条目名, 否则下次只剩 extra 信号能认领)。
            await host.worldbook.update(世界书名, 条目表 =>
                条目表.map(entry =>
                    是主线条目(entry)
                        ? {
                            ...entry,
                            name: String(entry.name ?? '').trim() || 主线条目名,
                            content: 内容,
                            recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
                        }
                        : entry,
                ),
            );
        }
        else {
            // 条目被删除/改名后找不到, 重新创建(字段照 inject.ts, 只有 extra 是本条目的认领信号)
            await host.worldbook.create(世界书名, [
                {
                    name: 主线条目名,
                    content: 内容,
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
                    extra: { 主线: true },
                },
            ]);
        }
        提示过没世界书 = false;
    }
    catch (error) {
        console.error('[主线] 同步主线到世界书失败:', error);
    }
}
