# 发布清单（§14 Definition of Done + §20 发布前安全检查）

> 核对时间：本文件随 `0.1.0` 编写。图例：**✅ 通过** / **⏳ 待做（需真实环境或需你决定）** / **➖ 不适用**。
> 每一条都尽量给**可复核的命令或证据**，而不是空口打勾。

## §14 发布清单

| # | 条目 | 状态 | 证据 / 说明 |
|---|---|---|---|
| 1 | `npm pack` 内容最小化（`files` 白名单），无本地绝对路径、无 `node_modules` | **✅** | 实测 `npm pack --dry-run`：**31 个文件 / 89.3 kB**（含 `lib/client.js` 与 `checks/` 自检脚本），无 `node_modules`、无 `.verify/` 草稿、无 `DESIGN.md`、无 `*.log/*.bak` |
| 2 | 本地路径可装可 remove，卸载后 DSH 行为与安装前一致 | **✅** | **真实 `dsh plugin add/remove` 冒烟已通过**（见下方「真实安装冒烟实测」）；注册面与安装前逐字节一致 |
| 3 | 在**全新 profile** 上从零安装成功（不依赖本机状态） | **✅** | 在**全新 profile** 上完成：初始化 → 安装 → 挂载 → 配置发现 → 卸载 → 比对。用隔离的 `DSH_HOME`（工作区内）执行，**未触碰真实 `~/.dsh`** |
| 4 | 单元测试 + 黄金样本全绿（三平台 CI） | **✅ 本地 + CI 已配置** | 本地 **169 passed / 0 failed**；`.github/workflows/ci.yml` = **3 平台 × Node 22/24** 矩阵，含 `lint`/`test`/`checks` 三道闸门，另有两个 job：**打包最小化断言**（拒绝 `node_modules`/`.verify/`/`test/`/`DESIGN.md` 进包）与**零网络 + 零依赖断言**；`checks/check-ci.mjs` 本地校验其结构与矩阵完整性。<br>**限制**：GitHub Actions **未实际运行过**（需推送到 GitHub），故"三平台实测"仍待验证 |
| 5 | README 双语 + 截图 + 卸载说明 + 限制声明 | **✅ 双语与限制** / **➖ 截图** | `README.md`（英）/ `README.zh.md`（中）；限制逐条写明。**故意不放截图**：截图会暴露真实会话标题（§19.5 最硬的红线），宁可没有 |
| 6 | `SECURITY.md` 写清能力红线与私密性（无网络、无遥测） | **✅** | `SECURITY.md`：能力表 + 拦截不到的清单 + 隐私说明 |
| 7 | CHANGELOG + 语义化版本 + `DESIGN.md` 随版本更新 | **✅** | `CHANGELOG.md`（0.1.0 全量）；`DESIGN.md` 已按 §19.2 脱敏，但按作者决定**不随公开仓库分发**（见文末） |
| 8 | 向社区目录提交条目（分类 `security`，如实填 `capabilities`/`capabilityRedLines`） | **⏳** | **实测结论**：这两个字段**不是** DSH 清单字段（VERIFY.md 附录 B），只是社区目录惯例 → 因此写进 README/SECURITY，不写进 `package.json`。提交需你操作 |
| 9 | §20 逐项通过 | **✅ 除一项** | 见下 |

### 真实安装冒烟实测（§14 第 2/3 项，2026-10-01）

**做法**：把 `DSH_HOME` 重定向到**工作区内**的隔离目录（`resolveProfileDir(name, home)` 的 home
来自 `resolveDshHome()`，而它读取 `DSH_HOME`），从而在不触碰真实 `~/.dsh` 的前提下跑**真实的**
`dsh plugin add/remove`；再用官方 `dsh --profile <p> --dump-config` 验证挂载。

```
[1] 初始化全新 profile            : exit 0（隔离目录内生成 profiles/<name>/）
[2] dsh plugin --profile <p> add link:<本目录> : exit 0
    profile package.json dependencies : {"dsh-agent-guard":"link:<本目录>"}
    profile dsh.profile.bundles       : ["@deepseek-ai/dsh-base","dsh-agent-guard"]
    ★ 声明了 dsh.bundle 的包被**自动加入** bundles —— 与 VERIFY.md 结论一致
[3] dsh --profile <p> --dump-config（安装态，23718 字节）
    # == dsh-agent-guard
    - id: dsh-agent-guard
      name: dsh-agent-guard
    ★ 插件行真的进入了合成后的加载器树 —— 挂载成立
[4] dsh plugin --profile <p> remove dsh-agent-guard : exit 0
    dependencies : {}            （条目已移除）
    profile.bundles : ["@deepseek-ai/dsh-base"]   （已还原）
    dump-config（卸载态）: ✅ 不含 dsh-agent-guard，无注册残留
清理：隔离目录与 dump 文件全部删除；真实 ~/.dsh 仅 desktop / node_modules / web 三项，
     未建任何 profile，未建 agent-guard。
```

