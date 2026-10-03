# 实现计划（一屏）· dsh-agent-guard

> 依据 `DESIGN.md`，API 结论依据 `VERIFY.md`（证据见 `.verify/`）。
> 目标版本 DSH 0.1.7-rc.2 / Node ≥ 24（`node:zlib` zstd）。**零运行时依赖。**

## 关键决策（与设计的差异，均有依据）

| # | 决策 | 依据 |
|---|---|---|
| D1 | 工具名用 `guard_inspect` / `guard_journal`，**不用** `protected-inspect`（连字符不是合法标识符） | `VERIFY.md` Q1；官方工具名均为 snake_case |
| D2 | 规则集落 `rules/default.json` 而非 `.yml` | 零依赖：YAML 需要解析器，JSON 内建（§6.6 只要求"数据化"，未规定格式） |
| D3 | 每轮快照**不逐文件解压**，只采"目录名 + 文件数 + mtime"；身份头按需（`includeHeaders`）并**按 mtime 缓存** | 实测 102 会话；每轮全量解压会拖慢 turn |
| D4 | 拦截用 `tools/pre-execute`（**deny 在 dispatch 前短路**），并在决策**之前**同步备份 | `VERIFY.md` Q1.1–Q1.2：waterfall 被 await，`deny` 不进入 dispatch |
| D5 | 判据写 `origin === 'subagent'`（**缺省 = 用户对话**） | 实测 59 条用户会话**无** `origin` 字段 |
| D6 | 面板双轨：宿主 `webServer` 同源 HTML（必做）+ 手写 `__ModuleLoader__` client bundle（可选，冒烟失败即摘） | `VERIFY.md` Q3；`dsh-shield` 实测先例 |
| D7 | 自身数据目录写失败时**降级链**：`$DSH_HOME/agent-guard/` → 记忆队列 + UI 告警（**绝不静默丢日志**） | `VERIFY.md` Q7 + 未结清项末条（沙箱可能拒写工作区外） |
| D8 | 存储优先直连 `node:fs`，不经 `ctx.fs` 的沙箱策略 | 守卫自身的日志/快照是"额外护栏"，不应被它要监控的策略削弱 |

## 目录与模块（每个模块单一职责，规则引擎无 I/O）

```
dsh-agent-guard/
├── package.json              dsh.bundle.patch + dsh.client(可选) + files 白名单
├── cordis.patch.yml          仅 - insert: [{ id, name }]
├── rules/default.json        受保护路径 + 动作→决策表（纯数据，社区可覆盖）
├── lib/
│   ├── index.js              apply(ctx)：唯一装配点，全部注册走 ctx.effect
│   ├── paths.js             路径规范化 / 大小写无关 / reparse point 解析 / 包含判定
│   ├── rules.js              纯函数 classify(action, targets, ctx) → decision（无 I/O）
│   ├── guard.js              tools/pre-execute 订阅 + tools.guard；决策→deny/ask/allow
│   ├── backup.js             写前备份 + 快照生成 + 保留策略
│   ├── journal.js            追加式 jsonl + prevHash 哈希链 + 失败重试/降级
│   ├── inspect.js            guard_inspect：workspaces/sessions/storage/layout/processes
│   ├── sessionlog.js         会话身份头只读解码（zstd 首帧）+ mtime 缓存
│   ├── hostcheck.js          DSH 是否停止：进程 + 端口 + 文件占用 + mtime 抖动（fail-closed）
│   ├── budget.js             影响预算台账（分类、升级只能由用户显式确认）
│   └── panel.js              同源 HTML 面板 + JSON API（只读）
├── client/client.js          可选原生面板（手写 bundle）
├── test/*.test.mjs           T1–T9、G-1–G-4、路径/熔断/降级
└── README.md / README.zh.md / CHANGELOG.md / SECURITY.md / LICENSE / .gitignore
```

## 实施顺序（每步都有"完成判据"）

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| **S1** | `paths.js` + `rules.js` + `rules/default.json` + 单测 **T1–T9** | `npm test` 全绿；规则引擎零 I/O（可用静态检查证明） |
| **S2** | `sessionlog.js` + `inspect.js` + `guard_inspect` 工具 → **G-1/G-2** | 临时 `DSH_HOME` fixture 下 `countsAsConversation` 正确；`path-as-identity-mismatch` 告警且**不产出修复建议** |
| **S3** | `journal.js` + `backup.js` + `hostcheck.js` + `guard.js` → **G-3/G-4** | 伪 DSH 进程/端口存在时 `blocked`；引用受保护路径的 `.bat` 产出 `emit-script` 告警 |
| **S4** | 每轮快照（`agent/turn-stopping`）+ 保留策略 + `guard_journal` | 快照含 `meta.json`/`layout.json`/`hashes.sha256`；清理只删自己的快照 |
| **S5** | 面板（同源 HTML 必做）+ 设置页；可选 client bundle | 面板无 CDN、无写按钮；设置页可开关护栏（一键停用） |
| **S6** | 文档与发布：双语 README、CHANGELOG、SECURITY、`.gitignore` | §14 + §20 逐项打勾；`npm pack --dry-run` 无私有文件 |

## 硬性约束（违反即返工）

1. 绝不写 `$DSH_HOME/sessions/`、`storages/`、`profiles/`；凭据文件**只 stat 元数据不读内容**；
2. 不提供"一键修复/迁移 DSH 数据"；不生成可双击的改数据脚本（生成即告警）；
3. 无网络、无遥测、零运行时依赖；日志只写自身目录；
4. 规则引擎纯函数可单测；引擎异常 → `allowed-with-backup` + `engine-fault` 告警，**绝不无备份放行**；
5. 全部测试在临时 `DSH_HOME` 内，**绝不碰真实 `~/.dsh`**；
6. 公开产物按 §19.2 全量脱敏（不出现真实路径/用户名/会话 id/标题）。

## 唯一需要真实环境写一次的验证

D7 的降级链前提：宿主进程内写 `$DSH_HOME/agent-guard/` 是否被会话沙箱拒绝。
**做法**：装到一个**全新 profile**（不动 `desktop`），写一次自身目录并读回；失败则确认降级链生效。
这是唯一一次触碰工作区外路径的写操作，且只写自己的目录。
