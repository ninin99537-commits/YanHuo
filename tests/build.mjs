// 彼方 · 测试打包器(esbuild JS API)
//
// 为什么不用 esbuild 命令行 —— 两个坑:
//  1. 源码里有 `import x from './y.txt?raw'`(webpack raw-loader 的写法), 命令行会把 `?raw`
//     当成文件名的一部分, 于是找不到文件; 这里用插件把它还原成"读成字符串"。
//  2. 本项目没把 esbuild 作为直接依赖(npx 现取), 所以下面要自己把它找出来。
//
// 用法: pnpm test   —— 走 run.mjs 跑全部用例
//       node tests/build.mjs <入口.ts> <输出.mjs>   —— 只打包一个
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));

/** 依次在: 直接依赖 → pnpm 的 .pnpm → npx 下载缓存 里找 esbuild */
function loadEsbuild() {
  try {
    return require('esbuild');
  }
  catch {}
  const pnpmDir = path.join(ROOT, 'node_modules/.pnpm');
  if (existsSync(pnpmDir)) {
    for (const name of readdirSync(pnpmDir)) {
      if (!name.startsWith('esbuild@'))
        continue;
      const pkg = path.join(pnpmDir, name, 'node_modules/esbuild');
      if (existsSync(path.join(pkg, 'lib/main.js')))
        return require(pkg);
    }
  }
  const npxDir = path.join(process.env.LOCALAPPDATA ?? '', 'npm-cache/_npx');
  if (existsSync(npxDir)) {
    for (const name of readdirSync(npxDir)) {
      const pkg = path.join(npxDir, name, 'node_modules/esbuild');
      if (existsSync(path.join(pkg, 'lib/main.js')))
        return require(pkg);
    }
  }
  throw new Error('找不到 esbuild。先跑一次 `npx esbuild --version` 让它下载到缓存, 再重试。');
}

const rawLoader = {
  name: 'raw-loader',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, args => ({
      path: path.resolve(path.dirname(args.importer), args.path.replace(/\?raw$/, '')),
      namespace: 'raw',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

async function buildTest(entry, outfile) {
  const { build } = loadEsbuild();
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'error',
    plugins: [rawLoader],
  });
}

export { ROOT, buildTest };

// 也可以单独跑这一个文件: node tests/build.mjs <入口.ts> <输出.mjs>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [entry, outfile] = process.argv.slice(2);
  if (!entry || !outfile) {
    console.error('用法: node tests/build.mjs <入口.ts> <输出.mjs>');
    process.exit(1);
  }
  await buildTest(entry, outfile);
  console.log(`  (打包完成: ${path.basename(outfile)})`);
}
