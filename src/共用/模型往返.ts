// 共用 · 模型往返 —— 「发请求 → 解析 → 校验 → 不合格就重试」只此一份
// ---------------------------------------------------------------------------
// 彼方、烟火与剧情导演各有一段这样的循环, 连重试节奏(接口错等 2s×次数、结构错等 0.6s)、
// 预填充 '{' 的拼回、中断文案的处理, 三边都一字不差 —— 差别只有四件事:
//   - 解析: 各自切 JSON 候选/剥离思考字段的细节不同(烟火还要挑「世界推进」载荷), 各自传进来;
//   - 校验: 结构不合格时抛错, 抛什么错由各自决定;
//   - 错误分类: 彼方把"不是 JSON"也当可重试的错误, 烟火/导演当致命错误当场抛出;
//   - 文案: 名字、失败记录里的阶段名、给用户看的重试理由。
// 除了这几件, 其余全在这儿: 改一次重试策略, 三边同时生效。
//
// ⚠️ 重试**不再回喂**上一次的输出与错误原因(2026-10-09 用户决定去掉)。
//    原实现把上次输出的 JSON 片段 + 解析/校验错误原因拼成一条 user 消息, 接在"任务消息"后面,
//    好让模型看见自己错在哪、自己改 —— 那是为"模型不肯守格式"打的补丁。现在模型已经稳定守格式,
//    这个补丁只剩坏处: 每次重试都要多塞进一大段上一次的坏输出(白占上下文), 还可能被模型顺着抄一遍。
//    所以现在重试 = **原样重发同一份提示词**。
//    接口错(网络/超时/网关)的重试本来就不带任何回喂, 行为完全不变;
//    结构失败的重试仍保留 3 次上限, 是因为"输出被接口砍断"这类失败原样重推一次往往就成了
//    (2026-10-01 真机实测: 3284 字的世界 JSON 被砍断, 手动重推即成功)。
//
// 它不碰平台: 发请求 / 记日志 / 报进度 都是参数(与各自的 host 接缝接得上), 所以没有平台也能测。
// ---------------------------------------------------------------------------

/** 失败发生在哪一步 */
type 错误阶段 = '请求' | '解析' | '校验';
/** 一次失败怎么处理: 接口错=等久一点直接重试; 反馈=有输出可重试(原样重发); 致命=当场抛出 */
type 错误归属 = '接口' | '反馈' | '致命';

type 往返参数 = {
    /** 基础消息(每次尝试都原样重发这一份) */
    messages: any[];
    /** 设置里的"预填充": 末位补一条 assistant '{' 引导模型直接从 JSON 开始 */
    预填充: boolean;
    signal: AbortSignal;
    /** 真正发请求(线上是各自 api.ts 的 chatCompletion) */
    发请求: (messages: any[], options: { signal: AbortSignal }) => Promise<string>;
    /** 把原始输出解析成对象; 解析不了就抛错 */
    解析: (content: string) => any;
    /** 校验并规范化; 不合格就抛错 */
    校验: (parsed: any) => any;
    /** 错误分类(默认: 请求=接口, 解析/校验=反馈) */
    判断错误?: (error: Error, 阶段: 错误阶段) => 错误归属;
    /** 日志与提示里的名字, 如 '彼方' / '烟火' / '剧情导演' */
    名字: string;
    /** 结构失败记进日志时的阶段名, 如 '更新失败' / '推进失败' / '编排失败' */
    结构失败标签: string;
    /** 由错误信息推出"给用户看的重试理由"(三边文案不同, 各自传) */
    取重试理由: (error: Error) => string;
    /** 用户中断时的错误文案, 如 '用户已中断本次更新' / '用户已中断本次推进' */
    中断文案: string;
    /** 写日志页(线上是 debugStore.record) */
    记日志: (记录: any) => void;
    /** 报进度(线上是 updatingStore.message = 文字) */
    报进度: (文字: string) => void;
};

