/**
 * dsh-agent-guard — 宿主半边。
 *
 * 装配顺序刻意保持"只在需要时才做 I/O"：
 * 1. 解析配置；
 * 2. 决定自身数据目录（可能降级，降级会被如实报告）；
 * 3. 注册两个只读工具（`guard_inspect` / `guard_journal`）；
 * 4. 接上写前拦截（`tools/pre-execute`）；
 * 5. 接上每轮回滚点（`agent/turn-stopping`）；
 * 6. 注册同源只读面板（有 webServer 才注册）。
 *
 * 契约依据（均已实测，见 VERIFY.md）：
 * - 加载器期望顶层 `name` / `inject` / `apply(ctx, config)`；
 * - `ctx.tools.register(def)` 返回注销函数，且 `output: { schema, render }` 是必需的；
 * - 一切贡献都通过 `ctx.effect` 回收，卸载后不留注册残留。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { formatReport, guardInspect, INSPECT_SCOPES } from './inspect.js'
import { compileRules } from './rules.js'
import { resolveDshHome, probeDshState, toEngineDshState } from './hostcheck.js'
import { Config, resolveConfig } from './config.js'
import { createStore } from './store.js'
import { createJournal } from './journal.js'
import { createGuardRuntime } from './guard.js'
import { SnapshotScheduler } from './snapshot.js'
import { listSnapshots, rollbackInstructions } from './backup.js'
import { panelHtml } from './panel.js'

// 取证入口从包的单一公共入口再导出，供 CLI 与嵌入方使用。
export { formatReport, guardInspect, INSPECT_SCOPES }

// 加载器读取的配置 schema：有了它，`dsh --dump-config-schema` 才能发现本插件的配置，
// 设置页也才能渲染成表单。schemastery 不可用时为 null（加载器按「无 schema」处理，
// 插件照常工作）。
export { Config }

/** 插件名，与 package.json 一致。 */
export const name = 'dsh-agent-guard'

/**
 * 硬依赖只有 `tools`（没有工具注册表这个插件就没有入口）。
 * `webServer` 与 `sessionPersistence` 都是可选能力：缺失时降级，不报错。
 */
export const inject = ['tools']

/** 包根目录，由本模块自身位置推导（绝不硬编码路径）。 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 面板展示的历史条目数量上限。 */
const PANEL_HISTORY_LIMIT = 20

/**
 * 读取随包发布的默认规则集。
 *
 * @returns {object} 解析后的规则集。
 */
export function loadDefaultRules() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'rules', 'default.json'), 'utf8'))
}

/**
 * 构建 `guard_inspect` 工具定义。
 *
 * @param {object} [deps] - 可注入依赖。
 * @param {Function} [deps.inspect] - 取证实现。
 * @returns {object} ToolDefinition。
 */
