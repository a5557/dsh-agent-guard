# 交付报告（v0 + v1）— 对应 `DESIGN.md` §18 的实现要求

> 本文汇总当前实现状态。API 结论与实证见 [`VERIFY.md`](./VERIFY.md)；
> 发布清单见 [`RELEASE.md`](./RELEASE.md)。

## 1. 交付物清单

| 文件 | 作用 |
|---|---|
| `VERIFY.md` | §16 全部 API 验证结论 + 3 个附录（旁路声明、卸载与数据目录、会话存储精确契约） |
| `IMPLEMENTATION-PLAN.md` | 一屏计划：决策、模块、阶段与判据 |
| `RELEASE.md` | §14 + §20 逐项核对（附可复核命令） |
| `CHANGELOG.md` | 0.1.0 全量变更 |
| `README.md` / `README.zh.md` | 双语说明，含**能力红线**与限制 |
| `SECURITY.md` | 能力表、拦截不到的清单、隐私与防篡改说明 |
| `lib/paths.js` | 路径规范化、大小写无关、reparse point 解析、受保护模式编译（只读） |
| `lib/encoding.js` | 逐行复刻宿主 `projectKey`（对真实库 9/9 命中） |
| `lib/sessionlog.js` | 身份头只读解码（`node:zlib` zstd 首帧）+ 布局清点 + mtime 缓存 |
| `lib/hostcheck.js` | 宿主状态多判据探测（进程 + 端口 + 占用），判不出即按「未停止」 |
| `lib/rules.js` | **纯函数**规则引擎（无 I/O，可单测） |
| `lib/inspect.js` | `guard_inspect` 报告装配 + 文本渲染（只读） |
| `lib/store.js` | 插件自身数据目录：解析、降级链、原子写、重试 + 内存队列 |
| `lib/journal.js` | 追加式 `journal.jsonl` + `prevHash` 哈希链 + 校验 |
| `lib/backup.js` | 写前备份、回合回滚点、保留策略、**人工**回滚说明 |
| `lib/guard.js` | `tools/pre-execute` 拦截决策与执行、熔断追踪 |
| `lib/snapshot.js` | 每轮回滚点调度（去抖） |
| `lib/config.js` | 配置解析（非法值回落 + 告警）、官方 `Config` 形态 |
| `lib/panel.js` | 同源只读面板（零构建、无 CDN、无写按钮） |
| `lib/client.js` | **客户端半边**：手写 `__ModuleLoader__` bundle，注册侧边栏图标 + 主面板 + 设置页（零构建、零 devDependencies） |
| `bin/guard.mjs` | 独立 CLI：**零 profile 改动**即可取证 |
| `rules/default.json` | 数据化规则集（无绝对路径、无个人信息） |
| `test/` | **169 个用例**（10 个套件：T1–T9、G-1…G-4、只读性、降级链、哈希链、配置发现、挂载契约、客户端 bundle、**装配层集成**） |
| `checks/` | **7 个可发布自检脚本**：CI 结构 / 编码体检 / 只读性 / 脱敏扫描 / 隔离性 / 发布清单机器验证 / 端到端复核 |
| `.github/workflows/ci.yml` | 三平台 × Node 22/24 CI（含打包最小化与零网络断言） |
| `.verify/` | 只读探针与研究记录（`.gitignore` 已忽略，不含发布产物） |

## 2. 验证结果（可复现）

```
npm run lint                      → exit 0
npm test                          → 169 passed, 0 failed
node checks/check-readonly.mjs   → 16 个发布产物中只有存储层/备份层写盘，非预期 0
node checks/check-redaction.mjs  → 我产出的文件 0 命中（剩余命中全在 DESIGN.md）
node checks/check-isolation.mjs  → 完整测试套件对真实 DSH_HOME 零写入、零改动
node checks/check-encoding.mjs   → 40 个文件无编码损坏
node checks/final-check.mjs      → 工具/事件/路由注册 + 真实 home 只读性
npm pack --dry-run                → 24 个文件 / 77.0 kB（含 lib/client.js）
```

**真实安装冒烟已完成**（§14 第 2/3 项）：把 `DSH_HOME` 重定向到工作区内的隔离目录，
跑**真实的** `dsh plugin add` / `remove`，并用官方 `--dump-config` 与 `--dump-config-schema`
验证挂载与配置发现：

```
add    → exit 0；bundles: ["@deepseek-ai/dsh-base","dsh-agent-guard"]（dsh.bundle 自动入列）
dump   → 第 359-361 行:  # == dsh-agent-guard / - id: dsh-agent-guard / name: dsh-agent-guard
schema → entry status:"schema"、configRef:"#/$defs/config64"，13 项配置与默认值正确
remove → exit 0；dependencies 清空、bundles 还原；dump 中无残留
真实 ~/.dsh → 仍为 desktop / node_modules / web，零污染
```

