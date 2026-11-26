// 烟火 · 彼方联动（方案 B：只读彼方楼层快照的公域切片）
// ---------------------------------------------------------------------------
// 为什么不走「放行彼方世界书条目」:
//   1. 彼方写入世界书的条目是给主 AI 看的, 刻意排除了「藏起来的打算」(防剧透/防全知);
//      而反派/幕后人物真正能牵动世界暗线与势力的, 恰恰在「当前目标」与「藏起来的打算」。
//   2. 彼方的明细条是按人名绿灯激活的 —— 最近几楼没被正文提到的幕后反派, 扫世界书根本激活不到。
//   3. 彼方明细里混有恋爱/好感/生理/起居(吃饭洗漱睡眠)/心事等私生活字段, 喂给世界引擎既浪费 token
//      又会与烟火「不记个人起居与私人相处」的规则冲突。
//
// 本模块零依赖 `src/彼方_NPC幕后生命状态系统/`(保证烟火独立发布仓库可单独构建),
// 只复用 `共用/楼层快照.ts` 的只读通道读取彼方存在酒馆聊天/楼层变量里的最新有效快照,
// 并严格白名单提取「能牵动公共层面的最小切片」:
//   ✅ 提取: 身份锚点 / 位置 / 当前目标 / 藏起来的打算(标为「暗中打算（未公开）」) / 进行中未完成事项(最多 3 条)
//   ❌ 屏蔽: 剧情时间(不给烟火第二根时钟)、当前在做(日常起居噪音)、恋爱/情欲/好感/名分/标签、生理/孕期、
//            生活状态(吃饭洗漱睡眠)、衣物/伤势、心事、往事、人际关系、知情、立场值/立场档。

import type { Host } from './host';
import { 取最新有效, type 快照索引, type 快照载荷, type 快照存储 } from '../共用/楼层快照';

/** 彼方在聊天变量与楼层变量里使用的存储键名（与 彼方/快照.ts 一致） */
const BIFANG_STORAGE_KEY = '彼方';

/** 每个人最多提取几条进行中的未完成事项（只取内容, 不带原话/结果/编号噪音） */
const 每人事务上限 = 3;

/** 最多喂给烟火的幕后人物数：防 20~30 人长档塞爆提示词，按公共动向优先级筛选 */
export const 联动人数上限 = 12;

export interface 彼方人物公域条 {
  名: string;
  身份锚点?: string;
  位置?: string;
  当前目标?: string;
  暗中打算?: string;
  进行中事务?: string[];
}

export interface 彼方公域切片 {
  /** 快照所在的楼层号（仅作诊断日志用, 不进提示词, 也不当时间用） */
  楼层: number;
  条目: 彼方人物公域条[];
  /** 超过 联动人数上限 被按优先级省去的人物数 */
  省略人数?: number;
}

type 只读联动宿主 = Pick<Host, 'vars' | 'chat'>;

function 净文本(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 提取「进行中」的未完成事项内容（兼容数组形态与旧文本形态, 不依赖彼方内部模块）。
 * 已完成 / 已作废的一律忽略。
 */
function 提取进行中事务(raw: unknown): string[] {
  if (!raw) return [];
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const 状态 = 净文本((item as Record<string, unknown>)['状态']);
      if (状态 && 状态 !== '进行中') continue;
      const 内容 = 净文本((item as Record<string, unknown>)['内容']);
      if (内容) out.push(内容);
      if (out.length >= 每人事务上限) break;
    }
    return out;
  }
  const 文本 = String(raw).trim();
  if (!文本) return [];
  for (const 行 of 文本.split(/[\n；;]/)) {
    const t = 行.trim();
    if (!t) continue;
    if (/已完成|已作废/.test(t)) continue;
    const 去前缀 = t
      .replace(/^\[?T\d+\]?\s*/i, '')
      .replace(/^[\[【(（]?\s*进行中\s*[\]】)）]?\s*[：:·-]?\s*/, '')
      .trim();
    if (去前缀) out.push(去前缀);
    if (out.length >= 每人事务上限) break;
  }
  return out;
}

/**
 * 从一份彼方快照载荷中提取公域与暗中打算切片（纯函数, 方便单测）。
 * 严禁把 剧情时间 / 恋爱 / 生理 / 起居 / 心事 / 往事 / 立场值 带出去。
 */
