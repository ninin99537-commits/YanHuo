// 本轮"取料 + 组装提示词"(候选2 第四块)。
// 从最近几条 AI 回复里取出正文/上下文/当前卡/人设, 汇成发给模型的消息数组。
// 读聊天记录的小工具仍留在 update.ts, 由调用方经 依赖 传进来 —— 和 模型请求.ts 的 发请求/记日志/报进度 一个路子。
// 前置条件不满足时(如没有可用的 AI 回复)返回 null: 提示已经发过, 调用方直接收工。

// 依赖按实际用到的符号具名导入(形态守卫见 tests/no-bundle-artifacts.test.ts)
import { buildUpdateMessages } from './prompts';
import { getActiveWorldbookText, getPersonaTextForNpc } from './worldbook';
import { loadData, updateClearLayer } from './快照';
import { toastWarning } from './toast';
import { PHYSIO_CYCLE_MAX, PHYSIO_CYCLE_MIN, PHYSIO_FIELDS } from './生理规则';

type 取料 = { 过滤: any; 追踪: any; 名字出现: any; 最近回复: any; 上下文: any; 时间提示: any; 时间跳跃: any };
type 取料参数 = { host: any; settings: any; force: any; timing: any; debugStore: any; 依赖: 取料 };
export async function 收集本轮输入(参数: 取料参数) {
    const { host, settings, force, timing, debugStore, 依赖 } = 参数;

    let data = loadData();
    // 获取玩家/主角名, 避免给主角建档; 顺带清理历史误建的主角卡
    const playerName = host.persona.name();
    // 主角信息(persona 描述): 主 AI 能看到 persona, 彼方此前没有读取渠道——
    // 主角设定不写在世界书里时, 更新 AI 完全不知道主角是谁, 这里补齐
    const playerDescription = host.persona.description().trim().slice(0, 4000);
    if (playerName && data.NPC[playerName]) {
        delete data.NPC[playerName];
        data.名单 = data.名单.filter(name => name !== playerName);
    }
    // 手动更新不再撤销当前快照(旧行为"先回退再重填"会把本轮自动更新积累的其他 NPC
    // 一起退回旧快照, 频繁手动更新时表现为角色/更新次数反复消失)——直接以现有状态为基底
    // 增量重填, 更新次数照常累加。
    const tracked = 依赖.追踪(settings, data);
    const recentCount = Math.max(1, settings.更新.读取最近回复数 ?? 3);
    let clearLayer = data.清空层 ?? 0;
    // 清空层自适应: 清空后楼层被删到清空层以下时, 现有楼层号永远追不上清空层,
    // 自动更新会被静默卡死。此时把清空层自动挪到最新楼层(等价于"从没更新过",
    // 之后的新楼层照常分析), 与 v1.10 的行为一致。
    if (!force && clearLayer > 0) {
        let lastId = -1;
        try {
            lastId = host.chat.lastMessageId();
        }
        catch {
            // 取不到楼层就保持上面的 -1(不参与清空层下移)
        }
        if (lastId >= 0 && clearLayer > lastId) {
            const oldClearLayer = clearLayer;
            clearLayer = lastId;
            data.清空层 = clearLayer;
            try {
                updateClearLayer(clearLayer);
                console.warn(`[彼方] 清空层 #${oldClearLayer} 高于当前最新楼层 #${lastId}, 已自动下移到 #${lastId}(之后的新楼层照常分析)`);
            }
            catch (error) {
                console.warn('[彼方] 清空层下移失败(不影响本次更新):', error);
            }
        }
    }
    // 自动更新只分析清空之后的楼层；手动更新(force)强制分析最近 N 条
    let recent = 依赖.最近回复(recentCount);
    if (!force)
        recent = recent.filter((message: any) => message.message_id > clearLayer);
    if (recent.length === 0) {
        if (force) {
            toastWarning('彼方: 没有可分析的AI回复（请确认已生成至少一条AI回复）', '彼方');
        }
        else {
            console.warn('[彼方] 未找到新的AI回复(清空后或仅剩旧楼层), 跳过本次更新');
        }
        return null;
    }
    const filter = 依赖.过滤(settings);
    // 标注每条回复的顺序，最后一条为【最新回复】，让 AI 明确当前场景以最新一条为准
    const reply = recent
        .map((message: any, index: number) => `【${index === recent.length - 1 ? '最新回复' : `较早回复 ${index + 1}`}】\n${filter(message.message)}`)
        .join('\n\n');
    const timeJump = 依赖.时间跳跃(reply);
    // 名字提示用**过滤后**的正文判断(思维链/隐藏标签里提到的名字不算"出现过")
    const inSceneHint = tracked.filter((name: string) => 依赖.名字出现(reply, name));
    const replyIds = new Set(recent.map(message => message.message_id));
    // 手动更新(force)连上下文一起完整分析（含清空前的用户输入）；自动更新才受清空层约束
    // 「最近剧情」上下文只取最新 1 层用户输入（正文仍按「读取最近 N 条」）
    const context = 依赖.上下文(recent[recent.length - 1].message_id, filter, 1, replyIds, force ? 0 : clearLayer);
    timing.前置 = Date.now() - timing.start;
    const worldbookStart = Date.now();
    const worldbook = settings.更新.注入世界书
        ? await getActiveWorldbookText([context, reply].filter(Boolean).join('\n\n'), settings.更新.注入世界书排除 ?? [], settings.更新.常驻世界书条目 ?? [])
        : '';
    timing.世界书 = Date.now() - worldbookStart;
    const storyTimeHint = 依赖.时间提示(worldbook, reply, context);
    const currentCards: Record<string, any> = {};
    // 无论是否重填都发送现有状态卡: 重填时它们作为"旧卡参考"传给 AI, 保证角色设定连续, 但要求 AI 忽略具体状态从零重填
    for (const name of tracked) {
        const oldCard = data.NPC[name];
        if (!oldCard)
            continue;
        const card = { ...oldCard };
        // 关键: 周期长度只在 mergeCard(合并后)才生成, 而发给 AI 的是合并前的旧卡——
        // 若缺周期长度, AI 看不到锁定值就只能写死 28。这里先补上(有生理字段的可怀孕角色),
        // 并回写 data, 让后续 mergeCard 直接沿用, 不重复随机。
        if ((card['周期长度'] === undefined || card['周期长度'] === null)
            && PHYSIO_FIELDS.some(field => card[field] !== undefined && card[field] !== null && String(card[field] ?? '').trim() !== '')) {
            card['周期长度'] = PHYSIO_CYCLE_MIN + Math.floor(Math.random() * (PHYSIO_CYCLE_MAX - PHYSIO_CYCLE_MIN + 1));
            oldCard['周期长度'] = card['周期长度'];
        }
        // 清理旧版生理字段残留, 避免 AI 继续沿用旧台账逻辑
        delete card['累计受孕率'];
        delete card['受孕率记录'];
        delete card['生理结算'];
        currentCards[name] = card;
    }
    // 人设注入: 对每个已追踪 NPC, 收集**该 NPC 名字能触发的绿灯(关键词)条目**作为"人设参考"附在卡旁。
    // 与整包 worldbook 注入的区别: 这里**跳过蓝灯常驻条目**——蓝灯无条件下发, 给所有 NPC 的都是同一份
    // "基础世界观", 失去按 NPC 区分人设的意义; 只保留"keys 数组里显式包含 NPC 名字(或曾用名)"的条目,
    // 保证每张卡附的人设参考真的是它自己的人设, 而不是基础世界观。
    if (settings.更新.注入世界书 && tracked.length > 0) {
        for (const name of tracked) {
            const card = currentCards[name];
            if (!card)
                continue;
            const alias = String(card['曾用名'] ?? '').trim();
            try {
                const personaText = await getPersonaTextForNpc(name, alias, settings.更新.注入世界书排除 ?? []);
                if (personaText && personaText.trim()) {
                    // 截断到 1500 字: 防止人设条目超长挤占输出 token
                    card['人设参考'] = personaText.trim().slice(0, 1500);
                }
            }
            catch (error) {
                console.warn(`[彼方] 获取 NPC「${name}」人设条目失败(不影响本次更新):`, error);
            }
        }
    }
    const { messages, 锚点 } = buildUpdateMessages({
        reply,
        replyCount: recent.length,
        context,
        timeJump,
        tracked,
        inSceneHint,
        currentCards,
        autoTrackEnabled: settings.更新.自动建档 !== false,
        physioEnabled: settings.更新.生理监测,
        破限: !!settings.更新.破限,
        头部填充: !!settings.更新.提示词头部填充,
        头部填充文本: settings.更新.头部填充文本 ?? '',
        防截断: !!settings.更新.防截断,
        预填充: !!settings.更新.预填充,
        worldbook,
        currentStoryTime: data.剧情时间,
        storyTimeHint,
        playerName,
        playerDescription,
    });
    debugStore.record({
        time: Date.now(),
        model: settings.接口.模型,
        replyIds: recent.map(message => message.message_id),
        replyPreview: reply.slice(0, 150),
        request: messages
            .map(message => `【${message.role === 'system' ? '系统指令' : message.role === 'user' ? '用户' : '助手'}】\n${message.content}`)
            .join('\n\n────────\n\n'),
    });
    console.info(`[彼方] 开始更新幕后NPC状态 (使用最近 ${recent.length} 条回复: #${recent.map(message => message.message_id).join(', #')})`);

    return { 锚点, data, messages, playerName, recent, timeJump };
}
