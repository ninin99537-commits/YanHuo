// 共用 · 楼层标签过滤 —— 剧情导演 / 彼方 / 烟火 各抄一份的"标签过滤"只此一份
// ---------------------------------------------------------------------------
// 三家原来各在各自的 update.ts 里抄了一份同源的 createTextFilter(剥 <tag> 块 / 提 tag 内容 /
// 清孤立闭合标签 / 去 HTML 注释与思维链 begin_of_…end_of_ 整块)。同源、各自演化就是风险:
// 改一处正则(如某次修"孤立闭合标签误删正文")要手动同步三处, 漏一处线上静默错。
// 现在收在这里, 三家各自 update.ts 只留一句 createTextFilter 调用, 行为改动只此一份。
//
// 它不碰平台、不含状态: 纯函数, 输入输出都是字符串与配置, 没有酒馆也能单测。
// 用例见 tests/tag-filter.test.ts(同样一套用例, 覆盖两种模式)。
// ---------------------------------------------------------------------------
//
// 2026-11-10 修: 逐个标签跑 `<tag>…</tag>` 正则会让**一条 stray 开标签**跟很远之后的
// 同名闭标签配成一对, 把中间的一切整段删掉。真机上就是这么被咬的 —— 模型在自己的思考区里
// 举例写了 "正文结束后依次输出 `<branches>"(反引号里那个开标签没有闭合), 于是:
//   ① `branches` 从思考区里的那个 `<branches>` 一路吃到几十行后真正的 `</branches>`,
//      中间夹着的 `</think_nya>`、`<time_format>`、`<game>` 正文、`<image>` 全被一起删掉;
//   ② 轮到 `think_nya` 时, 它的闭标签已经躺在被删掉的区间里 → 只剩开标签, 只删标签本身,
//      **思考区的上万字原样留下**, 于是"思维链没排除、正文反而没了"。
// 现在改成一次扫描 + 栈式配对(按**嵌套**语义): 闭标签配对后, 它内部那些没闭合的开标签
// 随块一起作废, 再也不会反过来吃掉外层的正文; 重叠的块不会再出现。

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

/** 标签名边界: 排除 ASCII 字母/数字/下划线/连字符 —— \b 只对 ASCII 有效, 中文标签需自定边界;
 *  必须排除 _ 和 -, 否则标签 "summary" 会误匹配 "<summary_format>", 导致该块被误删。 */
const 名边界 = '(?![a-zA-Z0-9_-])';

/**
 * 归一: 去空白与尖括号、去尾部装饰波浪号、去重、长名优先(不让 "think" 抢在 "think_nya" 前面)。
 *
 * 尾部 `~` 一律当装饰剥掉: 有的卡写的是 `<think_nya~>`(喵系语气), 那波浪号不是名字的一部分。
 * 归一到同一个名字之后, 名字比较是精确的 —— 于是"一边带波浪号、一边不带"的开闭标签也能配上对
 * (旧版逐标签跑正则时, `think_nya~` 那条只会去找 `</think_nya~>`, 配不上就漏); 而 `<think_nya~>`
 * 这种写法本身靠下面正则里的 `[^>]*` 吞掉装饰符, 照样命中。
 */
function 归一标签(列表: string[] | undefined): string[] {
  const 名 = new Set<string>();
  for (const raw of 列表 ?? []) {
    const name = String(raw ?? '').trim().replace(/^<|>$/g, '').replace(/~+$/, '').trim();
    if (name)
      名.add(name);
  }
  return [...名].sort((a, b) => b.length - a.length);
}

/** 文本里的一处标签点 */
type 标签点 = { 名: string; 起: number; 止: number };

/** 一处成对块: [起,止) 是含标签的整段, [内容起,内容止) 是块内正文 */
type 标签块 = 标签点 & { 内容起: number; 内容止: number };

/** 被排除的区间 */
type 区间 = { 起: number; 止: number };

/**
 * 一次扫描, 按**嵌套**语义把标签点配对:
 *   - 闭标签与"栈里最近的同名开标签"配对 → 中间的未闭合开标签全部作废(它们在这个块内部,
 *     跟着块一起消失, 不许再去配后面的闭标签);
 *   - 配不上对的开标签 / 孤立闭标签 / 自闭合标签 → 只删标签本身, **绝不从标签删到别处**
 *     (否则正文里一个残留的 `</summary_format>` 就能把整段正文吃掉)。
 */
