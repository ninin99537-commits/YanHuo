import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const environment = { ...process.env, TAVERN_ENTRY: 'src/角色卡状态栏/index.ts' };
const children = [
  spawn(process.execPath, ['tools/static-server.mjs'], { cwd: root, stdio: 'inherit' }),
  spawn(pnpm, ['watch'], { cwd: root, stdio: 'inherit', env: environment }),
];

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}

for (const child of children) {
  child.on('error', error => {
    console.error('[dev] 子进程启动失败', error);
    shutdown(1);
  });
  child.on('exit', code => {
    if (!shuttingDown && code !== 0) shutdown(code || 1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
