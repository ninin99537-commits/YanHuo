// 共用 · 跨插件世界书写入串行锁
// ---------------------------------------------------------------------------
// 彼方与烟火（及未来其它插件）都在各自独立的 iframe 里运行，却可能在同一时间窗内
// 读写同一本「角色卡主世界书」。酒馆底层的 update/create/remove 本质都是读整本 JSON
// 再整本写回，并发调用会发生后写覆盖先写（Lost Update）。
//
// 本模块把按书名分桶的 Promise 链挂在同源顶层窗口（window.top / parent，Node 环境回退
// 到 globalThis）的固定槽位上，让不同 iframe 里的所有世界书写入按书名严格串行排队：
//   - 用普通对象而非 Map，彻底规避跨 iframe realm 的 instanceof 误判；
//   - 不同书名互不阻塞，同一书名按调用顺序逐个执行；
//   - 单次任务抛错不影响后续排队任务继续执行；
//   - 单个锁槽位在队列清空后自动回收，不泄漏内存。

const LOCK_SLOT = '__tavernHelperWorldbookWriteLocks_v1__';

type LockTable = Record<string, Promise<void>>;

function 取锁表(): LockTable {
  let 根: Record<string, unknown> = globalThis as unknown as Record<string, unknown>;
  try {
    const win = (globalThis as unknown as { window?: any }).window;
    if (win) {
      const 候选 = win.top || win.parent || win;
      // 验证同源可读（跨域 iframe 会抛 SecurityError，自动回退到当前全局）
      void 候选[LOCK_SLOT];
      根 = 候选;
    }
  }
  catch {
    根 = globalThis as unknown as Record<string, unknown>;
  }
  const 已有 = 根[LOCK_SLOT];
  if (!已有 || typeof 已有 !== 'object') {
    根[LOCK_SLOT] = Object.create(null);
  }
  return 根[LOCK_SLOT] as LockTable;
}

/** 按世界书名串行执行异步写操作；同一本书跨 iframe 互斥，不同书并行。 */
export async function 串行写世界书<T>(书名: string, fn: () => Promise<T>): Promise<T> {
  const 键 = String(书名 ?? '').trim();
  if (!键)
    return fn();
  const 表 = 取锁表();
  const 前驱 = 表[键] ?? Promise.resolve();
  let 释放!: () => void;
  const 当前 = new Promise<void>(resolve => {
    释放 = resolve;
  });
  const 尾 = 前驱.then(() => 当前);
  表[键] = 尾;

  await 前驱;
  try {
    return await fn();
  }
  finally {
    释放();
    if (表[键] === 尾) {
      delete 表[键];
    }
  }
}
