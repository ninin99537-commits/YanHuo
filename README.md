# 烟火 · 世界运转系统 (Yanhuo)

一个酒馆助手（Tavern Helper）脚本。**彼方记录"小事件"——具体 NPC 的个人生活与行踪；
烟火只记"大事件"——组织、群体、地区、天时与远方变化。**
两边尺度分工明确，互不抢地盘。

每次 AI 完成正文回复后（频率可配），用独立的 OpenAI 兼容 API 请求世界引擎，
推进世界状态并把一份**公开摘要**写进角色卡主世界书，供主 AI 保持世界的真实感。

---

## 装进酒馆（推荐：引子，可自动更新）

**不要**把整个 bundle 粘进脚本库。贴下面这一段**引子**
（酒馆助手 → 新建脚本 → 整段粘进去 → 启用）：

```js
// ============================================================
// 烟火 · 加载引子
// 本地开发：先跑 pnpm serve（5500），引子优先从本地取
// 线上：推 GitHub 后走 jsdelivr，本地取不到时自动兜底
// ============================================================
(async () => {
  const 本地 = 'http://localhost:5500/dist/烟火_世界运转/index.js';
  const 仓库 = 'ninin99537-commits/YanHuo';
  const 文件 = 'dist/烟火_世界运转/index.js';

  // 不加 ?t= 时间戳：ES 模块按 URL 缓存，加了会让同一页面重复执行、挂出第二个悬浮球
  try {
    await import(本地);
    console.log('[烟火] 已从本地加载:', 本地);
    return;
  } catch (错误) {
    console.warn('[烟火] 本地取不到（pnpm serve 没跑？），转线上:', 错误?.message ?? 错误);
  }

  // 先问 GitHub 要最新 sha：带 sha 的地址永久缓存、绝不串版本；@master 缓存 7 天只能垫底
  let 引用 = '';
  try {
    const 响应 = await fetch(`https://api.github.com/repos/${仓库}/commits/master`, { cache: 'no-store' });
    const 提交 = await 响应.json();
    if (提交 && 提交.sha) 引用 = 提交.sha;
  } catch { /* 接口不通 → @master 兜底 */ }

  const 地址表 = 引用
    ? [`https://testingcf.jsdelivr.net/gh/${仓库}@${引用}/${文件}`, `https://cdn.jsdelivr.net/gh/${仓库}@${引用}/${文件}`]
    : [`https://cdn.jsdelivr.net/gh/${仓库}@master/${文件}`, `https://testingcf.jsdelivr.net/gh/${仓库}@master/${文件}`];

  let 用了 = '';
  for (let 轮 = 1; 轮 <= 2 && !用了; 轮++) {
    for (const 地址 of 地址表) {
      try { await import(地址); 用了 = 地址; break; } catch { /* 换下一个源 */ }
    }
    if (!用了) await new Promise(等 => setTimeout(等, 1500));
  }
  if (!用了) throw new Error('本地和线上都取不到构建');
  console.log(`[烟火] 引子已加载: ${引用 ? 引用.slice(0, 7) : 'master(接口没通)'} ← ${用了}`);
})().catch(错误 => console.error('[烟火] 引子加载失败:', 错误));
```

**每次发版只需 `git push`，刷新页面就会拿到新版本** —— 引子先问 GitHub API 要最新 commit sha，
再用 `@<sha>` 引 jsDelivr。sha 是永久缓存且不可变，所以不会拿到"半新半旧"的产物。
`@master` 会缓存 7 天，只在 API 不通时兜底。

> **⚠ 本仓库必须是 public。** jsDelivr 只服务公开仓库；仓库私有 ⇒ jsDelivr 404、GitHub API 也 404。

## 从源码构建

```bash
pnpm install
pnpm build          # 产出 dist/烟火_世界运转/index.js
```

`pnpm build:dev` 带 sourcemap；`pnpm watch` 是开发监听。

> 仓库里**不含**测试、设计文档、其它插件。那些在开发用的完整仓库里。

## 目录

```
src/烟火_世界运转/               本脚本的全部源码
  README.md                     **详细文档在这里**（工作原理、消息结构、字段、机制）
  index.ts                      入口
  prompts.ts                    提示词引擎
  update.ts                     一次推进的流水线
  世界字段表.ts                  世界数据的字段事实来源
  保存世界状态.ts / 世界数据.ts   状态的存取与形状
  公开摘要.ts                    写进世界书的那份投影（脱敏，只给主 AI 用）
  worldbook-read.ts             读世界书（会排除自己与别的插件的常驻条目）
  悬浮球界面.vue / 面板相关      界面
src/共用/                       与本脚本无关的共享层（楼层快照内核、世界书求值等）
@types/                         酒馆助手与酒馆接口的类型声明（构建需要）
dist/烟火_世界运转/index.js      构建产物（引子直接加载它）
```

## 与其它脚本的关系

- **不依赖**彼方或剧情导演。三者都写各自的常驻世界书条目。
- 读世界书时会**排除自己和别的插件（彼方 / 剧情导演）写的常驻条目** ——
  那是"上一轮的推演结论"，不是世界设定；当设定用就是自我反馈。

## 许可

见 `LICENSE`。