export function createInspectTool(deps = {}) {
  const inspect = deps.inspect ?? guardInspect

  return {
    name: 'guard_inspect',
    description:
      'DeepSeek Harness 取证工具（只读）。一条命令拿到一手证据：工作区登记状态、会话身份头、'
      + '目录布局、DSH 是否在运行。它会区分「已登记 / 未登记」并给出 origin 分解，'
      + '其中 origin:"subagent" 的内部记录会被明确标注为 countsAsConversation:false——'
      + '因此「磁盘目录数 ≠ 登记数」不会被误读成数据丢失。'
      + '本工具不写任何文件、不修数据、不提供自动修复；结论里没有把握的部分会显式标为未知。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'array',
          items: { type: 'string', enum: [...INSPECT_SCOPES] },
          description: '要采集的范围。默认全部：workspaces/sessions/storage/layout/processes。',
        },
        workspace: { type: 'string', description: '可选：只输出某个工作区的路径（绝对路径）。' },
        maxSessions: { type: 'number', description: '可选：本次最多解出多少个会话身份头（默认 500）。' },
        includeHeaders: { type: 'boolean', description: '是否解出会话首帧身份头（默认 true）。关闭则只做目录级清点。' },
        redact: { type: 'boolean', description: '是否脱敏输出（路径/标题/id 换占位符），默认 false。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
      },
      render(_args, value) {
        const text = value !== null && typeof value === 'object' && typeof value.text === 'string'
          ? value.text
          : JSON.stringify(value ?? null, null, 2)
        return [{ type: 'text', text }]
      },
    },
    async execute(args) {
      const params = args !== null && typeof args === 'object' ? args : {}
      try {
        const report = inspect({
          scope: Array.isArray(params.scope) ? params.scope : undefined,
          workspace: typeof params.workspace === 'string' ? params.workspace : undefined,
          maxSessions: typeof params.maxSessions === 'number' ? params.maxSessions : undefined,
          includeHeaders: params.includeHeaders !== false,
          workspaceTitleMode: params.redact === true ? 'redacted' : 'real',
        })
        return { ok: true, text: formatReport(report) }
      } catch (error) {
        return {
          ok: false,
          text: `取证失败：${error?.message ?? String(error)}\n`
            + '这不是「没有问题」，而是「没有得出结论」。请把原始错误一并提供给用户。',
        }
      }
    },
  }
}

/**
 * 构建 `guard_journal` 工具定义：护栏自己的状态与留痕（只读）。
 *
 * @param {object} deps - 依赖。
 * @param {() => object} deps.describe - 返回护栏状态摘要。
 * @param {(limit: number) => Array<object>} deps.recent - 返回最近若干条记录。
 * @param {(id: string) => object} [deps.rollback] - 返回人工回滚说明。
 * @returns {object} ToolDefinition。
 */
export function createJournalTool(deps) {
  return {
    name: 'guard_journal',
    description:
      '查看 dsh-agent-guard 自身的运行状态与留痕（只读）：护栏是否启用、日志是否可写、'
      + '哈希链是否完整、回滚点列表，以及最近若干条受保护操作记录。'
      + '记录里只有动作、分类结果与决策，**不含命令原文**。'
      + '可用 action=trace 查看某次操作的详细记录，action=rollback 取得**人工**回滚说明'
      + '（本插件不提供自动回滚）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'recent', 'rollback'], description: '要查看的内容' },
        limit: { type: 'number', description: 'recent 专用：返回条数（默认 20，上限 100）' },
        snapshot: { type: 'string', description: 'rollback 专用：快照 id' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
      },
      render(_args, value) {
        const text = value !== null && typeof value === 'object' && typeof value.text === 'string'
          ? value.text
          : JSON.stringify(value ?? null, null, 2)
        return [{ type: 'text', text }]
      },
    },
    async execute(args) {
      const params = args !== null && typeof args === 'object' ? args : {}
      const action = typeof params.action === 'string' ? params.action : 'status'
      try {
        if (action === 'recent') {
          const limit = Math.min(100, Math.max(1, Number(params.limit ?? PANEL_HISTORY_LIMIT)))
          const rows = deps.recent(limit)
          return { ok: true, text: formatHistory(rows) }
        }
        if (action === 'rollback') {
          const id = typeof params.snapshot === 'string' ? params.snapshot : ''
          if (id.length === 0) {
            return { ok: false, text: 'rollback 需要 snapshot 参数（快照 id）。可先用 action=status 查看可用快照。' }
          }
          const result = deps.rollback(id)
          return { ok: result.ok === true, text: result.text }
        }
        return { ok: true, text: formatGuardStatus(deps.describe()) }
      } catch (error) {
        return { ok: false, text: `读取护栏状态失败：${error?.message ?? String(error)}` }
      }
    },
  }
}

/**
 * 把护栏状态渲染成可读文本。
 *
 * @param {object} status - 状态摘要。
 * @returns {string} 文本。
 */
