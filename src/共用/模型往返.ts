// 共用 · 模型往返 —— 「发请求 → 解析 → 校验 → 不合格就带着错误原因重试」只此一份
// ---------------------------------------------------------------------------
// 彼方与烟火各有一段这样的循环, 连重试节奏(接口错等 2s×次数、结构错等 0.6s)、回喂文案
// (【上次输出不符合要求…】+ 上次输出的 JSON 片段)、预填充 '{' 的拼回、中断文案的处理,
// 两边都一字不差 —— 差别只有四件事:
//   - 解析: 两边切 JSON 候选/剥离思考字段的细节不同(烟火还要挑「世界推进」载荷), 各自传进来;
//   - 校验: 结构不合格时抛错, 抛什么错由各自决定;
//   - 错误分类: 彼方把"不是 JSON"也当可回喂的错误(带着原因重试), 烟火当致命错误当场抛出;
//   - 文案: 名字(彼方/烟火)、失败记录里的阶段名(更新失败/推进失败)、给用户看的重试理由。
// 除了这几件, 其余全在这儿: 改一次重试策略, 两边同时生效。
//
// 它不碰平台: 发请求 / 记日志 / 报进度 都是参数(与两边各自的 host 接缝接得上), 所以没有平台也能测。
// ---------------------------------------------------------------------------

/** 失败发生在哪一步 */
type 错误阶段 = '请求' | '解析' | '校验';
/** 一次失败怎么处理: 接口错=没有有效输出可回喂, 等久一点直接重试; 反馈=有输出, 带着原因回喂; 致命=当场抛出 */
type 错误归属 = '接口' | '反馈' | '致命';

type 往返参数 = {
    /** 基础消息(不含错误反馈); 反馈只接到"任务 user 消息"上, 不动尾部 */
    messages: any[];
    /** 任务 user 消息在 messages 里的位置(提示词形状自己声明的锚点) */
    锚点?: { 任务下标: number };
    /** 或者现场找任务消息(烟火那边是按收尾文案反查); 返回 -1 表示找不到, 退化成追加到末尾 */
    找任务下标?: (messages: any[]) => number;
    /** 设置里的"预填充": 末位补一条 assistant '{' 引导模型直接从 JSON 开始 */
    预填充: boolean;
    signal: AbortSignal;
    /** 真正发请求(线上是各自 api.ts 的 chatCompletion) */
    发请求: (messages: any[], options: { signal: AbortSignal }) => Promise<string>;
    /** 把原始输出解析成对象; 解析不了就抛错 */
    解析: (content: string) => any;
    /** 校验并规范化; 不合格就抛错(错误信息会被回喂给 AI) */
    校验: (parsed: any) => any;
    /** 只取输出里的 JSON 部分用于回喂(不带思维链/正文等杂质) */
    取JSON片段?: (content: string) => string;
    /** 错误分类(默认: 请求=接口, 解析/校验=反馈) */
    判断错误?: (error: Error, 阶段: 错误阶段) => 错误归属;
    /** 日志与提示里的名字, 如 '彼方' / '烟火' */
    名字: string;
    /** 结构失败记进日志时的阶段名, 如 '更新失败' / '推进失败' */
    结构失败标签: string;
    /** 由错误信息推出"给用户看的重试理由"(两边文案不同, 各自传) */
    取重试理由: (error: Error) => string;
    /** 用户中断时的错误文案, 如 '用户已中断本次更新' / '用户已中断本次推进' */
    中断文案: string;
    /** 写日志页(线上是 debugStore.record) */
    记日志: (记录: any) => void;
    /** 报进度(线上是 updatingStore.message = 文字) */
    报进度: (文字: string) => void;
};