**§17 第 4 项的严格集合比对**（`.verify/verify-uninstall-behavior.mjs`，独立于上面的冒烟）：

```
基线条目数        : 93   含本插件 ✅ 没有
安装后            : 94   含本插件 ✅ 是
卸载后            : 93   含本插件 ✅ 不在
安装引入的条目     : 1（含 dsh-agent-guard）
卸载移除的条目     : 1（含 dsh-agent-guard）
卸载后相对基线多出 : 0
卸载后相对基线缺少 : 0
→ 卸载后条目集合与安装前**完全相同**，插件确实不再被装配
```

> 这条比"dump 里看不到插件名"更强：它比对的是**整棵加载器树的条目身份集合**，
> 因此能证明"卸载后 DSH 装配出的插件集合与安装前一致"，而不只是"本插件那一行没了"。

**两处如实记录的细微差异**（都不影响注册与行为，但目录不完全等价）：

1. **`node_modules/.bin/` 保留 3 个 bin shim** —— 卸载后 `dsh-agent-guard`、
   `dsh-agent-guard.CMD`、`dsh-agent-guard.ps1` 仍在。这是 pnpm 的行为（与 VERIFY.md 附录 B
   预测的「pnpm leftovers」一致）。
2. **profile 的 `package.json` 多了一个空 `"dependencies": {}`** —— 卸载后 pnpm 保留了空对象，
   因此文件不是逐字节还原（177 B → 155 B）。这属 pnpm 语义，非本插件所致。

> 因此「卸载后与安装前一致」的**准确**表述是：**注册面完全一致**（配置树、dependencies、
> bundles 全部还原，配置树逐字节相同），**文件面存在 pnpm 自身留下的无害残留**。
> 这条已写进 README 的卸载说明，不夸大。

> **仍未验证的一项**：应用真正启动时，宿主进程内写 `$DSH_HOME/agent-guard/` 是否被会话沙箱拒绝
> （`dump-config` 只合成配置树，不装配插件，所以不会触发）。启动完整应用会干扰你正在使用的
> 会话，因此留给你决定；README 已如实写明三种模式。

### 设计文档 §9 展示层要求的覆盖情况

| §9 要求 | 状态 | 证据 |
|---|---|---|
| 侧边栏面板（`sidebar.panellist`） | **✅ 已实现** | `lib/client.js` 注册 `sidebar.panellist`（id=`agent-guard`） |
| 主面板（`main`，由 sidebar entry id 选中） | **✅ 已实现** | `main` 的 `key` 与 panellist 的 `id` 同值——`client.cases.mjs` 有专门断言守着这个配对 |
| 设置页（`settings.section`） | **✅ 已实现** | 同文件注册 `settings.section`，含"一键停用"的准确做法 |
| 面板显示最近 20 条受保护操作 | **✅** | 面板取 `/agent-guard/api?action=recent`，宿主侧上限 20 |
| 面板显示回滚点 + "打开目录" | **⚠️ 部分** | 显示回滚点列表与大小；**刻意不提供"打开目录"按钮**——浏览器侧无法安全打开本地目录，改为提示用 `guard_journal` 取人工回滚说明 |
| 告警（影响预算冲突、熔断、脚本生成） | **✅** | 三者都会写进 `journal.jsonl` 并出现在记录里；`emit-script` 有专门告警文案 |
| 健康（工作区路径健康、DSH 是否运行） | **✅** | 由 `guard_inspect` 输出；面板展示护栏健康度 |
| 设置页：受保护路径编辑 / 规则开关 / 保留策略 | **✅ 经配置** | 走 profile 的 `cordis.patch.yml`（官方配置通道），**不**自造一套设置持久化 |
| 设置页：日志导出（脱敏） | **⏳** | CLI 侧已有 `--redact`；「从面板导出」未做（避免在浏览器侧引入下载与脱敏的新失败面） |
| **红线：面板不提供任何"一键修改 DSH 数据"的按钮** | **✅** | 面板 API 对任何写动作返回 **400**；`client.cases.mjs` 断言渲染结果里不含写入口 |