export function formatGuardStatus(status) {
  const lines = []
  lines.push(`护栏状态：${status.enabled ? '已启用' : '已停用（配置 enabled: false）'}`)
  lines.push(`数据目录：${status.dir ?? '（仅内存，记录会丢失）'}`)
  if (status.warning !== null) lines.push(`⚠ ${status.warning}`)
  lines.push(`日志：${status.journal.records} 条，队列 ${status.journal.queued} 条，链状态 ${status.journal.chainOk ? '完整' : '异常'}`)
  if (!status.journal.chainOk) lines.push(`⚠ ${status.journal.chainDetail}`)
  lines.push(`回滚点：${status.snapshots.length} 个`)
  for (const snapshot of status.snapshots.slice(0, 10)) {
    lines.push(`  · ${snapshot.id}（${Math.round(snapshot.bytes / 1024)} KiB）`)
  }
  lines.push('')
  lines.push(`影响预算：${status.goalClass}`)
  lines.push(`备份：${status.backupEnabled ? '开启' : '关闭（受保护写入将被拒绝）'}｜快照：${status.snapshotEnabled ? '开启' : '关闭'}`)
  lines.push(`熔断阈值：同一路径连续 ${status.circuitThreshold} 次写且状态变化`)
  return lines.join('\n')
}

/**
 * 把最近记录渲染成可读文本。
 *
 * @param {Array<object>} rows - 记录。
 * @returns {string} 文本。
 */
export function formatHistory(rows) {
  if (rows.length === 0) return '暂无受保护操作记录。'
  const lines = [`最近 ${rows.length} 条受保护操作：`]
  for (const row of rows) {
    const time = typeof row.ts === 'string' ? row.ts.replace('T', ' ').slice(0, 19) : '?'
    const targets = Array.isArray(row.targets) ? row.targets.length : 0
    lines.push(
      `  · ${time}｜${row.tool ?? '?'}｜${row.action ?? '?'}｜${row.decision ?? '?'}`
      + `${targets > 0 ? `｜目标 ${targets} 个` : ''}`,
    )
    if (typeof row.reason === 'string' && row.reason.length > 0) lines.push(`      ${row.reason}`)
  }
  return lines.join('\n')
}

/**
 * 装配并返回运行时的各部件（也便于测试直接驱动）。
 *
 * @param {object} options - 装配输入。
 * @param {object} [options.config] - 用户配置。
 * @param {string} [options.dshHome] - DSH 数据目录覆盖。
 * @param {string[]} [options.workspaceRoots] - 已知工作区根。
 * @param {() => {running: boolean, detail: string}} [options.dshStateProvider] - 宿主状态提供者。
 * @returns {object} 各部件。
 */
export function createComponents(options = {}) {
  const { config, warnings } = resolveConfig(options.config)
  const dshHome = resolveDshHome(options.dshHome)
  const store = createStore({ configuredDir: config.dir ?? undefined, dshHome })
  const journal = createJournal(store, { enabled: config.journalEnabled })
  const rules = loadDefaultRules()

  const runtime = createGuardRuntime({
    store,
    journal,
    config: {
      ...config,
      buildEngine: (roots) => compileRules(rules, { dshHome, workspaceRoots: roots }),
    },
    // `workspaceRoots` 在对外 API 上允许两种形态：**数组**（已知根，静态）
    // 或**函数**（每次取最新根，动态）。运行时需要函数，所以这里统一收口。
    //
    // 早先此处直接把数组传给了要求函数的 GuardRuntime，导致 `engine()` 每次抛
    // "this.workspaceRoots is not a function"，护栏退化为对所有工具调用的
    // fail-safe 拒绝——装配层才暴露出来，单元测试看不出来。
    workspaceRoots: toRootsProvider(options.workspaceRoots),
    dshStateProvider: options.dshStateProvider ?? lazyDshState(),
  })

  const scheduler = new SnapshotScheduler({
    store,
    dshHome,
    config,
    guardVersion: readOwnVersion(),
  })

  return { config, warnings, dshHome, store, journal, runtime, scheduler, rules }
}

