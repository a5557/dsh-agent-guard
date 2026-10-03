# VERIFY.md — API 验证结论（实现前置）

> 对应 `DESIGN.md` §16「必须在创造模式中验证的 API 清单」。**每条都给证据**：实测命令输出、
> 或本机 DSH 实现里的 `文件:符号` + 原文片段。
>
> - 验证目标版本：**DSH 0.1.7-rc.2**（`@deepseek-ai/dsh` package.json `version`）
> - 运行环境：Windows，Electron 44.0.0，捆绑 Node **24.18.1**（`resources/runtime/versions.json`）；
>   会话内 `node --version` = v24.16.0
> - 实现代码位置（只读）：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*`
> - 图例：**✅ 已实证**（有输出或代码原文） / **⚠️ 部分实证**（有证据但需运行时复核） / **❌ 无此能力**（→ 走降级）
>
> **纪律**：本文不含任何真实会话标题、真实工作区名、真实会话 id。会话目录名与计数按 §19.2 规则脱敏。

---

## 摘要表（一屏结论）

| # | §16 问题 | 结论 | 对设计的影响 |
|---|---|---|---|
| 1 | 是否存在"工具执行前"的拦截钩子？ | **✅ 存在，且能硬拦截** | §10.1 走"有钩子"分支：可实现真正 `deny`，**不需要**降级 |
| 2 | 会话事件的准确名称与载荷？ | **✅ 已列出精确签名** | P3/P5 用 `session/event` + `agent/turn-stopping`；标题可用 `sessionQuery.readTitleSnapshots` |
| 3 | 客户端面板挂载 API？ | **✅ 挂载点存在；⚠️ 必须打包产物** | `sidebar.panellist` + `main`；client 半边需 tsdown 构建，**无零构建发布路径** |
| 4 | 设置页 schema 与持久化？ | **✅ `settings.section` + 静态 `Config`（schemastery）** | 设置页可做；用户配置落到 profile 的 `cordis.patch.yml` |
| 5 | 能否读到当前会话目标/标题？ | **✅ 可读，但刻意不读标题** | `sessionQuery.readTitleSnapshots()` 与 `ctx.goals.get(agent)` 均可用；**隐私考虑不纳入日志** |
| 6 | `!!js` 在 `cordis.patch.yml` 的能力边界？ | **✅ 只用 YAML 字面量即可，无需 `!!js`** | patch 保持最小；`!!js` 不使用 |
| 7 | 插件自身数据目录的推荐位置？ | **❌ 无官方 API；有 `$DSH_HOME/<name>` 惯例** | 自定 `$DSH_HOME/agent-guard/`；可用 `!!js dshHomePath(...)` 注入 |
| 8 | 卸载钩子是否存在？ | **❌ 无**（只有 Cordis fiber 回收） | 卸载**不删**用户回滚点；README 给手动清理步骤 |
| 附 A | 会话文件身份头能否零依赖解码？ | **✅ 74/74 成功，零依赖** | P1/G-1 可零依赖实现（本次最大的可行性发现） |
| 附 B | 是否存在覆盖全部写操作的底层钩子？ | **❌ `fs/write-intent` 不能否决、也不覆盖 pwsh/bash** | 拦截必须锚定 `tools/pre-execute`，并诚实声明旁路 |
| 附 C | `dsh.capabilities` / `capabilityRedLines` 是清单字段吗？ | **❌ 不是**，仅是社区目录惯例 | 写进 README/SECURITY.md，**不写进 package.json** |

**一句话**：设计文档 §10.1 里"取决于宿主钩子"的不确定性，实测**倾向于有钩子**——`tools/pre-execute`
是真实的前置否决点，`deny` 会在工具体执行前短路。因此本插件可以**诚实宣称"能阻止"**，
但仍必须按 §10.1 列出已知旁路（见下文 Q1.5）。

---

## Q1. 「工具执行前」的拦截/否决钩子

**结论：✅ 存在。** 两条可用通道，语义不同：

| 通道 | 形态 | 能力 |
|---|---|---|
| `tools/pre-execute`（事件，waterfall） | `(this: Scoped<ToolRuntime>, exec: ToolExecution, next) => Promise<PreToolDecision>` | `allow` / **`deny`（带理由）** / `cancel` / `ask`（转审批） |
| `ctx.tools.guard(guard)`（服务方法） | `ToolGuard = (execution: Readonly<ToolExecution>) => string \| undefined` | 同步；返回字符串即拒绝。在 `tools/pre-execute` 之后执行 |

### Q1.1 是否为硬拦截（`deny` 会不会真的阻止写盘）——**实证代码**

`dsh-tools/lib/index.js` → `ToolRuntime.prepareExecution`（约 3214–3267 行）：

```js
const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec,
  () => Promise.resolve({ kind: "allow" }));
