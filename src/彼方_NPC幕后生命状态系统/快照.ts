// 彼方 · 状态快照: 状态怎么存进楼层、怎么读回来、旧版数据怎么迁移。
//
// 这一层是纯粹的数据存取——不碰 Vue, 不碰 pinia(界面要的那份响应式副本在 数据仓.ts),
// 于是它能脱离界面单独测一遍。平台访问全部走 useHost()(约定见 host.ts 顶部)。
//
// 存储结构 (v3):
// - 聊天变量 `彼方` 只存轻量元数据: 哪些楼层有快照(索引) + 清空层
// - 状态本体(名单/NPC卡/统计/剧情时间)整体存在**楼层变量**里, 每次更新写入本次
//   分析的最后一条楼层。快照随楼层存亡——删除楼层/重roll(新swipe页没有快照)时状态
//   自动回退到更早楼层的快照, 因此不再需要任何自建的回滚/检测逻辑。
// 依赖按实际用到的符号具名导入(形态守卫见 tests/no-bundle-artifacts.test.ts)
import { klona } from 'klona';
import { toastError } from './toast';
import { useHost } from './host';

const STORAGE_KEY = '彼方';
const DATA_VERSION = 3;
/** 楼层快照最多保留的份数: 写入新快照时把更早楼层的快照物理删除, 防止聊天文件随楼层无限膨胀 */
const SNAPSHOT_LIMIT = 10;

/** 字符串滚动hash(楼层内容指纹) */
function hashString(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return String(hash);
}
function emptyMeta() {
    return { 版本: DATA_VERSION, 快照楼层: [], 清空层: 0 };
}
function saveMeta(meta) {
    try {
        // 整体赋值该键(避免 insertOrAssign 深合并残留旧字段), 其他聊天变量键不动
        useHost().vars.update(variables => {
            variables[STORAGE_KEY] = klona(meta);
            return variables;
        }, { type: 'chat' });
    }
    catch (error) {
        console.error('[彼方] 保存元数据失败:', error);
        toastError(`彼方: 保存元数据失败 ${error instanceof Error ? error.message : String(error)}`, '彼方');
    }
}
function loadMeta() {
    let raw = null;
    try {
        raw = useHost().vars.get({ type: 'chat' })?.[STORAGE_KEY] ?? null;
    }
    catch {
        return emptyMeta();
    }
    if (!raw || typeof raw !== 'object')
        return emptyMeta();
    if (Array.isArray(raw.快照楼层)) {
        return {
            版本: DATA_VERSION,
            快照楼层: raw.快照楼层.filter(floor => typeof floor === 'number' && Number.isFinite(floor)),
            清空层: typeof raw.清空层 === 'number' ? raw.清空层 : 0,
        };
    }
    // v2 及更早的旧结构(状态本体存在聊天变量): 迁移为楼层快照(含旧「快照」数组,
    // 回滚能力完整保留; 全部写入成功才覆盖旧结构, 失败则保留待重试)
    return migrateLegacyData(raw);
}
/** 读取全部非隐藏的 AI 回复楼层(升序), 供旧数据迁移时把「第N条AI回复」换算为楼层号 */
function listAssistantFloors() {
    try {
        const lastId = useHost().chat.lastMessageId();
        if (lastId < 0)
            return [];
        return useHost().chat.messages(`0-${lastId}`, { role: 'assistant' }).filter(message => !message.is_hidden);
    }
    catch {
        return [];
    }
}
/**
 * v2 及更早的旧结构(状态本体存在聊天变量)迁移为楼层快照:
 * - 旧「快照」数组(按AI楼层数记录的最近10份) → 换算成楼层号, 逐份写入对应楼层, 回滚能力完整保留;
 * - 旧当前状态(名单/NPC等) → 写入最后一条AI楼层(与最新历史快照同层时覆盖它, 它就是最新一次更新的结果);
 * - **全部写入成功后才用新元数据覆盖旧结构**; 任一步失败则保留旧结构, 下次访问时重试, 不丢数据。
 */
