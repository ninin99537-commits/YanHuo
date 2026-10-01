// 彼方的四个数据变更入口: 加 NPC / 移除 NPC / 改状态卡 / 清空。
//
// 这四段协议(草稿合并 → 最后更新 → 写快照 → 重同步世界书)以前摊在界面里: 三段几乎逐字重复的
// 内联序列, 清空是第四个变体(绕过闸门、写死"不写入"), 闸门口径三处两种, 清空之后界面还要
// 重读存储用启发式判断"到底清干净没有"——持久层的不变式被界面断言。现在收在这里, 界面只消费返回值。
//
// 依赖走 变更环境: 生产环境(建变更环境)连接真实的 快照.ts / worldbook-inject.ts,
// 测试里换成假的就能把四种变更各跑一遍, 不需要酒馆。
import { useHost } from './host';
import { getSettings } from './settings';
import { CARD_FIELDS, 扩展编辑字段 } from './卡字段';
import { clearAllData, emptyData, saveData } from './快照';
import type { 彼方数据 } from './快照';
import { syncNpcStatesWorldbook } from './worldbook-inject';

export type { 彼方数据 };

/** 状态卡里可手动编辑、但不在 CARD_FIELDS 中的字段(由彼方/AI 维护, 玩家可手动覆盖) */
export { 扩展编辑字段 };

export interface 变更环境 {
    /** 是否开启「写入世界书条目」——变更后要不要重同步世界书, 只由这一处决定 */
    注入世界书条目: boolean;
    /** 写一份快照(界面手动编辑用: 锚在最新楼层, 不推进"已分析到哪") */
    保存: (数据: 彼方数据) => void;
    /** 物理删除所有楼层的快照 + 重置元数据（记录清空层） */
    清空: () => void;
    /** 重同步世界书条目: 写入=true 表示"照这份数据写成条目", false 表示"删掉条目" */
    同步世界书: (数据: 彼方数据, 写入: boolean) => unknown;
    /** 取当前时间戳(草稿合并写「最后更新」用) */
    现在: () => number;
}

/** 真实环境: 闸门取当前设置, 其余用 快照.ts / worldbook-inject.ts 的实现 */
export function 建变更环境(): 变更环境 {
    const host = useHost();
    return {
        注入世界书条目: Boolean(getSettings().更新.注入世界书条目),
        保存: saveData,
        清空: clearAllData,
        同步世界书: (数据, 写入) => syncNpcStatesWorldbook(host, 数据, 写入),
        现在: Date.now,
    };
}

export interface 变更返回 {
    /** 改完的数据: 界面直接渲染它, 不再重读存储去猜结果 */
    数据: 彼方数据;
    /** 一句话说明发生了什么(界面拿去做提示) */
    说明: string;
}

/** 草稿合并: 有值的字符串字段写入(去首尾空白); 空字符串按 空值即删除 决定删除还是跳过 */
function 合并草稿(卡: Record<string, any>, 草稿: Record<string, any>, 空值即删除: boolean) {
    for (const 字段 of [...CARD_FIELDS, ...扩展编辑字段]) {
        const 值 = 草稿?.[字段];
        if (typeof 值 !== 'string')
            continue;
        if (值.trim())
            卡[字段] = 值.trim();
        else if (空值即删除)
            delete 卡[字段];
    }
}

/** 变更后重同步世界书: 空数据 = 删条目; 未开启注入时完全不碰世界书(唯一闸门) */
function 同步世界书(数据: 彼方数据, 环境: 变更环境) {
    if (!环境.注入世界书条目)
        return;
    const 有NPC = Object.keys(数据.NPC ?? {}).length > 0;
    try {
        const 结果: any = 环境.同步世界书(数据, 有NPC);
        if (结果 && typeof 结果.catch === 'function')
            结果.catch((error: unknown) => console.error('[彼方] 同步世界书条目失败:', error));
    }
    catch (error) {
        console.error('[彼方] 同步世界书条目失败:', error);
    }
}

/** 加 NPC: 名单补名 + 用草稿建卡(已有卡则合并) */
export function 加NPC(数据: 彼方数据, 名字: string, 草稿: Record<string, any>, 环境: 变更环境): 变更返回 {
    const 新数据: 彼方数据 = { ...数据, 名单: [...(数据.名单 ?? [])], NPC: { ...(数据.NPC ?? {}) } };
    if (!新数据.名单.includes(名字))
        新数据.名单.push(名字);
    const 卡 = { ...(新数据.NPC[名字] ?? {}) };
    合并草稿(卡, 草稿, false);
    卡['最后更新'] = 环境.现在();
    新数据.NPC[名字] = 卡;
    环境.保存(新数据);
    同步世界书(新数据, 环境);
    return { 数据: 新数据, 说明: `已添加 NPC: ${名字}` };
}

/** 移除 NPC: 名单与状态卡一起去掉 */
export function 移除NPC(数据: 彼方数据, 名字: string, 环境: 变更环境): 变更返回 {
    const 新数据: 彼方数据 = {
        ...数据,
        名单: (数据.名单 ?? []).filter(名 => 名 !== 名字),
        NPC: { ...(数据.NPC ?? {}) },
    };
    delete 新数据.NPC[名字];
    环境.保存(新数据);
    同步世界书(新数据, 环境);
    return { 数据: 新数据, 说明: `已移除 NPC: ${名字}` };
}

/** 改状态卡: 草稿里空的字符串字段 = 删掉该字段(玩家清空输入框即清字段) */
export function 更新状态卡(数据: 彼方数据, 名字: string, 草稿: Record<string, any>, 环境: 变更环境): 变更返回 {
    const 新数据: 彼方数据 = { ...数据, 名单: [...(数据.名单 ?? [])], NPC: { ...(数据.NPC ?? {}) } };
    const 卡 = { ...(新数据.NPC[名字] ?? {}) };
    合并草稿(卡, 草稿, true);
    卡['最后更新'] = 环境.现在();
    新数据.NPC[名字] = 卡;
    环境.保存(新数据);
    同步世界书(新数据, 环境);
    return { 数据: 新数据, 说明: `已保存 ${名字} 的状态` };
}

/**
 * 清空: 物理删除所有楼层的快照 + 重置元数据(记录清空层), 开启注入时顺手删掉世界书条目。
 * 这里**不写快照**——清空后应当一份快照都不剩; 界面也不再重读存储去猜结果(持久层自己负责正确性)。
 */
export function 清空彼方数据(环境: 变更环境): 变更返回 {
    环境.清空();
    const 空数据 = emptyData();
    同步世界书(空数据, 环境);
    return { 数据: 空数据, 说明: '彼方: 数据已清空，清空后只分析清空之后的新楼层' };
}
