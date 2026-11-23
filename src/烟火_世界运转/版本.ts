// 烟火 · 版本与构建信息
//
// 为什么要有这一行: 真机上跑的是**已经打包好的 bundle**, 光看代码仓分不出用户手上那份是哪一版。
// 2026-10-11 就吃过一次亏——建档那轮跑的是比 v2.8.3 还旧的 bundle(报错文本里连「诊断:」那行都没有),
// 事后完全查不出来。所以版本号在启动时就打进控制台, 报错报告与推进记录里也各带一份。
//
// 两截信息的来源不同, 别混:
//   - `版本号` 是**人工维护的发布号**, 与策划案/README 的 v2.8.x 对齐(改功能就顺手改这里);
//   - `commit` 与 `构建时间` 由 webpack 在**构建那一刻**注入(webpack.config.ts 的 `__构建信息__`),
//     所以它天然是"这份 bundle 是谁构建的", 不需要手工同步。
// 测试(esbuild 直跑源码)没有 DefinePlugin, 取不到构建信息 → 退化成 `dev`, 不报错。

export const 版本号 = 'v2.10.1';

type 构建信息 = { commit: string; 构建时间: string };

const 兜底: 构建信息 = { commit: 'dev', 构建时间: 'dev' };

function 取构建信息(): 构建信息 {
  try {
    // `typeof` 保护: 测试里没有 DefinePlugin, 直接引用会 ReferenceError
    return typeof __构建信息__ === 'undefined' ? 兜底 : __构建信息__;
  }
  catch {
    return 兜底;
  }
}

/** 一行版本标签, 如 `v2.8.5 (a1b2c3d · 构建 2026-10-11 21:30)` */
export function 版本标签(): string {
  const { commit, 构建时间 } = 取构建信息();
  return `${版本号} (${commit} · 构建 ${构建时间})`;
}