> `--dump-config-schema` 这一步**查出并修掉了一个真实缺陷**：加载器此前读到
> `status:"absent"`、`configRef:"#/$defs/unknownConfig"`，即**发现不到本插件的 Config**
> （根因：入口未导出 `Config` + schemastery 从插件位置解析不到）。修复详情见 `RELEASE.md`。
> 这条通道是唯一能暴露它的：单元测试全绿、`--dump-config` 也正常。

**隔离性是可复核的**：`check-isolation.mjs` 在跑完整套件前后对真实 `$DSH_HOME` 做
「路径:大小:mtime」指纹比对，结论为零新增、零消失、且未误建 `agent-guard/` 目录。

## 3. 真实数据实测（只读）

```
真实 DSH_HOME 只读性：
  storages 指纹一致  : ✅
  sessions 文件数一致 : ✅ (102)
  取证结论 : 工作区 9 个，磁盘会话 74 个
  注入的内部记录 : 43 条（被标注为非对话）
  被标为「未登记对话」的 : 0 条
  agent-guard 目录是否被误建在真实 home : ✅ 不存在
```

要点：

1. **74/74 身份头解出、0 失败**，零运行时依赖（仅 `node:zlib`）。
2. 43 条内部记录 = 事故中「丢失的 40 个对话」的同一现象。
3. **没有任何真实对话被报成「未登记」**；每个工作区「登记 N → 磁盘找到 N」。
4. 沙箱下探测不可用时，报告写的是**判据不足（按「未停止」处理）**，而不是「未运行」——
   fail-closed 生效。

## 4. 端到端拦截验证（临时 DSH_HOME）

```
[1] 拦截结果 : deny
    工具主体执行了吗 : false （✅ 未执行，拦截生效）
    理由 : 目标属于 DSH 核心数据，且无法确认 DSH 已完全停止：拒绝写入（fail-closed）
[2] 日志条数 : 1 ｜ 决策 blocked ｜ 受保护 true ｜ 哈希链完整（1 条）
[3] 回滚点 : 生成成功（hashes.sha256, layout.json, meta.json）
[4] 面板 : 无外部资源 ✅ ｜ 无写按钮 ✅ ｜ 只读动作齐备 ✅
[6] DSH 私有存储是否被写过 : ✅ 未被写入
[7] apply() 注册 : 工具=guard_inspect+guard_journal
    事件=tools/pre-execute+agent/turn-stopping+agent/created
    路由=exact:/agent-guard+prefix:/agent-guard/api
```

**「工具主体执行了吗：false」是本项目最核心的一条断言**：它证明拦截发生在 dispatch 之前，
而不是事后告警。

## 5. 实现过程中纠正的判断（均来自实测优先）

| # | 原本会写错 | 实测纠正 |
|---|---|---|
| 1 | `origin === 'user'` 才是对话 | 用户会话**没有** `origin` 字段；判据必须是 `origin === 'subagent' \|\| delegationDepth > 0` |
| 2 | 后缀 `.jsonl.zst`，一个会话一个文件 | 实际 `.jsonl.zstd`，且可能有 v0/v3/v4 **多个代际文件** → 数目录不数文件 |
| 3 | `fs/write-intent` 是文件写总闸 | **它不能否决**，且 `pwsh`/`bash` 从不上报 → 必须锚定 `tools/pre-execute` |
| 4 | `capabilities`/`capabilityRedLines` 是清单字段 | **不是**，仅社区目录惯例 → 写进 README/SECURITY |
| 5 | `node --test` 可直接跑 | 受限沙箱下每文件 spawn 子进程会被拒（EPERM） → 改进程内 `run()` |
| 6 | 自己按「替换非法字符」实现路径编码 | 读宿主 `projectKey` 得知是**保留大小写 + `~XXXX` 转义**，且**有损** |
| 7 | 未登记目录可推断为子代理记录 | **不是不变量**（bootstrap 无 origin 过滤） → 分类只来自首帧 header |
| 8 | `Agent` 只有 `id` | 运行时面额外有 `session`，`session.header.cwd` 才是权威工作目录 |
| 9 | `dsh.client.inject` 是服务名 | 实测是**包名**列表（用于编排其他插件的 bundle）；本插件只用平台种子词 `react` 与 shell 的 `ctx.slots`，因此**不注入任何包** |
| 10 | `guard_inspect` 工具可用环境变量解析 home | 测试会在无意中读真实 `$DSH_HOME` → 已在装配时**显式绑定** `dshHome`（`check-isolation.mjs` 现在守着这条） |

## 6. 过程中发生的事故与查出的真实缺陷（如实记录）

**两次自我破坏（同类根因）**：用 PowerShell `Get-Content -Raw` + `Set-Content` 对
`lib/inspect.js` 与 `lib/config.js` 做文本往返，把 UTF-8 按 ANSI 读入导致中文全损。
都在发现后手工重写、用例重新全绿，并新增 `checks/check-encoding.mjs` 做全库体检守住。
此后一律改用 `edit`/`write` 工具而非 shell 文本往返。

