// 烟火 · 正文时间守卫
import { 建立世界时间约束, 提取正文日期, 校验世界时间 } from '../src/烟火_世界运转/时间校验';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  PASS  ${label}`);
  }
  else {
    fail++;
    console.log(`  FAIL  ${label}\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`);
  }
}
function ok(label: string, condition: boolean) {
  check(label, condition, true);
}
function throws(label: string, run: () => void) {
  try {
    run();
    check(label, false, true);
  }
  catch {
    check(label, true, true);
  }
}

console.log('\n[1] 正文绝对日期是硬边界, 不因世界书未来日期放行');
{
  const reply = '【最新回复】\n2025年09月19日·周五·17:47-17:50\n场景继续。';
  const constraint = 建立世界时间约束(reply, '2025年09月22日·周一·上午');
  check('提取正文日期', [constraint.正文日期?.年, constraint.正文日期?.月, constraint.正文日期?.日], [2025, 9, 19]);
  ok('同一天允许', (() => { try { 校验世界时间('2025年09月19日·周五·夜', constraint); return true; } catch { return false; } })());
  throws('未来日期拒绝', () => 校验世界时间('2025年09月23日·周二·清晨', constraint));
}

console.log('\n[2] 正文明确跨越数月时允许跟随新日期');
{
  const reply = '【最新回复】\n几个月后，2025年12月20日，冬至前夕。';
  const constraint = 建立世界时间约束(reply, '2025年09月19日·周五·夜');
  ok('新日期允许', (() => { try { 校验世界时间('2025年12月20日·周六·夜', constraint); return true; } catch { return false; } })());
  throws('仍跳到更晚日期拒绝', () => 校验世界时间('2026年01月02日·周五·清晨', constraint));
}

console.log('\n[3] 只有相对跳跃时按词义范围校验');
{
  const constraint = 建立世界时间约束('【最新回复】\n两周后，村里重新开会。', '2025年09月19日·周五·夜');
  ok('两周后日期允许', (() => { try { 校验世界时间('2025年10月03日·周五·上午', constraint); return true; } catch { return false; } })());
  throws('两周后跳太远拒绝', () => 校验世界时间('2025年12月01日·周一·上午', constraint));
}

console.log('\n[4] 没有时间线索时不得凭空跨日');
{
  const constraint = 建立世界时间约束('【最新回复】\n场景继续，没有日期变化。', '2025年09月19日·周五·夜');
  ok('同一天允许', (() => { try { 校验世界时间('2025年09月19日·周五·深夜', constraint); return true; } catch { return false; } })());
  throws('无依据跨日拒绝', () => 校验世界时间('2025年09月20日·周六·早晨', constraint));
}

console.log('\n[5] 只读取最新回复, 不被旧回复日期污染');
{
  const reply = '【较早回复 1】\n2025年09月18日。\n\n【最新回复】\n2025年09月19日·17:50。';
  const date = 提取正文日期(reply);
  check('取最新正文段日期', [date?.年, date?.月, date?.日], [2025, 9, 19]);
}

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`} (${pass} 项通过)`);
process.exit(fail === 0 ? 0 : 1);