function 扫描标签(text: string, tags: string[]): { 块: 标签块[]; 单标签: 区间[] } {
  const 块: 标签块[] = [];
  const 单标签: 区间[] = [];
  if (tags.length === 0)
    return { 块, 单标签 };
  const re = new RegExp(`<(\\/?)(${tags.map(escapeRegExp).join('|')})${名边界}[^>]*?(\\/?)>`, 'gi');
  const 规范名 = new Map(tags.map(name => [name.toLowerCase(), name]));
  const 开栈: 标签点[] = [];
  for (const match of text.matchAll(re)) {
    const 名 = 规范名.get((match[2] ?? '').toLowerCase()) ?? match[2];
    const 起 = match.index ?? 0;
    const 止 = 起 + match[0].length;
    if (match[1] === '/') {
      // 闭标签: 找栈里最近的同名开标签; 找不到就是孤立闭合 → 只删自身
      let at = -1;
      for (let i = 开栈.length - 1; i >= 0; i--) {
        if (开栈[i].名.toLowerCase() === 名.toLowerCase()) {
          at = i;
          break;
        }
      }
      if (at < 0) {
        单标签.push({ 起, 止 });
        continue;
      }
      const open = 开栈[at];
      块.push({ 名: open.名, 起: open.起, 止, 内容起: open.止, 内容止: 起 });
      开栈.length = at; // 块内部的未闭合开标签作废
      continue;
    }
    if (match[3] === '/') {
      单标签.push({ 起, 止 }); // <foo/> 只删标签自身
      continue;
    }
    开栈.push({ 名, 起, 止 });
  }
  for (const open of 开栈)
    单标签.push({ 起: open.起, 止: open.止 }); // 全文都没闭合的开标签: 只删标签自身
  return { 块, 单标签 };
}

/** 区间合并(嵌套块会重叠: 内层块整个落在外层块里) */
function 合并区间(区间表: 区间[]): 区间[] {
  const 有序 = [...区间表].sort((a, b) => a.起 - b.起 || a.止 - b.止);
  const 结果: 区间[] = [];
  for (const 区间 of 有序) {
    const 末 = 结果[结果.length - 1];
    if (末 && 区间.起 <= 末.止)
      末.止 = Math.max(末.止, 区间.止);
    else
      结果.push({ ...区间 });
  }
  return 结果;
}

/** 按区间删除(从后往前切, 下标不会错位) */
function 删区间(text: string, 区间表: 区间[]): string {
  const 有序 = 合并区间(区间表);
  let 结果 = text;
  for (let i = 有序.length - 1; i >= 0; i--) {
    const { 起, 止 } = 有序[i];
    结果 = 结果.slice(0, 起) + 结果.slice(止);
  }
  return 结果;
}

/**
 * 创建一个"按设置过滤楼层正文"的函数:
 *   - 「排除」模式: 剥掉 列表 里每个标签的成对块/自闭合/孤立闭合/未闭合开标签, 保留其余正文;
 *   - 「只读」模式: 只取 列表 里各标签块的内容拼接(按标签列表顺序), 无内容时回退整段原文;
 *   - 无论哪种模式: 都把 思维链 begin_of_X…end_of_X 整块与其余 HTML 注释删掉。
 */
export function createTextFilter(settings: 标签过滤配置 = {}): (text: string) => string {
  const config = settings ?? {};
  const tags = 归一标签(config.列表);
  // 思维链 begin_of_X ... end_of_X 是注释标记、内容却是纯文本, 连内容一起删; 再清理剩余 HTML 注释
  // (正文里的创作注释如 <!-- 模拟段落 --> / <!-- 草稿优化 --> 等一律删除, 无论何种模式)
  const stripComments = (text: string) =>
    text
      .replace(/<!--\s*begin_of_[a-zA-Z0-9_\u4e00-\u9fa5]+[\s\S]*?end_of_[a-zA-Z0-9_\u4e00-\u9fa5]+\s*-->/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
  if (tags.length === 0) return stripComments;
  if (config.模式 === '只读') {
    return text => {
      const { 块 } = 扫描标签(text, tags);
      const 小写 = new Map(tags.map(name => [name.toLowerCase(), name]));
      const parts: string[] = [];
      for (const tag of tags) {
        for (const 块项 of 块) {
          if (小写.get(块项.名.toLowerCase()) !== tag)
            continue;
          parts.push(text.slice(块项.内容起, 块项.内容止).trim());
        }
      }
      return stripComments(parts.filter(Boolean).join('\n\n') || text);
    };
  }
  return text => {
    const { 块, 单标签 } = 扫描标签(text, tags);
    return stripComments(删区间(text, [...块, ...单标签]));
  };
}