const 最多尝试 = 3;
const 等 = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function 请求并校验(参数: 往返参数): Promise<{ parsed: any; 请求耗时: number; 请求次数: number }> {
    const { messages, 预填充, signal, 发请求, 解析, 校验, 名字, 结构失败标签, 中断文案, 记日志, 报进度 } = 参数;
    const 判断错误 = 参数.判断错误 ?? ((_error: Error, 阶段: 错误阶段) => (阶段 === '请求' ? '接口' : '反馈'));
    let parsed: any = null;
    let 失败: Error | null = null;
    let 请求耗时 = 0;
    let 请求次数 = 0;

    for (let attempt = 1; attempt <= 最多尝试; attempt++) {
        // 重试 = 原样重发同一份提示词(不回喂上次输出, 也不带错误原因)
        const attemptMessages = [...messages];
        // 预填充: 末位补 '{', 引导模型直接从 JSON 开头输出(返回后要把 '{' 拼回, 见下)
        const last = attemptMessages[attemptMessages.length - 1];
        const prefill = 预填充 && attemptMessages.length > 0 && (last.role === 'user' || last.role === 'assistant') ? '{\n' : '';
        if (prefill)
            attemptMessages.push({ role: 'assistant', content: prefill });
        let content: string;

        try {
            const 开始 = Date.now();
            content = await 发请求(attemptMessages, { signal });
            请求耗时 += Date.now() - 开始;
            请求次数 += 1;
            if (prefill && String(content).trim().charAt(0) !== '{')
                content = prefill + content;
            记日志({ time: Date.now(), response: content });
        }
        catch (error) {
            if (signal.aborted)
                throw Error(中断文案, { cause: error });
            失败 = error instanceof Error ? error : Error(String(error));
            const 归属 = 判断错误(失败, '请求');
            if (归属 === '致命')
                throw 失败;
            记日志({ time: Date.now(), error: `接口调用失败(第 ${attempt}/${最多尝试} 次): ${失败.message}` });
            if (attempt < 最多尝试 && !signal.aborted) {
                报进度(`接口调用失败，正在重试（${attempt}/${最多尝试}）…`);
                console.warn(`[${名字}] 接口调用失败(第 ${attempt} 次), 正在重试…:`, 失败.message);
                await 等(2000 * attempt);
            }
            continue;
        }

        // 解析: 失败按 判断错误 的归属决定是重试还是当场抛出
        try {
            parsed = 解析(content);
        }
        catch (error) {
            失败 = error instanceof Error ? error : Error(String(error));
            const 归属 = 判断错误(失败, '解析');
            if (归属 === '致命' || 归属 === '接口')
                throw 失败;
            记日志({ time: Date.now(), error: `${结构失败标签}(第 ${attempt}/${最多尝试} 次): ${失败.message}` });
            if (attempt < 最多尝试 && !signal.aborted) {
                const 理由 = 参数.取重试理由(失败);
                报进度(`正在重试（${attempt}/${最多尝试}）：${理由}`);
                console.warn(`[${名字}] ${理由}(第 ${attempt} 次)，正在重试…`);
                await 等(600);
            }
            continue;
        }

        // 校验: 结构不合格 → 原样重试
        try {
            parsed = 校验(parsed);
            break;
        }
        catch (error) {
            失败 = error instanceof Error ? error : Error(String(error));
            const 归属 = 判断错误(失败, '校验');
            if (归属 === '致命')
                throw 失败;
            记日志({ time: Date.now(), error: `${结构失败标签}(第 ${attempt}/${最多尝试} 次): ${失败.message}` });
            if (attempt < 最多尝试 && !signal.aborted) {
                const 理由 = 参数.取重试理由(失败);
                报进度(`正在重试（${attempt}/${最多尝试}）：${理由}`);
                console.warn(`[${名字}] ${理由}(第 ${attempt} 次)，正在重试…`);
                await 等(600);
            }
        }
    }

    if (parsed === null)
        throw 失败 ?? Error('解析失败');
    return { parsed, 请求耗时, 请求次数 };
}

export { 请求并校验 };
export type { 往返参数, 错误归属, 错误阶段 };