/**
 * 把 `workspaceRoots` 的两种输入形态统一成函数。
 *
 * 对外 API 同时接受数组（静态已知根）与函数（动态取根）。运行时只接受函数，
 * 因此这里是唯一的收口点——避免"装配层传数组、运行时当函数调"这类只有集成
 * 测试才能发现的错配。
 *
 * @param {string[]|Function|undefined} input - 用户传入的工作区根。
 * @returns {() => string[]} 取根函数。
 */
function toRootsProvider(input) {
  if (typeof input === 'function') return input
  if (Array.isArray(input)) {
    const frozen = [...input]
    return () => frozen
  }
  // 未提供时允许运行时从 agent 的 cwd 推断（见下方 resolveRootsFromAgent）。
  return () => []
}

/**
 * 构造一个**惰性 + 缓存**的宿主状态提供者。
 *
 * - 惰性：直到第一次需要判定才探测（避免插件加载时 spawn 外部命令）；
 * - 缓存：一次会话内进程/端口布局不会频繁变化，重复 spawn 无意义；
 * - fail-closed：`probeDshState()` 判不出结论时返回 `running:'unknown'`，
 *   经 `toEngineDshState()` 映射为 `running:true`（按"未停止"处理），
 *   所以探测失败**不会**意外放行核心数据写入。
 *
 * @returns {() => {running: boolean, detail: string}} 状态提供者。
 */
function lazyDshState() {
  let cached = null
  return () => {
    if (cached === null) {
      try {
        cached = toEngineDshState(probeDshState())
      } catch (error) {
        // 探测本身抛错也要 fail-closed，绝不因为"探测坏了"而放行。
        cached = { running: true, detail: `宿主状态探测异常（${error?.message ?? String(error)}），按「未停止」处理` }
      }
    }
    return cached
  }
}

/**
 * 读取本包版本，写入快照 meta。
 *
 * @returns {string|null} 版本号或 null。
 */
export function readOwnVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * 为当前输入编译一份规则引擎。
 *
 * 独立导出，便于测试与嵌入方在不装配整个插件的情况下驱动决策。
 *
 * @param {object} [options] - 引擎输入。
 * @param {object} [options.rules] - 规则集覆盖。
 * @param {string} [options.dshHome] - DSH 数据目录覆盖。
 * @param {string[]} [options.workspaceRoots] - 已登记工作区根。
 * @returns {object} 已编译的引擎。
 */
export function buildEngine(options = {}) {
  const rules = options.rules ?? loadDefaultRules()
  return compileRules(rules, {
    dshHome: resolveDshHome(options.dshHome),
    workspaceRoots: options.workspaceRoots ?? [],
  })
}

/**
 * 注册插件的全部贡献。
 *
 * @param {object} ctx - 加载器提供的 Cordis 上下文。
 * @param {object} [userConfig] - profile 里该行的 `config`。
 * @param {object} [options] - 装配覆盖项，仅供测试注入（加载器只传前两个参数）。
 * @param {string} [options.dshHome] - 数据目录覆盖，测试用来隔离到临时目录。
 * @param {string[]} [options.workspaceRoots] - 已知工作区根。
 * @param {() => {running: boolean, detail: string}} [options.dshStateProvider] - 宿主状态提供者。
 * @returns {void}
 */
