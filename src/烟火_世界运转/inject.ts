import { useHost } from './host';
import { buildInjectionPrompt } from './prompts';
import type { Settings, WorldData } from './schema';
import { WORLDBOOK_ENTRY_NAME } from './state';
import { toastWarning } from './toast';

function isYanhuoEntry(entry: any): boolean {
  return entry?.name === WORLDBOOK_ENTRY_NAME || entry?.comment === WORLDBOOK_ENTRY_NAME || entry?.extra?.yanhuo === true;
}

/** 数据库脚本(ACU)剧情推进的"条目屏蔽"关键词：命中则条目不进剧情推进上下文 */
const ACU_BLOCKED_KEYWORDS = ['规则', '思维链', 'cot', 'MVU', 'mvu', '变量', '状态', 'Status', 'Rule', 'rule', '检定', '判断', '叙事', '文风', 'InitVar', '格式'];

/** 若条目名命中 ACU 屏蔽词, 改回安全条目名, 否则保留现有名 */
function sanitizeEntryName(currentName: string): string {
  const name = String(currentName || '').trim();
  return ACU_BLOCKED_KEYWORDS.some(keyword => name.includes(keyword)) ? WORLDBOOK_ENTRY_NAME : name;
}

let warnedNoWorldbook = false;

/**
 * 把世界动向写入**当前角色卡主世界书**里的常驻条目(蓝灯常开):
 * - 主 AI 读取激活世界书时读到; 数据库剧情推进读取角色绑定世界书(主世界书)时也读到;
 * - 角色主世界书是共享的, 因此切换聊天时会重新注入当前聊天的内容;
 * - 关闭或世界为空时删除该条目。
 * 烟火自己读取世界书时会在 getActiveWorldbookText 里排除本条目。
 */
export async function syncWorldbookEntry(data: WorldData, enabled: boolean, settings: Settings): Promise<void> {
  try {
    let wbName: string | null = null;
    try {
      wbName = useHost().worldbook.boundNames().primary ?? null;
    } catch {
      wbName = null;
    }
    if (!wbName) {
      if (enabled && !warnedNoWorldbook) {
        warnedNoWorldbook = true;
        toastWarning('当前角色卡没有绑定主世界书, 无法注入「世界动向」条目。请先在角色卡上绑定一本世界书。', '烟火');
      }
      return;
    }
    // 五层档案(地域/大势/伏笔/节令/指标)也算世界已有数据——否则只推了五层还没长事件时会被误判"世界为空"误删条目
    const hasWorld = Boolean(
      data.世界.时间 ||
        data.世界.总览 ||
        data.事件.length > 0 ||
        Object.keys(data.势力).length > 0 ||
        Object.keys(data.地域 ?? {}).length > 0 ||
        Object.keys(data.大势 ?? {}).length > 0 ||
        (data.伏笔 ?? []).length > 0 ||
        (data.节令 ?? []).length > 0 ||
        Object.keys(data.指标 ?? {}).length > 0,
    );
    if (!enabled || !hasWorld) {
      await useHost().worldbook.remove(wbName, isYanhuoEntry);
      return;
    }
    const content = buildInjectionPrompt(data, settings);
    const existing = (await useHost().worldbook.entries(wbName)).find(isYanhuoEntry);
    if (existing) {
      // 保留其它字段, 只刷新内容; 确保防递归开启; 名字若命中 ACU 屏蔽词则改回安全名
      await useHost().worldbook.update(wbName, wb =>
        wb.map(entry =>
          isYanhuoEntry(entry)
            ? {
                ...entry,
                name: sanitizeEntryName(entry.name || WORLDBOOK_ENTRY_NAME),
                content,
                recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
              }
            : entry,
        ),
      );
    } else {
      // 条目被删除/改名后找不到, 重新创建
      await useHost().worldbook.create(wbName, [
        {
          name: WORLDBOOK_ENTRY_NAME,
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
          extra: { yanhuo: true },
        },
      ]);
    }
    warnedNoWorldbook = false;
  } catch (error) {
    console.error('[烟火] 同步世界动向到世界书失败:', error);
  }
}