const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : {...};
...
if (decision.kind === "cancel") return await next({ kind: "post-result", result: toolAbortedBeforeDispatchResult() });
const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
...
if (denialReason !== void 0) return await next({ kind: "post-result", exec,
  result: this.materializeFinalResult({ content: [{ type: "text", text: `Error: ${denialReason}` }],
    isError: true, error: { message: denialReason, ... } }) });
...
return await next({ kind: "dispatch", exec });   // ← 只有走到这里才真正执行工具
```

**关键推论**：`deny` 走的是 `post-result` + `isError` 结果，**`dispatch` 永不发生** → 工具体不执行
→ **文件不会被写**。这是真正的拦截，不是"事后告警"。

### Q1.2 监听器能否是慢的/异步的（能否在放行前先做备份）

**✅ 可以。** 代码里 `await this.ctx.waterfall(...)`：waterfall 的返回值被 `await`，
监听器返回 Promise 时会被等待。因此可以在 `pre-execute` 里 `await` 一次文件复制（备份）后再返回决定。

⚠️ 但设计文档 §6.6 的"纯函数、无 I/O"原则仍应保持：**决策**是纯函数，
**备份副作用**放在决策返回之前的独立步骤里，二者在代码上分离以便单测。
另注意事件文档明确写着："Async gates must observe `exec.signal`" → 长任务必须监听 `exec.signal`。

### Q1.3 `exec` 上能拿到什么（能否提取目标路径）

`dsh-tools/lib/types/index.d.ts` → `ToolExecutionInput`（216–242 行）原样：

```ts
export interface ToolExecutionInput {
    readonly callId: ToolCallId;
    readonly rootCallId?: ToolCallId;
    readonly name: string;
    readonly schema?: ToolSchema;
    /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
    readonly arguments: unknown;          // ← 已解析的参数：目标路径从这里提取
    readonly agent?: Agent;               // ← 调用方 agent（含 id）
    readonly parent?: ToolExecutionToken; // ← PTC 子派发标记
    readonly signal: AbortSignal;         // ← 取消信号，必须监听
}
```

`ToolExecution extends ToolExecutionInput` 并额外带 `rootCallId` / `token`。
→ **`exec.name` + `exec.arguments` 足够做规则分类**（例：`write` 的 `file_path`、`pwsh` 的 `command`）。

> ⚠️ 仍不确定：`exec.agent` 的类型是 `Agent`（`{ readonly id: SessionId }`），
> 但事件签名把 `this` 标成 `Scoped<ToolRuntime>`；`exec.agent.id` 的具体可用性留给
> 运行时冒烟测试确认（实现里防御性读取 `exec.agent?.id`，缺失则记为 `unknown-session`，不崩）。

### Q1.4 `deny` 与 `guard` 的优先级

`deny` 出现在 waterfall 里时：`decision.kind === 'allow'` 才查 guard。即
**waterfall 的 `deny` 直接生效，不需要经过 guard 链**；两者是"或"关系（任一拒绝即拒绝），
文档亦载明 "no guard can force-allow a call another guard denied"。

### Q1.5 已知旁路（**必须写进 README 的诚实声明**）

| 通道 | 是否经过 `tools/pre-execute` | 依据 |
|---|---|---|
| 模型直调原生工具（`write`/`edit`/`pwsh`…） | ✅ 经过 | 上述 `prepareExecution` 是唯一入口 |
| PTC（`run_code`）内部子派发 | ✅ 经过（`parent` 非空） | 类型注释：PTC 子派发同样走 registry；`mode:'ptc'` 下无 parent 的原生调用在策略前即被拒 |
| 子代理 / Agent Teams 的工具调用 | ✅ 经过 | 同一 `ToolRuntime`，按 scope 过滤投递 |
| `guard()` 注册的守卫 | ✅ 在 waterfall 之后 | 服务方法文档 |
| **用户手工双击 `.bat` / 在外部终端跑脚本** | ❌ **不经过** | 插件在宿主进程内，管不到进程外动作 → §12.2 G-4 只能"生成即告警"，不能阻止 |
| **另一个 DSH 进程 / 其他应用写同一路径** | ❌ 不经过 | 同上 |
| **插件自身代码的直接 `node:fs` 调用** | ❌ 不经过 | 自身即信任域 |

→ 因此 README 的正确措辞是"**能阻止本会话内 agent 的工具调用**"，
而不是"能阻止一切破坏"。这与 §10.1 的要求一致。

---

## Q2. 会话事件名称与载荷（P3 / P5 依赖）

全部来自宿主 Event 目录的**活体**签名（`cordis_inspect_list`/`listEvents`），非文档推测。
与本插件相关的精确签名：

```
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void          // mode: emit
'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void               // mode: parallel（可 await）
'agent/created'(this: Scoped<Agent>, payload: { agent, source, signal? }): undefined | Promise<undefined>  // mode: serial
'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent, turn, signal }): Promise<void> | void          // mode: serial
'agent/status'(this: Scoped<Agent>, payload: { agent, status: AgentStatus }): void
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next): Promise<PreToolDecision>   // 见 Q1
'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
```

**用途映射**：

- **P5 留痕**：`tools/pre-execute`（决定）+ `tools/result`（真实结果）配对 → `journal.jsonl` 一条记录。
- **P3 每轮快照**：`agent/turn-stopping`（"本轮即将结束"，serial 可 await）比 `turn/start` 更稳：
  它保证在 turn 关闭前拿到一次 await 机会。**注意**：设计文档 §8 写的是 `turn/start`；
  实测更合适的锚点是 `agent/turn-stopping`，因为它明确可以被 await（serial 模式），
  不会与正在进行的写操作竞争。→ **实现时两个都订阅，以 `turn-stopping` 为主**。
- **⚠️ 待复核**：`SessionEvent` 的具体 variant 名（`turn/start`、`tool/call`…）本次未逐条展开，
  实现时按 `session/event` 的实际载荷打印一次再定稿（避免猜类型名）。

---

## Q3. 客户端面板挂载 API

**挂载点：✅ 存在（活体 Slot 树实证）**。**产物：⚠️ 需要 `window.__ModuleLoader__` bundle。**

### Q3.1 挂载点（活体查询 `Slots.listSubTree` 原文）

| Slot | kind | 注册键 | 用途 |
|---|---|---|---|
| `sidebar.panellist` | list | `{ id, order?, label? }` | "Global panel icons" ← 侧边栏图标位 |
| `main` | keyed | `{ key }` | "Central panel selected by sidebar entry id" ← 主面板（已占用：`conversation`） |
| `settings.section` | list | `{ id, order?, label? }` | "One settings page per list entry" ← 设置页 |
| `sidebar.footer.action` | list | `{ id, order?, label? }` | 侧边栏底部动作 |

**关键**：`main` 的语义是"**由 sidebar entry id 选中的中央面板**" → `sidebar.panellist` 的 `id`
与 `main` 的 `key` 取同一个字符串，即构成"点图标→开面板"的完整体验（官方 jobs/schedule 即此形态）。

### Q3.2 bundle 产物契约（实证）

`dsh-client-modules/lib/index.js`：

```js
if (decl === void 0 || decl.platform !== "web") { ... }             // 713–714
if (clientRel === void 0) throw new Error(
  `client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);   // 719
```

→ 声明 `dsh.client` **必须**在 package.json `exports` 里提供 `"./client"`，否则**加载即抛**。
`dsh.client` 的合法字段（`parseDshClient`，63–70 行）：`platform`（必填字符串）、
`inject`（字符串数组，可选）、`external`（字符串数组，可选）、`immediately`（布尔，可选）。

官方产物形态（`dsh-client-ui-jobs/lib/client.js` 首尾原文）：

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-jobs",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const css = "...";           // CSS 以字符串内联，运行时注入
		...
		exports.inject = inject;
		return module.exports;
	}
});
```

→ **结论**：该契约能以**手写**方式满足（不需要 TS/JSX 构建：可用 `React.createElement`），
`react` 与官方包通过 `require` 从模块表取。本项目 `lib/index.js` 有**先例**：
`dsh-shield/docs/plugin-api-notes.md` §0.5 与 §2 记载了已实测可用的一版手写 client 半（`settings.section`
+ `tool.view.cordis`）。

**v1 决策（双轨，按可验证性排序）**：

1. **主路径（必做）**：宿主侧 `webServer.register({ kind:'exact', path:'/agent-guard', handler })`
   提供**零构建、纯 HTML** 面板（`webServer.register` 已在 `dsh-shield` 实测可用）；
2. **增强路径（可选）**：手写 `lib/client.js` 注册 `sidebar.panellist` + `main` + `settings.section`，
   把同一份数据渲染成原生面板。**若冒烟测试失败则整体摘除**，不留半成品。

---

## Q4. 设置页 schema 与持久化位置

- **挂载点**：`settings.section`（list，`{ id, order?, label? }`）——活体实证；先例见 `dsh-shield` §2.1。
- **持久化**：走插件自身的 Cordis `Config`（schemastery / `z`），**不依赖** `dsh-settings`。
  官方插件即以 `static Config` 声明，用户改 profile 的 `cordis.patch.yml` 中该行的 `config:`；
  本机 `profiles/desktop/cordis.patch.yml` 实测就是这个形态（`id` + `name` + `config` 三键）。
- **导出/脱敏**：§19.7 的 `guard export --redact` 由插件工具实现，不牵扯宿主设置系统。

---

## Q5. 能否读到当前会话的目标/标题（影响预算分类）

- **会话标识：⚠️ 部分实证。** `Agent` 类型仅暴露 `{ readonly id: SessionId }`；
  `exec.agent?.id` 是预期路径，但**未运行时验证** → 实现中防御性读取。
- **会话标题：❌ 不建议依赖。** 标题由 `dsh-session-title*` 生成，属另一套服务的内部投影，
  且把标题送进分类器会引入"把用户私人内容读进日志"的隐私风险（违反 §19.7）。
- **因此 §6.4 的影响预算改为**：
  1. 默认标签按**工作区线索 + 用户显式文字授权**判定；
  2. **升级只能由用户显式确认**（原本就是 §6.4 的硬规则）；
  3. 不读标题、不读消息正文 → 分类器只吃"工具名 + 目标路径 + 用户在本会话里显式给出的授权语句"。
- ⚠️ 待复核：`goal` 服务的 `get(agent)` 可读会话目标，但目标文本同样可能含私人内容 →
  **只在内存中用于判定，绝不写入 `journal.jsonl`**（日志只记分类结果，不记原文）。

---

## Q6. `!!js` 在 `cordis.patch.yml` 的边界

**✅ 不需要 `!!js`。** 本插件挂载只需最小 patch（与 `dsh-shield/cordis.patch.yml` 同形，已实测可用）：

```yaml
- insert:
    - id: dsh-agent-guard
      name: dsh-agent-guard
