import { useHost } from './host';
import type { Settings, WorldData } from './schema';
import { WORLDBOOK_ENTRY_NAME } from './state';
import { 构建公开摘要, 构建绿灯条目, type 绿灯条目 } from './公开摘要';
import { 有世界数据 } from './世界数据';
import { toastWarning } from './toast';
import { 串行写世界书 } from '../共用/世界书锁';

const 绿灯前缀: Record<绿灯条目['角色'], string> = {
  组织: '【烟火】组织·',
  地区: '【烟火】地区·',
  事态: '【烟火】事态·',
  往事: '【烟火】往事·',
};

function 是绿灯条目名(name: unknown): boolean {
  const s = String(name ?? '');
  return s.startsWith(绿灯前缀.组织) || s.startsWith(绿灯前缀.地区) || s.startsWith(绿灯前缀.事态) || s.startsWith(绿灯前缀.往事);
}

function isYanhuoEntry(entry: any): boolean {
  return (
    entry?.name === WORLDBOOK_ENTRY_NAME
    || entry?.comment === WORLDBOOK_ENTRY_NAME
    || entry?.extra?.yanhuo === true
    || 是绿灯条目名(entry?.name)
    || 是绿灯条目名(entry?.comment)
  );
}

function 是绿灯条目(entry: any): boolean {
  return entry?.extra?.yanhuoRole === '组织'
    || entry?.extra?.yanhuoRole === '地区'
    || entry?.extra?.yanhuoRole === '事态'
    || entry?.extra?.yanhuoRole === '往事'
    || 是绿灯条目名(entry?.name)
    || 是绿灯条目名(entry?.comment);
}

function 是蓝灯条目(entry: any): boolean {
  return isYanhuoEntry(entry) && !是绿灯条目(entry);
}

/** 数据库脚本(ACU)剧情推进的"条目屏蔽"关键词：命中则条目不进剧情推进上下文 */
const ACU_BLOCKED_KEYWORDS = ['规则', '思维链', 'cot', 'MVU', 'mvu', '变量', '状态', 'Status', 'Rule', 'rule', '检定', '判断', '叙事', '文风', 'InitVar', '格式'];

/** 若条目名命中 ACU 屏蔽词, 改回安全条目名, 否则保留现有名 */
function sanitizeEntryName(currentName: string): string {
  const name = String(currentName || '').trim();
  return ACU_BLOCKED_KEYWORDS.some(keyword => name.includes(keyword)) ? WORLDBOOK_ENTRY_NAME : name;
}