function migrateLegacyData(raw) {
    const meta = emptyMeta();
    meta.清空层 = typeof raw.清空层 === 'number' ? raw.清空层 : 0;
    // 兜底备份: 迁移前后无论发生什么(部分失败后被新快照覆盖等), 原始旧数据都有一份完整副本可找回
    try {
        useHost().vars.update(variables => {
            variables['彼方_旧版备份'] = klona(raw);
            return variables;
        }, { type: 'chat' });
    }
    catch {
        // 备份失败不阻塞迁移
    }
    try {
        const assistants = listAssistantFloors();
        const floorOfCount = (count) => {
            // 旧快照的「层数」是第 N 条 AI 回复(从1起), 换算为楼层号
            const index = (typeof count === 'number' ? count : 0) - 1;
            return index >= 0 && index < assistants.length ? assistants[index].message_id : null;
        };
        const pending = [];
        for (const legacy of (Array.isArray(raw.快照) ? raw.快照 : [])) {
            if (!legacy || typeof legacy !== 'object')
                continue;
            const floorId = floorOfCount(legacy.层数);
            if (floorId === null)
                continue;
            pending.push({ floorId, processedFloor: floorId, data: legacy });
        }
        const npc = raw.NPC;
        if (npc && typeof npc === 'object' && Object.keys(npc).length > 0 && assistants.length > 0) {
            const latestFloor = assistants[assistants.length - 1].message_id;
            pending.push({
                floorId: latestFloor,
                processedFloor: latestFloor,
                data: {
                    名单: Array.isArray(raw.名单) ? raw.名单 : [],
                    NPC: npc,
                    卡字段计数: raw.卡字段计数 ?? {},
                    统计: raw.统计 ?? { 更新次数: 0, 最后更新: 0 },
                    剧情时间: typeof raw.剧情时间 === 'string' ? raw.剧情时间 : '',
                },
            });
        }
        // 同层去重(当前状态排最后, 覆盖同层的旧历史快照)
        const byFloor = new Map();
        for (const item of pending)
            byFloor.set(item.floorId, item);
        if (byFloor.size === 0) {
            // 没有可迁移的数据(空状态聊天), 直接以新结构接管(保留清空层)
            saveMeta(meta);
            return meta;
        }
        for (const [floorId, item] of byFloor) {
            const payload = buildSnapshotPayload(item.data, floorId, item.processedFloor);
            if (!payload)
                throw Error(`楼层 #${floorId} 不存在, 迁移中止`);
            writeFloorVariables(payload);
            meta.快照楼层.push(floorId);
        }
        meta.快照楼层.sort((a, b) => a - b);
        while (meta.快照楼层.length > SNAPSHOT_LIMIT) {
            const removed = meta.快照楼层.shift();
            try {
                useHost().vars.del(STORAGE_KEY, { type: 'message', message_id: removed });
            }
            catch {
                // 楼层可能已不存在, 忽略
            }
        }
        saveMeta(meta);
        // 迁移成功: 删除兜底备份键, 不在聊天变量里留永久残迹(失败路径才需要它)
        try {
            useHost().vars.del('彼方_旧版备份', { type: 'chat' });
        }
        catch {
            // 删除失败不影响迁移结果
        }
        console.info(`[彼方] 已把旧版聊天变量数据迁移为楼层快照: 楼层=[${meta.快照楼层.join(', ')}]`);
        return meta;
    }
    catch (error) {
        // 迁移失败: 不覆盖旧结构(聊天变量里的旧数据原样保留, 下次访问重试), 本次按空状态运行
        console.warn('[彼方] 旧版数据迁移失败, 已保留旧数据待下次重试:', error);
        return emptyMeta();
    }
}
/**
 * 彼方当前状态的形状(与旧版字段兼容, 供界面与更新流程使用); 快照本体存在楼层变量里。
 * 这是这个形状的唯一声明: emptyData() 产出它, 数据变更入口也按它合并草稿。
 * 末尾的索引签名给旧版/未来字段留位置(旧快照里可能带着已经不用的字段)。
 */