export function 提取彼方公域切片(载荷: Record<string, any> | null | undefined): 彼方公域切片 | null {
  if (!载荷 || typeof 载荷 !== 'object') return null;
  const npcMap = 载荷.NPC;
  if (!npcMap || typeof npcMap !== 'object' || Array.isArray(npcMap)) return null;

  const 顺序名: string[] = [];
  const 已见 = new Set<string>();
  if (Array.isArray(载荷.名单)) {
    for (const n of 载荷.名单) {
      const 名 = 净文本(n);
      if (名 && !已见.has(名)) {
        已见.add(名);
        顺序名.push(名);
      }
    }
  }
  for (const k of Object.keys(npcMap)) {
    const 名 = 净文本(k);
    if (名 && !已见.has(名)) {
      已见.add(名);
      顺序名.push(名);
    }
  }

  const 候选: Array<{ 条: 彼方人物公域条; 分: number; 提及层: number; 序: number }> = [];
  for (let 序 = 0; 序 < 顺序名.length; 序++) {
    const 名 = 顺序名[序];
    const 卡 = npcMap[名];
    if (!卡 || typeof 卡 !== 'object' || Array.isArray(卡)) continue;
    if (净文本(卡['休眠']) === '是') continue;
    const 身份锚点 = 净文本(卡['身份锚点']);
    const 位置 = 净文本(卡['位置']);
    const 当前目标 = 净文本(卡['当前目标']);
    const 暗中打算 = 净文本(卡['藏起来的打算']);
    const 进行中事务 = 提取进行中事务(卡['未完成事项']);
    if (!身份锚点 && !位置 && !当前目标 && !暗中打算 && !进行中事务.length)
      continue;
    const 分 = (暗中打算 ? 100 : 0) + (进行中事务.length ? 50 : 0) + (当前目标 ? 20 : 0);
    const 提及层 = typeof 卡['最后提及楼层'] === 'number' && Number.isFinite(卡['最后提及楼层']) ? 卡['最后提及楼层'] : -1;
    候选.push({
      条: {
        名,
        ...(身份锚点 ? { 身份锚点 } : {}),
        ...(位置 ? { 位置 } : {}),
        ...(当前目标 ? { 当前目标 } : {}),
        ...(暗中打算 ? { 暗中打算 } : {}),
        ...(进行中事务.length ? { 进行中事务 } : {}),
      },
      分,
      提及层,
      序,
    });
  }

  if (!候选.length) return null;
  // 按公共动向权重排在前面（有暗中打算 / 进行中事务 / 目标的人物优先），同分按最近提及楼层与原顺序排
  候选.sort((a, b) => b.分 - a.分 || b.提及层 - a.提及层 || a.序 - b.序);
  const 省略人数 = Math.max(0, 候选.length - 联动人数上限);
  const 条目 = 候选.slice(0, 联动人数上限).map(x => x.条);
  const 楼层 = typeof 载荷.楼层 === 'number' && Number.isFinite(载荷.楼层) ? 载荷.楼层 : -1;
  return { 楼层, 条目, ...(省略人数 > 0 ? { 省略人数 } : {}) };
}

/**
 * 格式化给烟火模型看的紧凑只读文本；无有效人物时返回空串（让条件段整段消失）。
 */
export function 格式化彼方公域切片(切片: 彼方公域切片 | null | undefined): string {
  if (!切片 || !切片.条目.length) return '';
  const 行们 = 切片.条目.map(项 => {
    const 段: string[] = [项.名];
    if (项.身份锚点) 段.push(`身份：${项.身份锚点}`);
    if (项.位置) 段.push(`位置：${项.位置}`);
    if (项.当前目标) 段.push(`当前目标：${项.当前目标}`);
    if (项.暗中打算) 段.push(`暗中打算（未公开）：${项.暗中打算}`);
    if (项.进行中事务?.length) 段.push(`进行中事务：${项.进行中事务.join('；')}`);
    return `- ${段.join('｜')}`;
  });
  if (切片.省略人数 && 切片.省略人数 > 0) {
    行们.push(`（其余 ${切片.省略人数} 名暂无明显公共动向的人物已省略）`);
  }
  return 行们.join('\n');
}

/**
 * 只读读取当前聊天中彼方截至 `截至楼层` 的最新有效快照，并提取公域切片。
 * - 纯只读：绝不写入、裁剪或删除彼方的任何聊天/楼层变量。
 * - 容错：未装彼方、聊天未就绪、无快照或格式异常时静默返回 null。
 */
export function 读取彼方公域切片(host: 只读联动宿主, 截至楼层?: number): 彼方公域切片 | null {
  try {
    let 清空层 = 0;
    const 只读存储: 快照存储 = {
      读索引: () => {
        try {
          const raw = host.vars.get({ type: 'chat' })?.[BIFANG_STORAGE_KEY];
          if (!raw || typeof raw !== 'object' || !Array.isArray(raw.快照楼层))
            return null;
          清空层 = typeof raw.清空层 === 'number' && Number.isFinite(raw.清空层) ? raw.清空层 : 0;
          return raw as 快照索引;
        }
        catch {
          return null;
        }
      },
      // 纯只读：严禁反向修改彼方的存储
      写索引: () => false,
      楼层还在: 楼层 => {
        try {
          return (host.chat.messages(楼层)?.length ?? 0) > 0;
        }
        catch {
          return false;
        }
      },
      读楼层: 楼层 => {
        try {
          const raw = host.vars.get({ type: 'message', message_id: 楼层 })?.[BIFANG_STORAGE_KEY];
          return raw && typeof raw === 'object' ? raw as 快照载荷 : null;
        }
        catch {
          return null;
        }
      },
      写楼层: () => {},
      删楼层: () => {},
      末层: () => host.chat.lastMessageId(),
    };

    const 读 = 取最新有效(只读存储, {
      跳过: 楼层 => (typeof 截至楼层 === 'number' && Number.isFinite(截至楼层) && 楼层 > 截至楼层),
      有效: (_载荷, 楼层) => 楼层 > 清空层,
    });
    if (读.未就绪 || !读.载荷)
      return null;
    return 提取彼方公域切片(读.载荷);
  }
  catch {
    return null;
  }
}
