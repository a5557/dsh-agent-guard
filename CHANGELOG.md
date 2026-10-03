# Changelog

本项目遵循语义化版本。0.x 阶段允许调整规则集；破坏性变更走 minor 并在本文件写明。

## [0.1.0] — 未发布（v0 + v1 首个版本）

首个版本。设计依据 `DESIGN.md`；每一条 API 结论与实证见 `VERIFY.md`。

### 只读取证（v0）

- `guard_inspect` 工具与独立 CLI（`dsh-agent-guard inspect`），一条命令拿到工作区登记状态、
  会话身份头、目录布局与宿主运行状态。
- **零运行时依赖**解出会话身份头：利用 `node:zlib` 的 `zstdDecompressSync` 在**首个 zstd 帧**
  处返回的特性，直接拿到身份头。实测真实数据 **74/74 成功、0 失败**。
- 逐行复刻宿主的 `projectKey` 路径编码（对真实库 9/9 命中），因此能准确对齐「登记路径」与
  「磁盘布局」。
- `origin` 判据为 `origin === 'subagent' || delegationDepth > 0` → `countsAsConversation: false`。
  用户会话**没有** `origin` 字段，所以任何 `origin === 'user'` 的写法都会误杀真实对话——
  这一点有专门用例守着。
- 「未登记」永远与 `origin` 分解一起输出；读不出来的身份头记为 `unreadable`/`incomplete`，
  **绝不**当作「没有记录」。
- CLI 支持 `--json` / `--redact` / `--no-headers` / `--scope` / `--workspace` / `--max-sessions`。

### 写入治理（v1）

- **写前拦截**锚定在 `tools/pre-execute`：实测 `deny` 会在工具主体 dispatch **之前**短路，
  因此是真正的阻止，而不是事后告警。覆盖模型直调工具、MCP 工具、PTC 子调用与子代理。
- 受保护路径默认全集：`sessions/`、`storages/`、`profiles/`、凭据文件、插件自身目录，
  以及每个工作区根与工作区内的 `.dsh/`。路径比较做规范化 + Windows 大小写无关 + 解析
  reparse point（联接/符号链接）。
- **先备份再放行**；备份失败或超出上限（默认 8 MiB）→ **拒绝写入**，绝不无备份放行。
- **DSH 是否停止**用多重判据（进程 + 端口 + 占用），判不出来按「未停止」处理（fail-closed）。
- **熔断**：同一路径连续写且校验摘要变化 → 强制暂停，交给审批通道由人决定。
- **影响预算**：`display` 类目标的会话一律不得写核心数据；升级只能由用户改配置，
  agent 无法在运行期自我升级。
- 规则引擎是**纯函数、无 I/O**，因此 T1–T9 可以直接单测。

### 留痕与回滚点

- `journal.jsonl` 只追加，带 **`prevHash` 哈希链**：改写或抽掉任意一条都可被发现
  （有专门用例验证）。写入失败会重试，然后降级为内存队列 + 告警，**绝不静默丢弃**。
- 日志**不记录命令原文**，只记录 12 位命令摘要；不记录消息正文与凭据。
- 每轮回滚点挂在 `agent/turn-stopping`（serial，可 await）并带最小间隔去抖，产物为
  `meta.json` + 注册表副本 + `layout.json` + `hashes.sha256`。
- 保留策略只删**自己的**快照目录；不认识的文件与目录一律保留。
- 回滚只给**人工说明**，不提供自动回滚命令。

### 展示层

- **原生席位（客户端半边）**：`lib/client.js` 是**手写**的 `window.__ModuleLoader__.load`
  bundle（用 `React.createElement` 代替 JSX），注册三个席位：
  - `sidebar.panellist`（侧边栏图标，官方目前无占用者）；
  - `main`（`key` 与上面的 `id` 同值，构成"点图标开面板"）；
  - `settings.section`（设置页「环境护栏」）。
  因此本包**零构建步骤、零 devDependencies**，同时不依赖任何其他插件的 bundle。
- **同源 HTTP 面板** `/agent-guard`：作为宿主无 client bundle 通道时的降级方案，
  零构建、零依赖、无 CDN。
- 两处 UI 都**只读**：面板 API 对任何写动作返回 **400**，且没有任何"修复/迁移/回滚"按钮。
  设置页给出「一键停用」的准确做法，并说明**关掉备份不会放宽**受保护写入的拒绝策略。
- `emit-script` 接线（G-4）：写入 `.bat/.cmd/.ps1/.sh/.bash/.vbs` 且**内容引用了受保护路径**时，
  升级为 `require-confirmation` 并附告警——针对事故 root cause R4
  「把 agent 的不确定性转成用户的一次双击」。判据保守：目标必须是脚本**且**内容真的引用了受保护位置。

### 设置页与配置发现

- 按官方形态导出 `Config`（schemastery schema，13 项），使
  `dsh --dump-config-schema` 能发现本插件的配置、设置页能渲染成表单。
  实测：修复前 entry 为 `status:"absent"` / `configRef:"#/$defs/unknownConfig"`，
  修复后为 `status:"schema"` / `configRef:"#/$defs/config64"`。
- `@deepseek-ai/schemastery` 是**安装锚点提供的 peer**，因此解析采用多锚点
  （自身 → `DSH_RUNTIME_ROOT` → npm 全局根下的 `@deepseek-ai/dsh`）；拿不到时
  `Config` 为显式 `null`（按"无 schema"处理，插件照常工作）。