export interface 彼方数据 {
    版本: number;
    名单: string[];
    NPC: Record<string, any>;
    卡字段计数: Record<string, any>;
    统计: { 更新次数: number; 最后更新: number };
    剧情时间: string;
    /** 清空层(来自聊天变量元数据): 清空后只分析比它更新的楼层, 防旧NPC复活 */
    清空层: number;
    /** 当前状态来自哪个楼层的快照(-1=无快照) */
    锚点楼层: number;
    /** 已分析到哪条楼层(增量判定: 手动重填时判断最新层是否已处理过) */
    处理到楼层: number;
    [其它字段: string]: any;
}
/** 彼方当前状态的数据形状(与旧版字段兼容, 供界面与更新流程使用); 快照本体存在楼层变量里 */
function emptyData(): 彼方数据 {
    return {
        版本: DATA_VERSION,
        名单: [],
        NPC: {},
        卡字段计数: {},
        统计: { 更新次数: 0, 最后更新: 0 },
        剧情时间: '',
        /** 清空层(来自聊天变量元数据): 清空后只分析比它更新的楼层, 防旧NPC复活 */
        清空层: 0,
        /** 当前状态来自哪个楼层的快照(-1=无快照) */
        锚点楼层: -1,
        /** 已分析到哪条楼层(增量判定: 手动重填时判断最新层是否已处理过) */
        处理到楼层: 0,
    };
}
/**
 * 读取彼方当前状态: 从最新快照楼层往前找第一份**有效**快照。
 * - 楼层不存在(被删) → 快照随之消亡, 从索引清理, 继续往前;
 * - 楼层变量里没有快照(如重roll产生的新swipe页) → 继续往前;
 * - 楼层内容hash与快照记录不一致(楼层被编辑) → 该快照作废, 继续往前;
 * 命中或扫尽后返回状态; 一个快照都没有时返回空状态(清空层仍生效)。
 */