function 剥屏蔽词(名: string): string {
  let 剩下 = String(名 ?? '');
  for (const 词 of ACU_BLOCKED_KEYWORDS) {
    剩下 = 剩下.replace(new RegExp(词.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }
  return 剩下.replace(/[\s\-_·]+/g, '').trim();
}

function 短哈希(文本: string, 位数 = 8): string {
  let h = 5381;
  for (let i = 0; i < 文本.length; i++) h = ((h << 5) + h) ^ 文本.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(位数, '0').slice(0, 位数);
}

function 绿灯条目名(角色: 绿灯条目['角色'], 键: string): string {
  const 前缀 = 绿灯前缀[角色];
  const 候选 = `${前缀}${键}`;
  if (sanitizeEntryName(候选) === 候选) return 候选;
  const 净化 = 剥屏蔽词(键);
  return 净化 ? `${前缀}${净化}-${短哈希(键)}` : `${前缀}${短哈希(键)}`;
}

function 匹配绿灯键(entry: any, 项: 绿灯条目): boolean {
  if (entry?.extra?.yanhuoRole && entry?.extra?.yanhuoKey) {
    return entry.extra.yanhuoRole === 项.角色 && entry.extra.yanhuoKey === 项.键;
  }
  return entry?.name === 绿灯条目名(项.角色, 项.显示名);
}

let warnedNoWorldbook = false;

export interface 世界书同步结果 {
  状态: '已同步' | '已停用' | '待同步';
  说明: string;
}

/** 收集现有已绑定的世界书名（不新建书），供关闭开关/清空时清理 */
function 收集可清理世界书(host: ReturnType<typeof useHost>): string[] {
  const names: string[] = [];
  try {
    const primary = host.worldbook.boundNames().primary;
    if (primary) names.push(primary);
  } catch { /* ignore */ }
  try {
    const chat = host.worldbook.chatName?.();
    if (chat && !names.includes(chat)) names.push(chat);
  } catch { /* ignore */ }
  return names;
}

/**
 * 把当前聊天的世界动向写入目标世界书（默认角色卡主世界书，也可在设置里切为聊天世界书以支持群聊与每聊隔离）。
 * 切聊天时覆盖烟火自己的那一条；其它条目与 AM 条目一律不碰。
 * 写入全程经跨插件串行锁，避免与彼方同时改写同一本世界书互相覆盖。
 */
export async function syncWorldbookEntry(data: WorldData, enabled: boolean, settings: Settings, 仍属当前: () => boolean = () => true): Promise<世界书同步结果> {
  try {
    const host = useHost();
    const 目标 = settings.运转?.世界书写入目标 ?? '角色卡主世界书';
    if (!仍属当前()) return { 状态: '待同步', 说明: '聊天、分支或世界修订已变化，本次旧投影未写入世界书' };

    // 停用或无世界数据时：从已有世界书里清理烟火条目，不新建世界书
    if (!enabled || !有世界数据(data)) {
      const 清理书 = 收集可清理世界书(host);
      if (清理书.length === 0) {
        return { 状态: enabled ? '待同步' : '已停用', 说明: '当前未绑定世界书，无需清理' };
      }
      for (const name of 清理书) {
        await 串行写世界书(name, async () => {
          if (!仍属当前()) return;
          await useHost().worldbook.remove(name, isYanhuoEntry);
        });
      }
      return { 状态: '已同步', 说明: '公开摘要已关闭或当前无公开数据，烟火条目已移除' };
    }

    let wbName: string | null = null;
    if (目标 === '聊天世界书') {
      try {
        wbName = (await host.worldbook.getOrCreateChat?.()) ?? host.worldbook.chatName?.() ?? null;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { 状态: '待同步', 说明: `获取或创建聊天世界书失败：${msg}` };
      }
      if (!wbName) {
        if (!warnedNoWorldbook) {
          warnedNoWorldbook = true;
          toastWarning('未能取到当前聊天的世界书，世界快照不受影响；请先在聊天上绑定一本世界书。', '烟火');
        }
        return { 状态: '待同步', 说明: '未能取到当前聊天的世界书' };
      }
    } else {
      try { wbName = host.worldbook.boundNames().primary ?? null; } catch { wbName = null; }
      if (!wbName) {
        const 群聊 = (host.worldbook.groupMemberNames?.().length ?? 0) > 0;
        const 提示 = 群聊
          ? '群聊里没有「当前角色卡」，写不进角色卡主世界书；请把烟火设置里的「写入世界书」改成「聊天世界书」。'
          : '当前角色卡没有绑定主世界书，世界快照不受影响；请先绑定主世界书，或把「写入世界书」改成「聊天世界书」。';
        if (!warnedNoWorldbook) {
          warnedNoWorldbook = true;
          toastWarning(提示, '烟火');
        }
        return { 状态: '待同步', 说明: 群聊 ? '群聊无法写入角色卡主世界书，请改用「聊天世界书」' : '当前角色卡未绑定主世界书，未自动创建或重绑' };
      }
    }

    const targetBook = wbName;
    return await 串行写世界书(targetBook, async () => {
      if (!仍属当前()) return { 状态: '待同步', 说明: '聊天、分支或世界修订已变化，本次旧投影未写入世界书' };
      const 摘要 = 构建公开摘要(data, settings);
      const content = 摘要.text;
      const 绿灯们 = 构建绿灯条目(data, settings, undefined, 摘要.omittedIds, 摘要.了结Ids);
      const allEntries = await useHost().worldbook.entries(targetBook);
      const existing = allEntries.find(是蓝灯条目);
      const existingGreen = allEntries.filter(是绿灯条目);
      if (!仍属当前()) return { 状态: '待同步', 说明: '聊天、分支或世界修订已变化，本次旧投影未写入世界书' };

      // 1. 删除已不在目标集合里的绿灯条目（以及同一键的重复副本）
      const 已保留键 = new Set<string>();
      const 待删条目 = new Set<any>();
      for (const entry of existingGreen) {
        const 匹配项 = 绿灯们.find(项 => 匹配绿灯键(entry, 项));
        if (!匹配项) {
          待删条目.add(entry);
          continue;
        }
        const 复合键 = `${匹配项.角色}:${匹配项.键}`;
        if (已保留键.has(复合键)) 待删条目.add(entry);
        else 已保留键.add(复合键);
      }
      if (待删条目.size > 0) {
        const 待删uid = new Set(Array.from(待删条目).map(e => e?.uid).filter(u => u !== undefined));
        const 待删名 = new Set(Array.from(待删条目).filter(e => e?.uid === undefined).map(e => e?.name));
        await useHost().worldbook.remove(targetBook, (e: any) => {
          if (!是绿灯条目(e)) return false;
          if (e?.uid !== undefined) return 待删uid.has(e.uid);
          return 待删名.has(e?.name);
        });
      }

      // 2. 更新蓝灯条目与已有绿灯条目
      if (existing || 绿灯们.some(项 => existingGreen.some(e => 匹配绿灯键(e, 项)))) {
        await useHost().worldbook.update(targetBook, wb =>
          wb.map(entry => {
            if (是蓝灯条目(entry)) {
              return {
                ...entry,
                name: sanitizeEntryName(entry.name || WORLDBOOK_ENTRY_NAME),
                content,
                extra: { ...(entry.extra ?? {}), yanhuo: true, yanhuoRole: '简报' },
                recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
              };
            }
            if (是绿灯条目(entry)) {
              const 项 = 绿灯们.find(g => 匹配绿灯键(entry, g));
              if (!项) return entry;
              return {
                ...entry,
                name: 绿灯条目名(项.角色, 项.显示名),
                content: 项.内容,
                enabled: true,
                strategy: {
                  ...(entry.strategy ?? {}),
                  type: 'selective',
                  keys: 项.关键词,
                  keys_secondary: entry.strategy?.keys_secondary ?? { logic: 'not_any', keys: [] },
                  scan_depth: entry.strategy?.scan_depth ?? 'same_as_global',
                },
                extra: { ...(entry.extra ?? {}), yanhuo: true, yanhuoRole: 项.角色, yanhuoKey: 项.键 },
                recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
              };
            }
            return entry;
          }),
        );
      }

      // 3. 创建缺失的蓝灯与绿灯条目
      const 待建: any[] = [];
      if (!existing) {
        待建.push({
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
          extra: { yanhuo: true, yanhuoRole: '简报' },
        });
      }
      for (let i = 0; i < 绿灯们.length; i++) {
        const 项 = 绿灯们[i];
        if (existingGreen.some(e => 匹配绿灯键(e, 项))) continue;
        待建.push({
          name: 绿灯条目名(项.角色, 项.显示名),
          content: 项.内容,
          enabled: true,
          probability: 100,
          strategy: {
            type: 'selective',
            keys: 项.关键词,
            keys_secondary: { logic: 'not_any', keys: [] },
            scan_depth: 'same_as_global',
          },
          position: { type: 'after_character_definition', role: 'system', depth: 0, order: 101 + i },
          recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
          extra: { yanhuo: true, yanhuoRole: 项.角色, yanhuoKey: 项.键 },
        });
      }
      if (待建.length > 0) {
        await useHost().worldbook.create(targetBook, 待建);
      }
      warnedNoWorldbook = false;
      const 绿灯说明 = 绿灯们.length > 0 ? `（含 ${绿灯们.length} 条绿灯档案）` : '';
      return { 状态: '已同步', 说明: `公开摘要已同步到${目标}「${targetBook}」${绿灯说明}` };
    });
  } catch (error) {
    console.error('[烟火] 同步世界动向到世界书失败:', error);
    return { 状态: '待同步', 说明: `世界书同步未完成：${error instanceof Error ? error.message : String(error)}` };
  }
}