const 最多尝试 = 3;
/** 回喂给 AI 的错误反馈: 接在任务 user 消息后面 */
function 反馈文本(原因: string, 上次输出: string): string {
    return `【上次输出不符合要求, 请根据错误原因修正后重新输出】\n错误原因: ${原因}\n上次输出(仅 JSON 部分):\n\`\`\`json\n${上次输出}\n\`\`\``;
}
/** 组装本次要发的消息: 把反馈接到任务 user 消息上, 保留尾部(破限的 SPECIAL NOTE 与承诺) */
function 带反馈(messages: any[], 任务下标: number, 原因: string, 上次输出: string): any[] {
    const 反馈 = 反馈文本(原因, 上次输出);
    if (任务下标 >= 0 && 任务下标 < messages.length) {
        return [
            ...messages.slice(0, 任务下标),
            { role: 'user', content: `${messages[任务下标].content}\n\n${反馈}` },
            ...messages.slice(任务下标 + 1),
        ];
    }
    // 兜底(内置形状必有任务 user, 正常情况下走不到这里)
    return [...messages, { role: 'user', content: 反馈 }];
}
const 等 = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function 请求并校验(参数: 往返参数): Promise<{ parsed: any; 请求耗时: number; 请求次数: number }> {
    const { messages, 锚点, 找任务下标, 预填充, signal, 发请求, 解析, 校验, 名字, 结构失败标签, 中断文案, 记日志, 报进度 } = 参数;
    const 判断错误 = 参数.判断错误 ?? ((_error: Error, 阶段: 错误阶段) => (阶段 === '请求' ? '接口' : '反馈'));
    const 取JSON片段 = 参数.取JSON片段 ?? ((content: string) => content);
    let parsed: any = null;
    let 失败: Error | null = null;
    let 上次原因 = '';
    let 上次输出 = '';
    let 请求耗时 = 0;
    let 请求次数 = 0;

    for (let attempt = 1; attempt <= 最多尝试; attempt++) {
        const 任务下标 = 找任务下标 ? 找任务下标(messages) : (锚点 ? 锚点.任务下标 : -1);
        const attemptMessages = attempt === 1 || !上次输出
            ? [...messages]
            : 带反馈(messages, 任务下标, 上次原因, 上次输出);
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
            上次原因 = 失败.message;
            上次输出 = '';
            记日志({ time: Date.now(), error: `接口调用失败(第 ${attempt}/${最多尝试} 次): ${失败.message}` });
            if (attempt < 最多尝试 && !signal.aborted) {
                报进度(`接口调用失败，正在重试（${attempt}/${最多尝试}）…`);
                console.warn(`[${名字}] 接口调用失败(第 ${attempt} 次), 正在重试…:`, 失败.message);
                await 等(2000 * attempt);
            }
            continue;
        }

        // 解析: 失败按 判断错误 的归属决定是回喂重试还是当场抛出
        try {
            parsed = 解析(content);
        }
        catch (error) {
            失败 = error instanceof Error ? error : Error(String(error));
            const 归属 = 判断错误(失败, '解析');
            if (归属 === '致命' || 归属 === '接口')
                throw 失败;
            上次原因 = 失败.message;
            上次输出 = 取片段(取JSON片段, content);
            记日志({ time: Date.now(), error: `${结构失败标签}(第 ${attempt}/${最多尝试} 次): ${失败.message}` });
            if (attempt < 最多尝试 && !signal.aborted) {
                const 理由 = 参数.取重试理由(失败);
                报进度(`正在重试（${attempt}/${最多尝试}）：${理由}`);
                console.warn(`[${名字}] ${理由}(第 ${attempt} 次)，正在重试…`);
                await 等(600);
            }
            continue;
        }

        // 校验: 结构不合格 = 有输出可回喂, 带着原因重试
        try {
            parsed = 校验(parsed);
            break;
        }
        catch (error) {
            失败 = error instanceof Error ? error : Error(String(error));
            const 归属 = 判断错误(失败, '校验');
            if (归属 === '致命')
                throw 失败;
            上次原因 = 失败.message;
            上次输出 = 取片段(取JSON片段, content);
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

/** 只回喂 JSON 部分; 取不到时给一句说明(和两边原来的写法一致) */
function 取片段(取JSON片段: (content: string) => string, content: string): string {
    const 片段 = 取JSON片段(content);
    if (!片段)
        return '（上次输出中未找到可解析的 JSON 结构）';
    return 片段.length > 3000 ? `${片段.slice(0, 3000)}\n…(过长已截断)` : 片段;
}

export { 请求并校验 };
export type { 往返参数, 错误归属, 错误阶段 };