function loadData() {
    try {
        const meta = loadMeta();
        const floors = [...meta.快照楼层].sort((a, b) => a - b);
        const missingFloors = [];
        for (let i = floors.length - 1; i >= 0; i--) {
            const floorId = floors[i];
            let message = null;
            try {
                message = useHost().chat.messages(floorId)[0] ?? null;
            }
            catch {
                message = null;
            }
            if (!message) {
                missingFloors.push(floorId);
                continue;
            }
            let snapshot = null;
            try {
                snapshot = useHost().vars.get({ type: 'message', message_id: floorId })?.[STORAGE_KEY] ?? null;
            }
            catch {
                snapshot = null;
            }
            if (!snapshot || typeof snapshot !== 'object' || snapshot.楼层 !== floorId)
                continue;
            // 楼层hash校验已移除: 主AI楼层在彼方快照写入后仍会变动(流式收尾/正则脚本后处理/
            // 世界书格式追加等), hash失配把"正常游玩"误判为"楼层被编辑", 导致每轮回退空状态
            // (更新次数恒为1、名单反复消失)。快照有效性只按"楼层存在+快照键匹配"判定。
            if (missingFloors.length > 0) {
                meta.快照楼层 = meta.快照楼层.filter(floor => !missingFloors.includes(floor));
                saveMeta(meta);
            }
            return {
                ...emptyData(),
                名单: Array.isArray(snapshot.名单) ? [...snapshot.名单] : [],
                NPC: snapshot.NPC && typeof snapshot.NPC === 'object' ? { ...snapshot.NPC } : {},
                卡字段计数: snapshot.卡字段计数 && typeof snapshot.卡字段计数 === 'object' ? { ...snapshot.卡字段计数 } : {},
                统计: { 更新次数: 0, 最后更新: 0, ...(snapshot.统计 && typeof snapshot.统计 === 'object' ? snapshot.统计 : {}) },
                剧情时间: typeof snapshot.剧情时间 === 'string' ? snapshot.剧情时间 : '',
                清空层: meta.清空层,
                锚点楼层: floorId,
                处理到楼层: typeof snapshot.处理到楼层 === 'number' ? snapshot.处理到楼层 : 0,
            };
        }
        if (missingFloors.length > 0) {
            meta.快照楼层 = meta.快照楼层.filter(floor => !missingFloors.includes(floor));
            saveMeta(meta);
        }
        return { ...emptyData(), 清空层: meta.清空层 };
    }
    catch (error) {
        console.warn('[彼方] 读取状态失败, 使用空状态:', error);
        return emptyData();
    }
}
/** 构造楼层快照数据(楼层不存在时返回 null); 楼层hash取该楼层当前内容, 供读取时校验楼层是否被编辑 */
function buildSnapshotPayload(data, anchorFloor, processedFloor) {
    let message = null;
    try {
        message = useHost().chat.messages(anchorFloor)[0] ?? null;
    }
    catch {
        message = null;
    }
    if (!message)
        return null;
    // 快照体积控制: 清理每张 NPC 卡的调试/运行时字段, 防止长聊天里快照无限膨胀
    // - 最后更新: 现实时间戳, 每次更新都变, 对恢复状态无意义
    // - 人设参考: 每轮更新动态注入的世界书人设(由 update.ts 按 NPC 名字激活), 不该入库
    // - 卡字段计数: 旧版调试字段, 已从数据流移除
    const cleanedNpc = {};
    for (const [name, card] of Object.entries(data.NPC ?? {})) {
        if (!card || typeof card !== 'object')
            continue;
        const cleaned = { ...card };
        delete cleaned['最后更新'];
        delete cleaned['人设参考'];
        cleanedNpc[name] = cleaned;
    }
    return {
        版本: DATA_VERSION,
        楼层: anchorFloor,
        楼层hash: hashString(String(message.message ?? '')),
        处理到楼层: processedFloor,
        名单: [...(data.名单 ?? [])],
        NPC: klona(cleanedNpc),
        统计: { 更新次数: data.统计?.更新次数 ?? 0, 最后更新: data.统计?.最后更新 ?? 0 },
        剧情时间: data.剧情时间 ?? '',
    };
}
/** 把快照整体写入楼层变量(当前swipe页): 整体赋值该键避免深合并残留, 同楼层其他键(其他脚本的变量)不动 */
function writeFloorVariables(payload) {
    useHost().vars.update(variables => {
        variables[STORAGE_KEY] = payload;
        return variables;
    }, { type: 'message', message_id: payload.楼层 });
}
/**
 * 把状态整体写成一份楼层快照, 存到 `anchorFloor` 楼层的楼层变量里(当前swipe页),
 * 并维护聊天变量里的快照楼层索引 + 物理清理超额的更早快照。
 *
 * @param data 要持久化的状态(名单/NPC/统计/剧情时间)
 * @param anchorFloor 快照锚定的楼层号(快照随该楼层存亡)
 * @param processedFloor 「已分析到哪条楼层」(增量判定用)
 * @param consumeClearLayer 成功写入后是否把「清空层」清零(自动更新成功后清零=清空层只在首次更新生效)
 * @param metaInput 调用方已持有的元数据; 不传则内部读取
 */
