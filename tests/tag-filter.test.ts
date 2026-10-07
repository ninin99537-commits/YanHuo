// 共用 · 楼层标签过滤(候选一) —— 一份实现, 三家(剧情导演/彼方/烟火)共用。
//
// 用同一份用例把现行行为钉住: 排除/只读两种模式、标签名归一(带不带尖括号)、
// 思维链 begin_of_X…end_of_X 整块与其余 HTML 注释删除、孤立闭合标签只删自身。
// 搬迁前三家各抄一份 createTextFilter(行为一致), 用例照语义写; 搬完仍全绿 = 行为未动。
import { createTextFilter } from '../src/共用/楼层标签过滤';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`);
  }
}

// ---- 配置形状: 协议里列表可带尖括号, 内部归一 ----
function 过滤(模式: '排除' | '只读' | undefined, 列表: string[]) {
  return createTextFilter({ 模式, 列表 });
}

// ---- 1. 排除模式: 剥掉成对块 / 自闭合 / 孤立闭合, 保留其余 ----
{
  const f = 过滤('排除', ['summary']);
  check('排除: 剥成对标签块', f('前 <summary>内容</summary> 后'), '前  后');
  const g = 过滤('排除', ['foo']);
  check('排除: 剩自闭合标签', g('a <foo/> b'), 'a  b');
  check('排除: 边界不误伤带后缀标签', f('<summary>x</summary> <summary_format>keep</summary_format>'), ' <summary_format>keep</summary_format>');
}

// ---- 2. 只读模式: 只取各标签内容拼起来, 无内容回退原文 ----
{
  const f = 过滤('只读', ['note']);
  check('只读: 拼多个标签块', f('a <note>一</note> b <note>二</note> c'), '一\n\n二');
  check('只读: 无匹配回退原文', f('plain text'), 'plain text');
}

// ---- 3. 注释清理: 两种模式都删 begin_of…end_of 整块与其余 HTML 注释 ----
{
  const f = 过滤(undefined, []);
  check('空列表: 只清注释', f('<!--begin_of_思维链-->一堆字<!--end_of_思维链-->正文'), '正文');
  check('空列表: 清普通注释', f('前<!-- 创作注释 -->后'), '前后');
  const g = 过滤('排除', ['tag']);
  check('排除模式也清思维链整块', g('<!--begin_of_reason-->深层<!--end_of_reason--><tag>x</tag>正文'), '正文');
}

// ---- 4. 孤立闭合标签: 只删闭合标签自身, 不清掉后面的正文 ----
{
  const f = 过滤('排除', ['summary_format']);
  check('孤立闭合: 只删闭合自身', f('正文 </summary_format> 剩下'), '正文  剩下');
}

// ---- 5. 归一: 带尖括号的标签名会被剥尖括号 ----
{
  const f = 过滤('排除', ['<note>']);
  check('带尖括号标签名也能匹配', f('<note>abc</note> x'), ' x');
}

console.log(fail === 0 ? `\n楼层标签过滤: 全部通过 (${pass} 断言)` : `\n楼层标签过滤: ${fail} 失败, ${pass} 通过`);
process.exit(fail === 0 ? 0 : 1);