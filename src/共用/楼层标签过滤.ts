// 共用 · 楼层标签过滤 —— 剧情导演 / 彼方 / 烟火 各抄一份的"标签过滤"只此一份
// ---------------------------------------------------------------------------
// 三家原来各在各自的 update.ts 里抄了一份同源的 createTextFilter(剥 <tag> 块 / 提 tag 内容 /
// 清孤立闭合标签 / 去 HTML 注释与思维链 begin_of_…end_of_ 整块)。同源、各自演化就是风险:
// 改一处正则(如某次修"孤立闭合标签误删正文")要手动同步三处, 漏一处线上静默错。
// 现在收在这里, 三家各自 update.ts 只留一句 createTextFilter 调用, 行为改动只此一份。
//
// 它不碰平台、不含状态: 纯函数, 输入输出都是字符串与配置, 没有酒馆也能单测。
// 三家现行行为核对过完全一致(排除/只读两种模式、标签名归一、思考链 comment 块、边界正则),
// 除彼方是宽松 JS 写法、另两家是 TS, 语义逐条一致 —— 这里照 烟火/剧情导演 那份精炼写法统一。
// 用例见 tests/tag-filter.test.ts(同样一套用例, 覆盖三种配置形状)。
// ---------------------------------------------------------------------------

/** 标签过滤的配置(三家 settings.标签 的公共形状; 彼方走可选链, 这里按可缺省声明) */
export interface 标签过滤配置 {
  /** 模式: 「排除」= 剥掉这些标签的块; 「只读」= 只取这些标签的内容(默认排除) */
  模式?: '排除' | '只读';
  /** 要处理的标签名列表(可带或不带尖括号, 内部会归一) */
  列表?: string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTagContent(text: string, tag: string): string {
  const escaped = escapeRegExp(tag);
  // 边界排除 ASCII 字母/数字/下划线/连字符: \b 只对 ASCII 有效, 中文标签需自定边界;
  // 必须排除 _ 和 -, 否则标签 "summary" 会误匹配 "<summary_format>", 导致该块被误删。
  const boundary = '(?![a-zA-Z0-9_-])';
  let result = text.replace(new RegExp(`<${escaped}${boundary}[^>]*>[\\s\\S]*?<\\/${escaped}>`, 'gi'), '');
  result = result.replace(new RegExp(`<${escaped}${boundary}[^>]*\\/?>`, 'gi'), '');
  return result;
}

function extractTagContent(text: string, tag: string): string[] {
  const escaped = escapeRegExp(tag);
  const boundary = '(?![a-zA-Z0-9_-])';
  const matches: string[] = [];
  const re = new RegExp(`<${escaped}${boundary}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'gi');
  for (const match of text.matchAll(re)) matches.push(match[1].trim());
  return matches;
}

/**
 * 清除"孤立闭合标签"(只有 </tag> 没有配对 <tag> 的残留)。
 * **只删除闭合标签本身, 绝不从文本开头删到它**——否则正文里若出现某个过滤标签的
 * 孤立闭合(如模型残留 </summary_format> 或正文合法出现的 </xxx>), 会把整段正文删光。
 */
function stripLoneClosingBlocks(text: string, tag: string): string {
  const escaped = escapeRegExp(tag);
  const boundary = '(?![a-zA-Z0-9_-])';
  const closeRe = new RegExp(`</${escaped}${boundary}[^>]*>`, 'gi');
  return text.replace(closeRe, '');
}

/**
 * 创建一个"按设置过滤楼层正文"的函数:
 *   - 「排除」模式: 剥掉 列表 里每个标签的成对块/自闭合/孤立闭合, 保留其余正文;
 *   - 「只读」模式: 只取 列表 里各标签块的内容拼接, 无内容时回退整段原文;
 *   - 无论哪种模式: 都把 思维链 begin_of_X…end_of_X 整块与其余 HTML 注释删掉。
 */
export function createTextFilter(settings: 标签过滤配置 = {}): (text: string) => string {
  const config = settings ?? {};
  const tags = (config.列表 ?? []).map(tag => tag.trim().replace(/^<|>$/g, '')).filter(Boolean);
  // 思维链 begin_of_X ... end_of_X 是注释标记、内容却是纯文本, 连内容一起删; 再清理剩余 HTML 注释
  // (正文里的创作注释如 <!-- 模拟段落 --> / <!-- 草稿优化 --> 等一律删除, 无论何种模式)
  const stripComments = (text: string) =>
    text
      .replace(/<!--\s*begin_of_[a-zA-Z0-9_\u4e00-\u9fa5]+[\s\S]*?end_of_[a-zA-Z0-9_\u4e00-\u9fa5]+\s*-->/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
  if (tags.length === 0) return stripComments;
  if (config.模式 === '只读') {
    return text => {
      const parts: string[] = [];
      for (const tag of tags) parts.push(...extractTagContent(text, tag));
      return stripComments(parts.join('\n\n') || text);
    };
  }
  return text => stripComments(tags.reduce((acc, tag) => stripLoneClosingBlocks(stripTagContent(acc, tag), tag), text));
}