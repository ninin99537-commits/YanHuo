// 共用 · 世界书排除名单 —— 彼方 / 剧情导演 / 烟火 三家**同一套判定、同一套输入解析**
// ---------------------------------------------------------------------------
// 原来三家各写一份 isExcluded: 语义本来就一致(标题/备注包含即命中), 但各自演化; 输入那边更乱 ——
// 一家按"换行 + 半角逗号 + 全角逗号 + 顿号 + 空白"切, 一家只按逗号切, 一家按"逗号 + 顿号 + 空白"切,
// 于是同一份名单换个插件就得换个写法。现在两件事都收在这里:
//
//   解析名单(text)   —— **只认换行**: 逗号、顿号、分号统统当内容的一部分, 名字里有标点也不会被切开;
//   命中排除(条目, 名单) —— 标题/备注里**含这些字**就排除(不分大小写), 填一条 "[mvu_update]"
//                          就能挡掉 [mvu_update]1、[mvu_update]2…, 不用一条条写全名。
//
// 两个刻意的边界:
//   - **内容开头也参与匹配**: 条目名不可靠时(激活数据里可能只有 comment、没有 name)靠正文开头的标记
//     认自己写的条目, 如 "[彼方 · 幕后NPC状态]" / "[烟火 · 世界动向]" / "[剧情导演 · 编剧备忘]";
//   - **不匹配关键词(keys)**: 关键词多是角色名, 用它做排除会连带挡掉一大片人设条目 —— 要排某条, 写标题。
// 用例见 tests/worldbook-exclude.test.ts。

/**
 * 判定只需要条目上的这四个字段, 就在本地声明这四个 —— 不引用各家的完整条目类型:
 * `src/共用/` 不依赖任何一家插件, 反向 import 会让共用层绑死在彼方身上。
 *
 * `name` 与 `comment` 都要: 酒馆原生条目把显示名放在 `comment`(改名后 name 还是旧名),
 * 而主 AI 激活数据里可能只有 `name`; `key` 在两者都缺时兜底(见 条目标签)。
 * 四字段全可选: 调用方传进来的激活数据/世界书条目本来就可能缺字段。
 */
interface 排除条目形状 {
  name?: string;
  comment?: string;
  content?: string;
  key?: string | string[];
  /** 各家写入时打的归属标记（`extra.bifang` / `extra.yanhuo` / `extra.daoyan`） */
  extra?: Record<string, unknown>;
}

/**
 * 三家的世界书条目身份 —— **"别把别家的推演结论当设定读进来"**（2026-11-23）。
 *
 * ── 为什么需要 ──
 *
 *  三家都会往角色卡主世界书写一条常驻条目（彼方=NPC 状态卡、烟火=世界动向、导演=编剧备忘）。
 *  而"读世界书"走的是主 AI 的激活机制，**蓝灯常驻条目一定在里面** ——
 *  于是一家读世界书时，会读到**另外两家上一轮的输出**，把它当成世界设定。
 *  那是推演结果，不是设定；当设定用就是自我反馈。
 *
 * ── 为什么按标记认，不按名字子串 ──
 *
 *  名字会被用户改；子串匹配还会误伤（写"烟火"就排掉"烟火节的传说"）。
 *  三家写入时都打了稳定标记，条目名/正文开头只作兜底。
 *  烟火的正文**没有**固定前缀（`buildInjectionPrompt` 直接出内容），所以它只有标记 + 条目名。
 */
const 各家身份 = [
  { 家: '彼方', 正文开头: '[彼方 · 幕后NPC状态]', 条目名: '【彼方】NPC幕后生活', 标记: 'bifang' },
  { 家: '烟火', 正文开头: null, 条目名: '【烟火】世界动向', 标记: 'yanhuo' },
  { 家: '剧情导演', 正文开头: '[剧情导演 · 编剧备忘]', 条目名: '【剧情导演】编剧备忘', 标记: 'daoyan' },
] as const;

/** 这条条目是不是**别的插件**写的（不是本家）。`本家` 传自己那一家的名字。 */
export function 是别的插件条目(entry: 排除条目形状 | null | undefined, 本家: string): boolean {
  if (!entry)
    return false;
  const 名 = String(entry.name ?? '').trim();
  const 备注 = String(entry.comment ?? '').trim();
  const 内容 = String(entry.content ?? '').trim();
  for (const 家 of 各家身份) {
    if (家.家 === 本家)
      continue;
    if (entry.extra?.[家.标记] === true)
      return true;
    if (名 === 家.条目名 || 备注 === 家.条目名)
      return true;
    if (家.正文开头 && 内容.startsWith(家.正文开头))
      return true;
  }
  return false;
}

/**
 * 把设置里那段文本切成名单: **只按换行**切, 每行 trim, 空行丢掉。
 * 逗号 `,` `，`、顿号 `、`、分号 `;` `；` 都是内容的一部分 —— 条目名里本来就可能带这些字符,
 * 以前按它们切会把一个名字切成几条, 于是"排除不生效"又找不出原因。
 */
export function 解析名单(text: string): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

/** 名单里任意一串出现在条目的标题/备注里(不分大小写), 或条目内容以它开头 → 排除 */
export function 命中排除(entry: 排除条目形状 | null | undefined, excludes: string[]): boolean {
  if (!entry || !Array.isArray(excludes) || excludes.length === 0)
    return false;
  const 名 = String(entry.name ?? '').trim().toLowerCase();
  const 备注 = String(entry.comment ?? '').trim().toLowerCase();
  const 内容 = String(entry.content ?? '').trim().toLowerCase();
  return excludes.some((item: string) => {
    const 词 = String(item ?? '').trim().toLowerCase();
    if (!词)
      return false;
    return (名 !== '' && 名.includes(词))
      || (备注 !== '' && 备注.includes(词))
      || (内容 !== '' && 内容.startsWith(词));
  });
}

/** 条目名(给人看的): 主 AI 激活数据在 comment/key, getWorldbook 在 name */
export function 条目标签(entry: 排除条目形状 | null | undefined): string {
  return (typeof entry?.comment === 'string' && entry.comment)
    || (typeof entry?.name === 'string' && entry.name)
    || (entry?.key ? (Array.isArray(entry.key) ? entry.key.join('、') : String(entry.key)) : '')
    || '(未命名条目)';
}

/**
 * 日志用的一句话: `排除条目挡掉 3 条([mvu_update]1、[mvu_update]2…)`(不带前后分隔符, 各家自己接)。
 * 一条都没挡到就返回空串, 不往日志里塞噪音 —— 但"挡到了却不吭声"同样不行:
 * 排除名单静默失效时, 用户只能看着一堆条目被发出去还以为是别的原因。
 */
export function 排除说明(挡掉: string[], 最多 = 3): string {
  if (!Array.isArray(挡掉) || 挡掉.length === 0)
    return '';
  const 举例 = 挡掉.slice(0, 最多).join('、');
  return `排除条目挡掉 ${挡掉.length} 条(${举例}${挡掉.length > 最多 ? '…' : ''})`;
}