```

`package.json` 侧（`dsh-shield/package.json` 实测可用）：

```json
{ "main": "lib/index.js", "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

宿主半导出形状（实测可用）：`export const name`、`export const inject`、`export function apply(ctx)`。
→ 设计文档 §3.2 说 `patch` "0.1.7 起可以是数组"；**本插件不需要数组**，用字符串即可，
少一处不确定性。

---

## Q7. 插件自身数据目录的推荐位置

**❌ 无官方约定。** 实证：`dsh-home-paths`（107 行的完整实现）只导出
`resolveDshHome` / `dshHomePath` / `dshCachePath` / `dshHomeDisplay` / `canonicalizeWatchPath` 等**通用**助手，
**没有任何按插件名分配数据目录的 API 或命名约定**；`resolveDshHome` 的优先级为
"显式配置 > `$DSH_HOME` > `~/.dsh`"，并明确"harness keeps all user data under one root"。

**决定**：数据目录 = `$DSH_HOME/agent-guard/`（可用设置覆盖），
即设计文档 §5 的选择。理由（写进 README + SECURITY.md）：
1. 与"所有用户数据在一个根下"的宿主原则一致，便于用户备份/清理；
2. 与 DSH 私有的 `sessions/`、`storages/`、`profiles/` **并列而不在其中** → 永不写受保护路径；
3. 自身目录同时列入 §6.1 受保护路径（防其他插件/agent 改我们的日志）。

---

## Q8. 卸载钩子

**❌ 不存在插件级"卸载回调"。** `dsh-plugin-manager` 里未发现 uninstall 生命周期钩子
（grep `uninstall|dispose.*remove|lifecycle.*uninstall` 于其 `lib/index.js` → **0 匹配**）。
插件唯一的回收机制是 Cordis 的 **fiber 效应回收**：`ctx.effect(() => () => {...})`、
`ctx.tools.register()` 等返回的 disposer（`dsh-shield` §4 已实测该模式）。

**因此"卸载后行为与安装前一致"（§14/§17.4）的正确实现是**：
1. 所有注册都走 `ctx.effect` / disposer → 卸载即摘除，**不留任何注册残留**；
2. **绝不**在卸载时删用户数据（回滚点/日志是用户的资产，§8 明确"不删用户回滚点"）；
3. README 写明：卸载后 `$DSH_HOME/agent-guard/` 会保留，附**手动**清理步骤（用户自己决定）。

---

## 附：会话文件身份头可零依赖解码（P1 / G-1 的可行性前提）

设计文档把"解压会话首帧身份头"当作关键能力（§7、§12.2 G-1），但未确认零依赖可行性。
**本次实测：✅ 完全可行，零运行时依赖。** 详见 `.verify/session-format-evidence.md`（含探针脚本）。

- 容器 = **多个 zstd 帧首尾相接**，文件第 0 字节即 zstd 魔数 `28 b5 2f fd`（无额外包头）；
- `node:zlib` 内建 `zstdDecompressSync()` **遇首个帧结束即返回** → 恰好就是身份头；
- 全库实测：**74 个会话目录 / 74 个身份头全部解出，0 失败**（另有 102 个"代际文件"，
  见附录 C：一个会话目录内可能同时存在 v0/v3/v4 多个文件，**只能数目录，不能数文件**）；
- `origin` 计数：`subagent` = **43**，无该字段（= 用户对话）= **31**；
- **判据必须写成 `origin === 'subagent' || (delegationDepth ?? 0) > 0` → `countsAsConversation: false`**：
  用户对话**根本没有 `origin` 字段**，任何 `origin === 'user'` 的写法会把真实对话全部误判。
  宿主自己的显示过滤就是 `if (session.origin === "subagent") return false;`。
  这是必须进单测的坑。

**读取实现必须处理的边界**（实测：会话文件在两次读取间由 138,936 → 154,840 字节，正在被写入）：
解码失败 → `unreadable`（warn）；JSON 缺 `type`/`id` → `incomplete`（warn）；
**只有明确成功才允许参与"是否算对话"的判定**，绝不把"读不出来"静默当成"无记录"（否则重演 R2）。

---

## 附录 A：拦截能力与**已知旁路**（诚实声明，必须进 README）

**能拦住的**（均由 `tools/pre-execute` 覆盖，`deny` 在 `dispatchToolBody` 之前短路）：

| 通道 | 依据 |
|---|---|
| 模型直调原生工具（`write` / `edit` / …） | `configureExecution` 是唯一入口 |
| MCP 工具 | MCP 工具按普通工具注册，走同一 registry |
| PTC `run_code` 内部子调用 | 同一 `scheduler.prepare` |
| 进程内子代理 / workflow 子代理 | 共享 `ToolRuntime` |

**拦不住的**（README 必须逐条写明）：

| 旁路 | 原因 |
|---|---|
| `pwsh` / `bash` 里的改名、删除 | 宿主**没有** rename/delete 工具，这些动作只以**不透明命令行文本**出现；正则提取路径只是启发式，不构成保护承诺 |
| 后台任务（`run_in_background`） | 命令交给 job registry；前台调用若超时会被**提升**为 job，而 `pre-execute` 早已执行完 |
| 宿主终端（`ctx.terminals`） | `dsh-terminal` 不注册任何工具，是 PTY 服务 |
| 客户端/HTTP 宿主 API（如 workspace rename/delete） | 不经过工具流水线 |
| 用户手工双击脚本、其他进程写同一路径 | 插件在宿主进程内，管不到进程外 |

**结论**：正确措辞是"能阻止**本会话内 agent 的工具调用**"，而非"能阻止一切破坏"。
另有一条**性能边界**：`pre-execute` **没有超时**且运行在**单一有序通道**里，
在其中做备份会阻塞本轮且中途不可取消 → **备份预算必须很小**（见附录 C 的 S3 设计约束）。

## 附录 B：`!!js`、卸载钩子与数据目录

- **`!!js` 不需要**：本插件 patch 只有 `- insert: [{ id, name }]` 三行；
  配置若需自身目录，宿主提供 `!!js dshHomePath('agent-guard')` 的注入惯例（boot 时 `ctx.provide("dshHomePath", ...)`）。
- **无卸载钩子**：`dsh-plugin-manager` 中没有 uninstall 生命周期缝；卸载只是移除依赖 + 从 bundle 列表里去掉名字。
  残留会包括：`$DSH_HOME` 下的插件数据、`<profile>/.plugin-manager/logs/**`、`compatibility.json`、
  以及**手写 patch 行**（此后启动只会警告 `entry %C not found`）。
- **数据目录无官方 API**，惯例是 `$DSH_HOME/<name>`；本插件用 `$DSH_HOME/agent-guard/`，
  并在 §5 的保留策略里声明"只删自己的快照"。
- **`dsh.capabilities` / `capabilityRedLines` 不存在于 0.1.7-rc.2 清单类型**（仅社区目录惯例）
  → 如实声明写进 `README` / `SECURITY.md`，**不写进 `package.json`**（写了也不会被读取）。

## 附录 C：会话存储的精确契约（实现依据）

1. 布局：`$DSH_HOME/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session[.vN].jsonl.zstd`。
   后缀是 **`.jsonl.zstd`**。`projectKey` 算法已逐行复刻并**对真实库 9/9 命中**（见 `lib/encoding.js`）。
2. **代际文件共存**：同一会话目录内可能同时有 `session.jsonl.zstd`(v0) 与 `.v3` / `.v4` → **数目录，不数文件**。
3. 注册表：`$DSH_HOME/storages/workspace.json`，`tables.workspaces.<id>.sessionIds` **就是**登记清单；
   `global.workspaceIds` 是显示顺序，`global.archivedSessionIds` 是归档集。
4. "未登记 ⇒ 子代理"**是常态但不是不变量**：注册只由 `Workspace.attachSession`（API 创建/分叉/webhook）
   加上一次性 bootstrap 写入，而 **bootstrap 没有 origin 过滤**；一个未登记的 id 也可能是目录已不在的会话。
   → **分类永远来自首帧 header，绝不来自记账。**
5. **优先使用官方廉价 API（v1 起）**：`ctx.sessionPersistence.stat(id)` / `.list()` 返回
   `SessionPersistenceSnapshot{header,…}`，官方文档明确"不读取事件日志"（后端只读首帧）；
   `ctx.sessionQuery.listSessions()` 一次拿到全量 header。
   → v0 的 CLI 在**宿主进程之外**运行，所以使用 `node:zlib` 自行解码（零依赖，已实测 74/74）；
   插件半边应优先走官方 API，自行解码只作为无宿主时的后备。

---

## 附录 D：会话沙箱究竟约束谁（**代码级结论**）

这一条原本列为「未验证项」，现在有确切答案了。**它是读实现得出的代码级结论，不是运行时观测**，
两者区别在下面标注。

**机制**（`dsh-fs-sandbox`）：

```js
var SandboxedFileSystem = class extends LocalFileSystem {
	static inject = ["sandboxPolicy"];
	async writeText(target, content, expected, signal, sandboxPolicy) {
		return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal);
	}
```

- 沙箱是通过**替换 `ctx.fs` 服务**生效的（注释原文："Registers as `ctx.fs` … together with a
  `ctx.sandboxPolicy`, is the whole swap — **the model-facing tools are untouched**"）。
- `sandboxPolicy` 的消费者全是**工具包**（`dsh-tool-fs` / `dsh-tool-pwsh` / `dsh-tool-bash` /
  `dsh-bash-sandbox` / `dsh-pwsh-sandbox` / `dsh-ptc-runtime-node` …）与 `dsh-fs-sandbox` 装饰器本身；
  **`dsh-fs-local` 完全不处理它**。

**结论**：会话沙箱约束的是「**工具经 `ctx.fs` / 经沙箱包装的 shell 所做的 I/O**」，
**不是宿主进程本身**。因此：

| 行为 | 是否受会话沙箱约束 |
|---|---|
| 模型调用 `write`/`edit` 工具 | ✅ 受约束（`dsh-tool-fs` 按会话解析出 policy） |
| 模型调用 `pwsh`/`bash` 且走 sandbox 包装 | ✅ 受约束 |
| **插件在宿主进程内直接 `node:fs.writeFileSync`** | ❌ **不受约束** |

**对本插件的含义**：`lib/store.js` 直接用 `node:fs` 写 `$DSH_HOME/agent-guard/`，
因此**在正常情况下应当可写**，不会像 `dsh-shield` 那样遇到 `EPERM`。
（`dsh-shield` 当年那次 `EPERM`，是在**工具调用**里 `spawn` 外部 CLI 去写工作区外路径 ——
受约束的是那条工具路径，不是插件本体。）

**这同时是一条必须诚实声明的边界**：本插件因此**绕过**了会话沙箱。这不是权限提升
（它活在宿主进程里，本来就有这个能力），但必须写清，否则会给人"插件在沙箱内"的错觉。
已在 `SECURITY.md` 的能力红线里注明。

**仍未被运行时观测覆盖的部分**：某些部署可能用更外层的机制（例如操作系统级 ACL、
或限制性的 `defaultMode`）影响宿主进程本身。因此代码里仍保留了**三级降级链**
（`primary → tmp → memory-only`），并把降级如实报出来，而不是假定一定可写。

---

## 仍未结清的项（实现时按此顺序复核）

| 项 | 复核方式 | 若否的降级 |
|---|---|---|
| `exec.agent?.id` 在 `pre-execute` 中可取（无 `exec.cwd`，需 `agent.session.header.cwd`） | 插件首次加载时打一条 debug 日志 | 会话标记为 `unknown`，不崩、不误判 |
| `SessionEvent` 的 variant 精确名 | 订阅 `session/event` 打印一次真实载荷 | 只用 `tools/*` 事件（已足够覆盖 P5） |
| 手写 client bundle 能否被 `__ModuleLoader__` 接受（**官方要求 tsdown 构建**） | 装到**全新 profile** 冒烟测试 | 摘除 client 半，只留同源 HTTP 面板 |
| `agent/turn-stopping` 的 await 时机 | 快照耗时打点，确认不与写竞争 | 退回 `turn/start`，并加去抖 |
| ~~宿主进程内写 `$DSH_HOME` 是否受会话沙箱限制~~ | **已结清：见附录 D**（代码级结论：沙箱约束工具 I/O，不约束宿主进程） | 仍保留三级降级链兜住例外情况 |
| `dsh-tool-str-replace-editor` 注册的**确切工具名** | 从 `ctx.tools.schemas()` 打印一次 | 按 `edit` 的别名列表兜底，未知工具名一律走启发式 |

> 最后两项来自 `dsh-shield` 的实测教训：插件在宿主进程内，但**会话文件策略为 `workspace-write` 时，
> 插件写工作区之外的路径可能被拒**（记录于 `plugin-api-notes.md` §3）。
> 本插件的日志/快照都写 `$DSH_HOME/agent-guard/`（工作区之外），**必须在真实环境验证一次**；
> 这也是 §12.3"临时 DSH_HOME"测试纪律之外必须做的唯一一次真实 I/O 验证。