**两个只有集成测试才能发现的实现缺陷**（第七轮补 `test/assembly.cases.mjs` 后暴露）：

| 缺陷 | 后果 | 为什么单元测试看不到 |
|---|---|---|
| `createComponents` 的 `workspaceRoots` 接受数组，`GuardRuntime.engine()` 要求函数，数组被直接传下去 | `engine()` 每次抛 `this.workspaceRoots is not a function` → 规则引擎从未成功运行，**所有工具调用退化为 fail-safe 拒绝**。护栏等于没接线 | 各单元测试都**自己构造** `createGuardRuntime` 并手动传函数，绕过了装配层的收口点 |
| 未注入 `dshStateProvider` 时默认 `running: true` | 等于跳过真实探测、乐观假定宿主在运行 | 同上：测试全都显式注入了 provider |

教训：**"装配正确"无法由部件单测证明**。部件的测试在自己构造依赖时就绕过了装配层的
默认值与类型收口——那正是错配的藏身处。现已在装配层统一收口（`toRootsProvider`），
默认改为惰性 + 缓存的真实探测，并保留 fail-closed。

## 7. 尚未完成 / 需要你决定

### 已结清（此前列为待验证）

| 项 | 结论 |
|---|---|
| **自身目录可写性** | **已结清**（代码级证据，`VERIFY.md` 附录 D）：会话沙箱靠**替换 `ctx.fs` 服务**生效，`sandboxPolicy` 的消费者全是工具包；`dsh-fs-local` 本身从不接触它。因此约束的是**工具 I/O，不是宿主进程** → 插件的 `node:fs` 写入正常情况下可写。仍保留三级降级链兜住外层机制（OS ACL 等） |
| 三平台 CI | **已配置**：`.github/workflows/ci.yml` = 3 平台 × Node 22/24，含 `lint`/`test`/`checks` 与「打包最小化」「零网络 + 零依赖」两个 job；`checks/check-ci.mjs` 本地校验其结构与矩阵完整性 |

### 已结清（作者 2026-10-03 决定）

| 项 | 结论 |
|---|---|
| **`DESIGN.md` 脱敏** | **已完成**：按它自己的 §19.2 表脱敏，全库扫描 **0 命中**；替换表只在内存中、脚本已删除。过程中修正了两处自我失误（把已含占位符的文本误报为残留；多轮替换叠加出畸形路径与语义损坏）与一处信息泄露（组合占位符保留了路径骨架） |
| **`DESIGN.md` 是否公开** | **按作者决定不随公开仓库分发**（已写入 `.gitignore`）。排除它**不是因为它危险** —— 它已脱敏、可安全公开；只是它是设计过程文档而非发布产物。想公开时删掉 `.gitignore` 里那一行即可 |

### 仍需你决定 / 只能你做

| 项 | 说明 |
|---|---|
| **公开身份** | `package.json` 的 `author`/`repository`/`bugs` 刻意留空；git 提交身份按 §19.4 设为专用昵称 + GitHub noreply 邮箱。**我不能替你编造** |
| git 仓库初始化 | 本目录还不是 git 仓库（`§20` 第 3/4 项因此无法机器验证） |
| GitHub Actions 实际运行 | 配置已本地校验，但**没有推送到 GitHub 跑过**，所以"三平台实测"仍未发生 |
| pnpm 卸载残留 | `node_modules/.bin` 的 3 个 shim 与空的 `"dependencies": {}` 由 pnpm 保留，非本插件所致；已写进 README 与 `RELEASE.md`，不隐藏 |

## 8. 硬性约束遵守情况（§18 第 3 条）

| 约束 | 状态 | 证据 |
|---|---|---|
| 绝不写 `sessions/` 与 `storages/` | ✅ | 真实 home 只读性验证；`checks/check-readonly.mjs` |
| 凭据文件只检查元数据不读内容 | ✅ | 受保护表把凭据列为 core-data；代码中无对 `.credentials.yaml` 的读取 |
| 不提供「一键修复/迁移」 | ✅ | 回滚只给人工说明；面板无写动作（写动作返回 400） |
| 不生成可双击改数据脚本 | ✅ | `emit-script` 规则为告警动作，有专门用例 |
| 日志/快照写自己目录，无网络、无遥测 | ✅ | `store.js` 是唯一可写位置；`npm pack` 无依赖 |
| 规则引擎无 I/O、可单测 | ✅ | `lib/rules.js` 不 import 任何 `node:fs` |
| 引擎异常 fail-safe（备份 + 告警，绝不无备份放行） | ✅ | 有专门用例：引擎故障 → deny + 说明 |
| 全部测试在临时 `DSH_HOME` | ✅ | `test/fixtures.mjs` 只造临时目录 |
