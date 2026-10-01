// 彼方 · 用例总入口(对应 `pnpm test`)
//
// 做三件事: 把 tests/*.test.ts 逐个打包成 node 能直接跑的 .mjs → 各自跑一遍 → 汇总结果。
// 用例用 stdio:'inherit' 直接往终端印东西, 不走管道(既省事, 也不受"不能开命名管道"的限制)。
//
// 用例里 import 的是**真实源码**(src/ 下的原文件), 不是复制品:
// 打包器只是去掉类型、把 `?raw` 还原成文本, 没有替换任何逻辑。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, buildTest } from './build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '.build');
mkdirSync(OUT_DIR, { recursive: true });

const files = readdirSync(HERE).filter(name => name.endsWith('.test.ts')).sort();
if (files.length === 0) {
  console.error('tests/ 下没有找到任何 *.test.ts');
  process.exit(1);
}

let failed = 0;
for (const name of files) {
  console.log(`\n===== ${name} =====`);
  const outfile = path.join(OUT_DIR, name.replace(/\.ts$/, '.mjs'));
  try {
    await buildTest(path.join(HERE, name), outfile);
  }
  catch {
    console.error(`  打包失败: ${name}`);
    failed++;
    continue;
  }
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: ROOT });
  if (result.status !== 0)
    failed++;
}

// 候选4 的验收线: 平台调用必须全部收在 host.ts(只有它允许直接命名酒馆全局)。
// 放在最后跑, 所以前面用例的具体报错不会被它挤掉。
console.log('\n===== 平台直连检查 =====');
const 检查 = spawnSync(process.execPath, [path.join(HERE, 'platform-usage.mjs'), '--check'], { stdio: 'inherit', cwd: ROOT });
if (检查.status !== 0)
  failed++;

console.log(failed === 0
  ? `\n全部通过: ${files.length} 个用例文件`
  : `\n有 ${failed} 项失败(共 ${files.length} 个用例文件)`);
process.exit(failed === 0 ? 0 : 1);