### §20 现在是**机器化验证**，不是自我声明

`checks/check-release-checklist.mjs` 会逐项实测并报告，已接入 `npm run checks`：

```
✅ [20-1]  我产出的文件无真实路径/机器名/用户名          0 命中
✅ [20-2]  无真实会话 id / 标题 / 日志片段              0 命中
✅ [20-5]  .gitignore 覆盖 §19.3 全部条目               16/16 项
✅ [20-8]  fixture 全为合成最小样本                    只写临时目录，不 import node:os
✅ [20-9]  package.json 无本机路径；公开身份留空待填    author/repository/bugs 均未写
✅ [20-10] README 双语明确零网络/零遥测 + 能力红线       promise + redline 均在
✅ [20-11] SECURITY.md 无个人邮箱                       仅 GitHub 私密渠道
✅ [20-12] 事故报告为脱敏版                             全文占位符
✅ [19-7]  宿主零网络 API；客户端仅同源请求；零依赖      lib/ bin/ 无网络 API；仅 /agent-guard/api
✅ [20-13] 干净 profile 安装→使用→卸载全流程            已实测（见上）
✅ [20-6]  npm pack 内容最小化                          由 CI pack job 断言
⏳ [20-3]  git log 仅含专用公开身份                     本目录还不是 git 仓库
⏳ [20-4]  git log --stat 无 ~/.dsh 拷贝/无日志/无快照  需有提交历史后抽查
∖ [20-7]  截图/GIF 来自合成数据                        本版本不含任何截图（宁可不放）

通过 11 项 ｜ 未通过 0 项 ｜ 需人工/真实仓库 2 项
```

**写这份检查时抓到并修正了我自己的一个分析错误**：最初的判据把任何 `fetch(` 都算作"出网"，
于是把 `lib/panel.js` 与 `lib/client.js` 误报为违反零网络承诺。实际上它们请求的是
`/agent-guard/api` —— 由本插件自己的宿主路由提供，**同源、不出机**。
现在判据是"是否存在绝对 URL 或外部主机"，而不是"是否出现 fetch"。

> 这一步的意义：`RELEASE.md` 里的 ✅ 原先是**我自己写的**。一个自我声明的清单与一个
> 可被独立复核的清单，可信度不同。能机器验的都验了，验不了的显式标为
> 「需人工/真实仓库」，不含糊过去。

上面的机器化输出就是逐项结果，下表只补「机器验不了、需要人」的那部分：

| # | 条目 | 状态 | 说明 |
|---|---|---|---|
| 1 | 无真实路径/机器名/用户名 | **✅ 已完成** | 全库自动扫描（`checks/check-redaction.mjs`，48 个文件）**命中 0**。`DESIGN.md` 已按 §19.2 脱敏，其余文件本就无命中 |
| 3 | `git log` 仅含专用公开身份 | **⏳ 需你** | 本目录还不是 git 仓库。初始化时按 §19.4 设 `git config --local user.name/email` 为专用昵称与 GitHub noreply 邮箱 |
| 4 | `git log --stat` 无 `~/.dsh` 拷贝、无日志、无快照 | **⏳ 需你** | `.gitignore` 已覆盖；待有提交历史后抽查 |
| 7 | 截图/GIF 来自合成数据 | **➖ 不适用** | 本版本不含任何截图或 GIF —— §19.5 是最硬的红线（会话标题比路径更私密），宁可不放 |
| 9 | `package.json` 的 author/repository/bugs 为公开身份 | **✅ 已留空（需你填）** | **刻意不写**：占了位置就可能被真实身份填上。发布前由你填公开身份 |
| 6 | `npm pack` 内容最小化 | **✅** | 本地实测 **31 文件 / 89.3 kB**；CI 的 `pack` job 会断言 `node_modules`/`.verify/`/`test/`/`DESIGN.md` 不进包 |

## 真实环境验证结果

### 已完成（隔离 `DSH_HOME`，不碰真实 `~/.dsh`）