export function apply(ctx, userConfig, options = {}) {
  const components = createComponents({ config: userConfig, ...options })
  const { config, warnings, store, journal, runtime, scheduler } = components
  const disposers = []

  // 配置告警必须能被看见：非法配置导致护栏静默失效，比护栏拒绝工作更危险。
  for (const warning of warnings) {
    journal.append({ action: 'config', decision: 'warning', reason: warning })
  }

  // ---- 扩展点 1：只读取证工具 ----
  // dshHome 在这里被显式绑定，工具就不再依赖调用期的环境变量——
  // 否则测试很容易在无意中读到真实的 $DSH_HOME（§12.3 纪律）。
  disposers.push(ctx.tools.register(createInspectTool({
    inspect: (inspectOptions) => guardInspect({ ...inspectOptions, dshHome: components.dshHome }),
  })))

  // ---- 扩展点 2：护栏状态与留痕（只读） ----
  disposers.push(ctx.tools.register(createJournalTool({
    describe: () => describeState(components),
    recent: (limit) => readRecent(journal, limit),
    rollback: (id) => rollbackInstructions({ store, id, dshHome: components.dshHome }),
  })))

  // ---- 扩展点 3：写前拦截 ----
  // waterfall 的返回值会被 await，所以监听器可以是异步的（备份需要）。
  if (config.enabled) {
    disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
      return runtime.handlePreExecute(exec, next)
    }))
  }

  // ---- 扩展点 4：每轮回滚点 ----
  if (config.snapshotEnabled) {
    disposers.push(ctx.on('agent/turn-stopping', async (payload) => {
      // 这里在 serial 模式下运行，可以 await；调度器自带最小间隔去抖，
      // 保证高频回合不会把回合拖慢。
      scheduler.onTurn(payload)
    }))
    disposers.push(ctx.on('agent/created', async (payload) => {
      scheduler.onTurn({ agent: payload?.agent ?? null, turn: null })
    }))
  }

  // ---- 扩展点 5：同源只读面板（缺失 webServer 时静默降级） ----
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/agent-guard',
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(panelHtml())
      },
    }))
    disposers.push(webServer.register({
      kind: 'prefix',
      path: '/agent-guard/api',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const action = url.searchParams.get('action') ?? 'state'
        const send = (status, body) => {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        try {
          // 面板只读：不提供任何"一键改数据"的动作（§9 红线）。
          if (action === 'state') send(200, describeState(components))
          else if (action === 'recent') send(200, { rows: readRecent(journal, PANEL_HISTORY_LIMIT) })
          else send(400, { error: `面板不提供该动作：${action}（本插件不提供任何一键修改 DSH 数据的功能）` })
        } catch (error) {
          send(500, { error: error?.message ?? String(error) })
        }
      },
    }))
  }

  // ---- 生命周期：一切贡献走 ctx.effect，卸载即摘除 ----
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 单项回收失败不影响其余。
      }
    }
    disposers.length = 0
  })
}

/**
 * 汇总护栏状态，供工具、面板与测试使用。
 *
 * @param {object} components - {@link createComponents} 的返回值。
 * @returns {object} 状态摘要。
 */
export function describeState(components) {
  const { config, store, journal, scheduler, dshHome } = components
  const verdict = journal.verify()
  return {
    enabled: config.enabled,
    dir: store.dir,
    durable: store.durable,
    warning: store.warning,
    storageMode: store.mode,
    journal: {
      records: journal.records,
      queued: store.queue.length,
      dropped: store.dropped,
      appendFailures: journal.appendFailures,
      chainOk: verdict.ok,
      chainDetail: verdict.detail,
    },
    snapshots: listSnapshots(store),
    goalClass: config.goalClass,
    backupEnabled: config.backupEnabled,
    snapshotEnabled: config.snapshotEnabled,
    circuitThreshold: config.circuitThreshold,
    scheduler: scheduler.describe(),
    dshHome,
  }
}

/**
 * 读取日志文件里最近的若干条记录。
 *
 * 刻意返回**解析后的对象**而不是原文：面板与工具都不该把命令原文透出去。
 *
 * @param {import('./journal.js').Journal} journal - 日志。
 * @param {number} limit - 条数。
 * @returns {Array<object>} 最近的记录（新到旧）。
 */
export function readRecent(journal, limit) {
  const text = journal.store.readFile('journal.jsonl')
  if (typeof text !== 'string' || text.length === 0) return []
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      // 解析不了的行跳过，但下面的 chainOk 会把它暴露出来。
    }
  }
  return rows.slice(-limit).reverse()
}