function writeStateSnapshot(data, anchorFloor, processedFloor, consumeClearLayer, metaInput = null) {
    const meta = metaInput ?? loadMeta();
    const payload = buildSnapshotPayload(data, anchorFloor, processedFloor);
    if (!payload) {
        console.warn(`[彼方] 楼层 #${anchorFloor} 不存在, 无法保存快照`);
        return false;
    }
    try {
        writeFloorVariables(payload);
    }
    catch (error) {
        console.error(`[彼方] 写入楼层快照失败(楼层 #${anchorFloor}):`, error);
        return false;
    }
    // 维护索引(同层重填时去重替换)并物理清理超额快照
    meta.快照楼层 = meta.快照楼层.filter(floor => floor !== anchorFloor);
    meta.快照楼层.push(anchorFloor);
    meta.快照楼层.sort((a, b) => a - b);
    while (meta.快照楼层.length > SNAPSHOT_LIMIT) {
        const removed = meta.快照楼层.shift();
        try {
            useHost().vars.del(STORAGE_KEY, { type: 'message', message_id: removed });
        }
        catch {
            // 楼层可能已不存在, 忽略
        }
    }
    if (consumeClearLayer)
        meta.清空层 = 0;
    saveMeta(meta);
    console.info(`[彼方] 快照写入楼层 #${anchorFloor} (NPC=${Object.keys(payload.NPC).length}个: ${Object.keys(payload.NPC).join('、') || '(空)'}; 更新次数=${payload.统计?.更新次数}; 保留快照楼层=[${meta.快照楼层.join(',')}]${consumeClearLayer ? ', 清空层已生效清零' : ''})`);
    console.info(`[彼方] 本轮更新前名单: [${(data.名单 ?? []).join('、') || '(空)'}] → 更新后名单: [${(payload.名单 ?? []).join('、') || '(空)'}]`);
    return true;
}
/** 保存当前状态(界面手动编辑用): 以最新楼层为锚点写入快照, 不改变「已分析到哪」的进度 */
function saveData(data) {
    try {
        const anchor = useHost().chat.lastMessageId();
        writeStateSnapshot(data, anchor, typeof data.处理到楼层 === 'number' ? data.处理到楼层 : 0, false);
    }
    catch (error) {
        console.error('[彼方] 保存NPC状态失败:', error);
        toastError(`彼方: 保存失败 ${error instanceof Error ? error.message : String(error)}`, '彼方');
    }
}
/** 单独更新清空层(不动快照): 清空层自适应下移等场景使用 */
function updateClearLayer(clearLayer) {
    const meta = loadMeta();
    meta.清空层 = clearLayer;
    saveMeta(meta);
}
/** 撤销指定楼层的快照(手动「重新填写」用): 从索引移除并物理删除, 状态自动回落到更早楼层 */
function discardSnapshotAt(floorId) {
    const meta = loadMeta();
    if (!meta.快照楼层.includes(floorId))
        return false;
    meta.快照楼层 = meta.快照楼层.filter(floor => floor !== floorId);
    saveMeta(meta);
    try {
        useHost().vars.del(STORAGE_KEY, { type: 'message', message_id: floorId });
    }
    catch {
        // 楼层可能已不存在, 忽略
    }
    console.info(`[彼方] 已撤销楼层 #${floorId} 的快照`);
    return true;
}
/** 清空全部彼方数据: 物理删除所有楼层的快照 + 重置元数据, 并记录当前楼层为「清空层」 */
function clearAllData() {
    const meta = loadMeta();
    for (const floorId of meta.快照楼层) {
        try {
            useHost().vars.del(STORAGE_KEY, { type: 'message', message_id: floorId });
        }
        catch {
            // 楼层可能已不存在, 忽略
        }
    }
    const fresh = emptyMeta();
    try {
        fresh.清空层 = useHost().chat.lastMessageId();
    }
    catch {
        // 读取失败时保持 0, 退化为全量分析
    }
    saveMeta(fresh);
    return fresh.清空层;
}

export { DATA_VERSION, SNAPSHOT_LIMIT, STORAGE_KEY, clearAllData, discardSnapshotAt, emptyData, loadData, saveData, updateClearLayer, writeStateSnapshot };
