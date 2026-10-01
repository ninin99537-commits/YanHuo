// 接口调用只走一条路: 请求交给酒馆服务器转发(酒馆助手接口的 getModelList / generateRaw /
// stopGenerationById, 都收在 host.ts 里)。以前还有一条"浏览器直接 fetch 接口"的支路, 需要
// 自己处理 CORS、自己写流式 SSE 解析、自己按固定 120 秒掐超时——两条路行为不一致(报错文案、
// 超时、中断时机都不同), 已于 2026-10 删除, 顺带删掉了那个"要不要走转发"的开关: 转发不再是
// "接口不支持 CORS 时才开"的选项, 而是唯一的通路。老设置里残留的同名字段由 schema 忽略
// (不会报错), 也不再影响任何请求形状。
import { useHost } from './host';
import { getSettings } from './settings';

export function normalizeBaseUrl(url: string): string {
  const trimmed = (url ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** 脱敏接口地址(隐藏地址中可能携带的 token/key 查询参数), 用于错误日志 */
export function maskBaseUrl(url: string): string {
  const value = String(url || '').trim();
  return value.replace(/([?&](?:key|token|api_key|apiKey|apikey)=)[^&]*/gi, '$1***');
}

/** 请求上下文(脱敏), 附加到错误信息方便排查 */
function requestContext(): string {
  // 以前这里还会打印"转发=开/关", 开关删掉后没有这个字段可读了
  const { 模型, 最大token } = getSettings().接口;
  return `模型=${模型 || '(未选)'}, 最大token=${最大token}`;
}

/** 检测接口/模型的内容政策拦截, 返回友好提示 */
function policyBlockHint(message: string): string {
  return /violat|prohibit|policy|sensitive words|unsupported content|content filter/i.test(message)
    ? '\n(疑似被接口/模型的内容政策拦截——这类服务在请求输入层就会拒绝部分提示词, 可尝试换用其他模型)'
    : '';
}

export async function fetchModelList(): Promise<string[]> {
  const { 地址, 密钥 } = getSettings().接口;
  const base = normalizeBaseUrl(地址);
  if (!base) throw Error('请先填写接口地址');
  // 取模型列表一律交给酒馆服务器转发(绕开浏览器跨域, 本插件只有这一条通路)
  try {
    return await useHost().model.list({ apiurl: base, key: 密钥 });
  } catch (error) {
    throw Error('通过酒馆服务器获取模型列表失败, 请检查地址与密钥', { cause: error });
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
  temperature?: number;
  max_tokens?: number;
}

export async function chatCompletion(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
  const baseCfg = getSettings().接口;
  const 地址 = baseCfg.地址;
  const 密钥 = baseCfg.密钥;
  const 模型 = baseCfg.模型;
  const 温度 = options.temperature ?? baseCfg.温度;
  const 最大token = options.max_tokens ?? baseCfg.最大token;
  const 流式 = baseCfg.流式 ?? false;

  const base = normalizeBaseUrl(地址);
  if (!base) throw Error('请先填写接口地址');
  if (!模型) throw Error('请先选择模型');

  // 请求一律交给酒馆服务器转发(绕开浏览器跨域, 本插件只有这一条通路)
  // 最后一条 user 消息作为 user_input 传入, 避免 generateRaw 追加空消息
  let userInput = '';
  const orderedPrompts = messages.map(message => ({ role: message.role, content: message.content }));
  const lastMessage = orderedPrompts[orderedPrompts.length - 1];
  if (lastMessage && lastMessage.role === 'user') {
    userInput = lastMessage.content;
    orderedPrompts.pop();
  }
  // generateRaw 不支持 signal: 用 generation_id + stopGenerationById 取消后台请求,
  // 并用 Promise.race 让"取消信号"立即中断等待
  const generationId = `yanhuo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const abortSignal = options.signal;
  if (abortSignal?.aborted) throw Error('用户已中断本次推进');
  const stopHandler = () => {
    try {
      useHost().model.stop(generationId);
    } catch {
      // 忽略
    }
  };
  const cancelBlocker = new Promise<never>((_, reject) => {
    if (!abortSignal) return;
    abortSignal.addEventListener('abort', () => reject(Error('用户已中断本次推进')), { once: true });
  });
  if (abortSignal) abortSignal.addEventListener('abort', stopHandler, { once: true });
  try {
    const result = await Promise.race([
      useHost().model.raw({
        generation_id: generationId,
        user_input: userInput,
        should_silence: true,
        should_stream: 流式,
        max_chat_history: 0,
        custom_api: {
          apiurl: base,
          key: 密钥.trim(),
          model: 模型,
          // 历史残留的开关已删除: 请求固定按 OpenAI 兼容格式发出, 不再切换 source、不再附自定义请求体
          // (老设置里残留的字段由 schema 忽略, 不会报错)
          source: 'openai',
          temperature: 温度,
          max_tokens: 最大token,
        },
        ordered_prompts: orderedPrompts,
      }),
      cancelBlocker,
    ]);
    const content = typeof result === 'string' ? result : (result as { content?: string })?.content ?? '';
    if (!content) {
      throw Error(`响应中没有找到有效的正文内容(${requestContext()})。可能是推理模型把最大输出Token用尽(无正文), 或模型不支持当前参数。请调大「最大输出Token」或更换模型后重试。`);
    }
    return content;
  } catch (error) {
    if (abortSignal?.aborted) throw Error('用户已中断本次推进', { cause: error });
    if (error instanceof Error && /无法连接到|接口返回错误|响应中|获取模型/.test(error.message)) throw error;
    if (error instanceof Error && /Gateway|timeout|time-out|超时/i.test(error.message)) {
      throw Error(`生成超时(可能是模型思维链/推理过长或接口负载高)。调小「最大输出Token」后重试。原始错误: ${error.message}`, { cause: error });
    }
    const errText = error instanceof Error ? error.message : String(error);
    throw Error(`通过酒馆服务器请求失败(${requestContext()}): ${errText}${policyBlockHint(errText)}`, { cause: error });
  } finally {
    if (abortSignal) abortSignal.removeEventListener('abort', stopHandler);
  }
}