- 配置非法值一律回落默认并产生可读告警——**配置错误导致护栏静默失效，比护栏拒绝工作更危险**。

### 自检脚本（随包发布）

`checks/` 下 6 个零依赖自检脚本，可独立运行，也可一次跑 `npm run checks`：

| 脚本 | 检查什么 |
|---|---|
| `check-readonly.mjs` | 发布产物里只有存储层/备份层写盘，且只写自身目录 |
| `check-encoding.mjs` | 全库无 U+FFFD、无双重编码损坏 |
| `check-redaction.mjs` | §20 脱敏扫描（真实路径／用户名／第三方工具名） |
| `check-isolation.mjs` | 跑完整测试套件期间真实 `$DSH_HOME` 零污染 |
| `check-audit-leak.mjs` | 脱敏审计报告本身不复述敏感串 |
| `final-check.mjs` | 真实驱动两个工具 + 真实 home 只读性 |

设计要点：**不硬编码本机路径**（根目录由脚本自身位置推导）；自指检查显式排除自身，
否则会命中自己写的模式定义。`check-isolation.mjs` 的判据刻意区分
「测试造成的改动」与「正在运行的 DSH 自身活动」——一个报假阳性的检查会被忽略，
比没有检查更糟。

### 集成测试补上了两个只有装配层才能发现的缺陷

新增 `test/assembly.cases.mjs`：**通过真实的 `apply()` 事件订阅路径**验证 P3 与 §6.5，
而不是只测部件。此前的覆盖是单元级的（直接调 `SnapshotScheduler.onTurn()` /
`CircuitTracker.inspect()`），而插件真正的接法是 `apply()` 订阅
`agent/turn-stopping` / `agent/created` 再由监听器驱动调度器——**这一段此前零引用、零覆盖**。

补测后立刻暴露两个真实缺陷：

1. **`workspaceRoots` 的 API 形态冲突（严重）**：`createComponents()` 接受**数组**，
   而 `GuardRuntime.engine()` 要求**函数**。数组被直接传下去，于是每次判定都抛
   `this.workspaceRoots is not a function` → 规则引擎从未成功运行，
   所有工具调用退化为 fail-safe 拒绝。**护栏等于没接线，而单元测试全绿。**
   修法：在装配层用 `toRootsProvider()` 统一收口两种形态。
2. **默认状态提供者是"乐观假定"**：未注入 `dshStateProvider` 时默认返回
   `running: true`，等于**跳过真实探测**。现改为惰性 + 缓存的真实探测
   （进程 + 端口 + 占用多判据），探测失败仍 fail-closed。

两条教训写在这里：**"装配正确"无法由部件单测证明**。部件的测试都在自己构造依赖，
绕过了装配层的收口点与默认值——那正是错配藏身之处。

### 覆盖审计：从「想到哪补到哪」改成机制

新增 `checks/check-coverage.mjs`（已接入 `npm run checks`）：把**实现面**与**测试面**做映射，
穷举 `lib/` 的每个导出、每个副作用注册点、§6.2 的八种动作、§7.2 的九个 finding code、
以及每个配置项，逐个回答"有没有被断言"。

它立刻查出两个问题：

1. **`protectCwdWorkspace` 是"虚假配置"**：被定义、被 `resolveConfig` 解析、
   被写进设置页 schema —— 但**从未被任何逻辑使用**。用户改了它完全没效果。
   保留一个承诺了却不生效的配置项比没有更糟，**已移除**（含 DEFAULT_CONFIG、解析分支、schema）。
2. **用户可见面缺断言**：`createJournalTool` 的三个 action 输出文本、
   `probeDshState` 的多判据行为、`describeState` 的字段形状此前只有间接覆盖——
   都是"坏了不报错、但用户会看到错东西"的位置。新增 `test/visible.cases.mjs` 补齐。

审计的判据也做过一次修正：最初把"文本未提及"一律算作缺口，导致 53 个误报
（模块内部被 `apply()` 调用的函数不会出现在测试文本里）。现在区分
**入口间接覆盖**（经 `apply()`/`createComponents()` 真实路径触达，附触达说明）与
**真正未覆盖**——一个持续报假阳性的审计会被忽略，也就失去了意义。

### 已知限制（如实声明）

- 拦不住 `pwsh`/`bash` 里的改名与删除（命令文本不透明，只能启发式提取路径）；
- 拦不住后台任务、宿主终端、客户端/HTTP 宿主 API，以及用户手工双击脚本；
- `pre-execute` 没有超时且运行在单一有序通道，因此其中做的备份会阻塞该回合；
- 自身数据目录默认在 `$DSH_HOME/agent-guard/`（工作区之外）。若沙箱拒绝写入，会降级到临时
  目录并告警；两者都不可写时进入「仅内存」模式并明确提示记录会丢失。

### 测试

- **169 个用例**，10 个套件：T1–T9、G-1/G-2/G-3/G-4、只读性、存储降级链、哈希链防篡改、
  保留策略、配置回落与发现、挂载契约、面板只读性、客户端 bundle 在受控沙箱里的真实执行，
  以及**装配层集成测试**（通过真实的 `apply()` 事件订阅路径验证 P3 与 §6.5）。
- 全部在**临时 `DSH_HOME`** 中运行，绝不触碰真实 `~/.dsh`——
  这条由 `checks/check-isolation.mjs` 在跑完整套件前后做指纹比对来**证明**，而不是口头承诺。
- 因受限沙箱下 `node --test` 会为每个文件 spawn 子进程（EPERM），测试改为进程内 `run()`
  执行，本地与 CI 行为一致。