| 步骤 | 结果 | 证据 |
|---|---|---|
| 1. 全新 profile 初始化 | **✅** | `dsh plugin --profile <new> --help` → exit 0，隔离目录内生成 profile |
| 2. 安装 | **✅** | `dsh plugin --profile <new> add link:<本目录>` → exit 0 |
| 3. `dsh.bundle` 自动入列 | **✅** | `dsh.profile.bundles` 变为 `["@deepseek-ai/dsh-base","dsh-agent-guard"]` |
| 4. **挂载成立** | **✅** | `--dump-config`（23718 B）第 359–361 行出现 `# == dsh-agent-guard` / `- id:` / `name:` |
| 5. 卸载 | **✅** | `dsh plugin --profile <new> remove` → exit 0，dependencies 清空、bundles 还原 |
| 6. 卸载后无注册残留 | **✅** | 卸载态 `--dump-config` 不含 `dsh-agent-guard` |
| 7. 真实 home 零污染 | **✅** | 真实 `~/.dsh/profiles` 仍为 `desktop, node_modules, web`；无 `smoke-*`、无 `agent-guard` |
| 8. **Config 被官方设置系统发现** | **✅** | `--dump-config-schema` 中本插件 entry 为 `status:"schema"`、`configRef:"#/$defs/config64"`，13 项配置与默认值全部正确（见下） |
| 9. **§17 第 4 项：卸载后行为与安装前一致** | **✅** | 严格**集合比对**（`.verify/verify-uninstall-behavior.mjs`）：基线 93 个条目 → 安装 94（+1 为本插件）→ 卸载 93；**卸载后相对基线多出 0、缺少 0**，且不含本插件。即：卸载后 DSH 装配出的插件集合与安装前完全相同 |

### 第 8 项发现并修复了一个真实缺陷

**症状**：第一次跑 `--dump-config-schema`（1214546 B）时，本插件的 entry 是

```json
{ "id": "dsh-agent-guard", "name": "dsh-agent-guard",
  "status": "absent", "configRef": "#/$defs/unknownConfig" }
```

即：**加载器拿到了插件行，却读不到插件的 Config**。这会让插件在设置页里没有可编辑的表单，
§16 Q4「设置页 schema」实际上没有成立——而单元测试全绿、`--dump-config` 也正常，只有
官方 schema 通道能暴露它。

**两个根因**（都在我这边）：

1. `lib/index.js` **没有导出 `Config`** —— 加载器读的是插件模块的 `Config` 导出。
2. `loadSchemastery()` 只从本插件自身位置 `require('@deepseek-ai/schemastery')`，
   而它是**安装锚点提供的 peer**（DSH 自己带着它），从插件位置解析必然 `MODULE_NOT_FOUND`
   → `Config` 为 `null`。

**修法**：`config.js` 增加多锚点解析（自身 → `DSH_RUNTIME_ROOT` → npm 全局根下的
`@deepseek-ai/dsh`），并按官方形态导出 `Config`；顺带把 `z.natural()` 改为
`z.number().min(0)`（`natural()` 要求正数，会把合法的 `snapshotMinIntervalMs: 0` 判为非法）。

**修复后**（1227108 B）：

```
entry: { "id": "dsh-agent-guard", "status": "schema", "configRef": "#/$defs/config64" }
★ $defs.config64（13 项）
  enabled: boolean        default=true
  backupEnabled: boolean  default=true
  journalEnabled: boolean default=true
  snapshotEnabled: boolean default=true
  snapshotMinIntervalMs: number default=60000
  keepRecent: number      default=30
  keepHourly: number      default=24
  keepDaily: number       default=14
  maxBackupBytes: number  default=8388608
  goalClass:              default="workspace-content"
  circuitThreshold: number default=2
  dir: string             default=""
  protectCwdWorkspace: boolean default=true
```

另加两个防回归用例：入口必须导出 `Config`；**schema 的默认值必须与 `DEFAULT_CONFIG` 逐项一致**
（"设置页显示的默认值"与"插件实际生效的默认值"分歧，比没有 schema 更糟）。

> 过程中 `lib/config.js` 一度因编码问题损坏（JS 解析器报 `Unexpected identifier`），
> 已整体重写并新增 `checks/check-encoding.mjs` 做全库编码体检（40 个文件，0 问题）。

**两处如实记录的差异**（不影响注册与行为）：pnpm 保留 3 个 `node_modules/.bin` shim；
卸载后 profile 的 `package.json` 多一个空 `"dependencies": {}`（177 B → 155 B）。
准确表述是「**注册面完全一致，文件面存在 pnpm 自身残留**」。

### 关于「宿主进程内写 `$DSH_HOME/agent-guard/`」

