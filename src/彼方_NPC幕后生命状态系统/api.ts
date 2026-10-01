// 接口调用只走一条路: 请求交给酒馆服务器转发(酒馆助手接口的 getModelList / generateRaw /
// stopGenerationById, 都收在 host.ts 里)。以前还有一条"浏览器直接 fetch 接口"的支路,
// 需要自己处理 CORS、自己写流式 SSE 解析、自己按 token 数缩放超时——两条路行为不一致
// (报错文案、超时、中断时机都不同), 已于 2026-09 删除。
// 依赖按实际用到的符号具名导入(形态守卫见 tests/no-bundle-artifacts.test.ts)
import { getSettings } from './settings';
import { useHost } from './host';

function normalizeBaseUrl(url) {
    const trimmed = (url ?? '').trim().replace(/\/+$/, '');
    if (!trimmed)
        return '';
    return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}
/** 请求上下文(脱敏), 附加到错误信息方便排查 */
function requestContext() {
    const { 模型, 最大token } = getSettings().接口;
    return `模型=${模型 || '(未选)'}, 最大token=${最大token}`;
}
/** 检测接口/模型的成人内容政策拦截(如 Google Gemini 的 Prohibited Use policy), 返回友好提示 */
function policyBlockHint(message) {
    return /violat|prohibit|policy|sensitive words|unsupported content|content filter/i.test(message)
        ? '\n(疑似被接口/模型的成人内容政策拦截, 如 Google Gemini 的 Prohibited Use policy——这类服务在请求输入层就会拒绝含敏感词的提示词, 无法靠提示词绕过。可尝试: 关闭「女性NPC生理监测」, 或换用 DeepSeek/GLM/Qwen/Claude 等无此类硬过滤的模型)'
        : '';
}
async function fetchModelList() {
    const { 地址, 密钥 } = getSettings().接口;
    const base = normalizeBaseUrl(地址);
    if (!base)
        throw Error('请先填写接口地址');
    try {
        return await useHost().model.list({ apiurl: base, key: 密钥 });
    }
    catch (error) {
        throw Error('通过酒馆服务器获取模型列表失败, 请检查地址与密钥', { cause: error });
    }
}
/** 接口请求计时包装: 单次请求耗时 + 输入/输出字数, 用于定位"更新慢"的瓶颈(模型生成 vs 本地处理) */
async function chatCompletion(messages, options) {
    const startedAt = Date.now();
    const inputChars = messages.reduce((sum, message) => sum + String(message.content ?? '').length, 0);
    try {
        const content = await chatCompletionInner(messages, options);
        console.info(`[彼方] 接口请求完成: ${((Date.now() - startedAt) / 1000).toFixed(1)}s, 输入${inputChars}字, 输出${content.length}字`);
        return content;
    }
    catch (error) {
        console.warn(`[彼方] 接口请求${error instanceof Error && /中断/.test(error.message) ? '被中断' : '失败'}: ${((Date.now() - startedAt) / 1000).toFixed(1)}s 后结束, ${error instanceof Error ? error.message.split('\n')[0] : error}`);
        throw error;
    }
}
async function chatCompletionInner(messages, options) {
    const baseCfg = getSettings().接口;
    const 地址 = options?.接口?.地址 ?? baseCfg.地址;
    const 密钥 = options?.接口?.密钥 ?? baseCfg.密钥;
    const 模型 = options?.接口?.模型 ?? baseCfg.模型;
    const 温度 = options?.接口?.温度 ?? baseCfg.温度;
    const 最大token = options?.接口?.最大token ?? baseCfg.最大token;
    const 流式 = options?.接口?.流式 ?? baseCfg.流式 ?? false;
    // 展开酒馆骰子宏 {{roll 1d100}} → 真实随机数:
    // generateRaw 不经过酒馆的 substituteParams, 宏不会自动展开,
    // 这里手动替换, 保证受孕判定等需要随机数的场景拿到真实 D100 结果。
    messages = messages.map(message => ({
        ...message,
        content: String(message.content ?? '').replace(/\{\{\s*roll\s+(\d+)d(\d+)\s*\}\}/gi, (_match, count, sides) => {
            let total = 0;
            for (let i = 0; i < +count; i++)
                total += 1 + Math.floor(Math.random() * +sides);
            // 记录骰子结果到彼方日志(供受孕判定等场景回溯"到底投出了多少")
            console.info(`[彼方] 掷骰: ${count}d${sides} = ${total}`);
            return String(total);
        }),
    }));
    const base = normalizeBaseUrl(地址);
    if (!base)
        throw Error('请先填写接口地址');
    if (!模型)
        throw Error('请先选择模型');
    // 最后一条 user 消息作为 user_input 传入, 避免 generateRaw 追加空消息
    let userInput = '';
    const orderedPrompts = messages.map(message => ({
        role: message.role,
        content: message.content,
    }));
    const lastMessage = orderedPrompts[orderedPrompts.length - 1];
    if (lastMessage && lastMessage.role === 'user') {
        userInput = lastMessage.content;
        orderedPrompts.pop();
    }
    // generateRaw 不支持 signal: 用 generation_id + stopGenerationById 取消后台请求,
    // 并用 Promise.race 让"取消信号"立即中断等待(否则要等服务器端请求自然结束, 反馈很慢)
    const generationId = `bifang_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const abortSignal = options?.signal;
    if (abortSignal?.aborted)
        throw Error('用户已中断本次更新');
    const stopHandler = () => {
        try {
            useHost().model.stop(generationId);
        }
        catch {
            // 忽略
        }
    };
    const cancelBlocker = new Promise((_, reject) => {
        if (!abortSignal)
            return;
        abortSignal.addEventListener('abort', () => reject(Error('用户已中断本次更新')), { once: true });
    });
    if (abortSignal)
        abortSignal.addEventListener('abort', stopHandler, { once: true });
    try {
        const result = await Promise.race([
            useHost().model.raw({
                generation_id: generationId,
                user_input: userInput,
                should_silence: true,
                // 流式接收: 上游边生成边返回, 避免长时间无响应触发网关超时(504/499)
                should_stream: 流式,
                max_chat_history: 0,
                custom_api: {
                    apiurl: base,
                    key: 密钥.trim(),
                    model: 模型,
                    source: 'openai',
                    temperature: options?.temperature ?? 温度,
                    max_tokens: options?.max_tokens ?? 最大token,
                },
                ordered_prompts: orderedPrompts,
            }),
            cancelBlocker,
        ]);
        const content = typeof result === 'string' ? result : result?.content ?? '';
        if (!content) {
            throw Error(`响应中没有找到有效的正文内容(${requestContext()})。可能是推理模型把最大输出Token用尽(无正文), 或模型不支持当前参数。请调大「最大输出Token」或更换模型后重试。`);
        }
        return content;
    }
    catch (error) {
        if (abortSignal?.aborted)
            throw Error('用户已中断本次更新', { cause: error });
        if (error instanceof Error && /无法连接到|接口返回错误|响应中|获取模型/.test(error.message))
            throw error;
        // 超时通常是推理模型把时间花在思考上, 或接口负载高: 提示调小最大输出Token或换模型
        if (error instanceof Error && /Gateway|timeout|time-out|超时/i.test(error.message)) {
            throw Error(`生成超时(可能是推理模型的思考时间过长, 或接口负载高)。可调小「最大输出Token」或换更快的模型后重试。原始错误: ${error.message}`, { cause: error });
        }
        const errText = error instanceof Error ? error.message : String(error);
        throw Error(`通过酒馆服务器请求失败(${requestContext()}): ${errText}${policyBlockHint(errText)}`, { cause: error });
    }
    finally {
        if (abortSignal)
            abortSignal.removeEventListener('abort', stopHandler);
    }
}

export { chatCompletion, fetchModelList, normalizeBaseUrl };