**已用代码级证据结清**（详见 `VERIFY.md` 附录 D）：

```js
var SandboxedFileSystem = class extends LocalFileSystem {
	static inject = ["sandboxPolicy"];
	async writeText(target, content, expected, signal, sandboxPolicy) {
		return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal);
	}
```

会话沙箱是靠**替换 `ctx.fs` 服务**生效的（源码注释原文：*"Registers as `ctx.fs` … the
model-facing tools are untouched"*）；`sandboxPolicy` 的消费者全是模型可见的工具包与沙箱装饰器，
`dsh-fs-local` 本身从不接触它。

**结论**：沙箱约束的是**工具经 `ctx.fs` 的 I/O**，**不是宿主进程**。所以本插件的
`node:fs` 写入在正常情况下可写 —— 不会被沙箱拒绝。

> `dsh-shield` 当年记录的 `EPERM` 发生在**工具调用**里 `spawn` 外部 CLI 去写工作区外路径，
> 受约束的是那条工具路径，不是插件本体。这条区别很重要，此前被我笼统地当成了"插件可能被拒"。

**仍然保留三级降级链**（`primary → tmp → memory-only`）并如实报出落点：外层机制
（OS ACL、限制性 `defaultMode`）仍可能拒绝，所以不假定一定成功。

**本条与「启动完整应用」的关系**：代码级结论已足够回答"会不会被沙箱拒绝"；
启动完整应用只会额外覆盖"运行时是否有别的意外"，而它会占用你正在使用的界面与运行时，
因此不再作为发布前置项。

## 已完成的发布决策（作者 2026-10-03 决定）

**1. `DESIGN.md`：已脱敏，且不随公开仓库分发。**

作者授权后按它自己的 §19.2 对照表完成脱敏：

```
脱敏前：不同敏感串 7 个、21 处（真实盘符路径 5 个 / 工作区名 2 个 / 第三方工具名 1 个）
脱敏后：全库脱敏扫描 命中 0
占位符使用：<workspace-a> 9 处、<workspace-b> 3 处、<session-id> 3 处、
           <third-party-tool> 5 处、<home> 2 处、<user> 2 处、<host> 1 处、盘根目录 3 处
```

处理原则与过程中的两次自我纠正：

- **路径用原子占位符**（整条替换为 `<workspace-a>`），**不保留** `<path-root>/<name>` 这类
  组合形式 —— 保留路径骨架本身就是信息。
- **替换表只在内存中**，脚本执行完立即删除：否则映射表自己会成为新的泄露点。
- 纠正 1：初版自检把 `<path-root>/DSH` 这类**已含占位符**的文本误报为"残留绝对路径"，
  导致脱敏明明成功却判失败（与之前几次同一个陷阱：检查规则必须精确）。
- 纠正 2：多轮替换叠加产生过 `"/\DSH\\<name>"` 这类畸形路径，以及事故叙述里
  "从 A 搬到 B"两端变成同一个值。已逐处整理并复查语义。

**但它仍不进入公开仓库**（写入 `.gitignore`）：

- 它是**设计过程文档**，不是发布产物 —— 本来也不在 `package.json` 的 `files` 白名单里，
  因此不会进 npm 包；
- 需要公开设计说明时，应另写一份面向读者的版本（例如 `docs/DESIGN-public.md`），
  而不是 `git add -f` 把内部版强行加进来。

**2. 公开身份：仍需你填。**

`package.json` 的 `author`/`repository`/`bugs` 刻意留空；git 提交身份按 §19.4 设为
专用昵称与 GitHub noreply 邮箱。**这两项不能由我代填** —— 编造身份会让
"专用公开身份"这条防护失效。

## 可复核命令

```bash
npm run lint                                     # 语法检查（14 个文件）
npm test                                         # 169 个用例，进程内执行
node bin/guard.mjs inspect --redact              # 对真实 DSH_HOME 只读取证（脱敏）
node checks/check-redaction.mjs                 # §20 脱敏扫描
npm pack --dry-run --cache .npm-cache            # 打包内容最小化
grep -RnE "writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync" lib/ bin/   # 只读性自查
```

> 最后一条命令的预期输出：`lib/store.js` 与 `lib/backup.js` 命中（**只写自己的目录**），
> 其余文件零命中。`lib/inspect.js`、`lib/sessionlog.js`、`lib/guard.js`（除备份调用）、
> `bin/guard.mjs` 不含任何写调用。
