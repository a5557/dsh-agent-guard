/**
 * 执行层：把规则引擎、写前备份、留痕接到 `tools/pre-execute` 上。
 *
 * 这是整个插件**唯一**会否决工具调用的地方，也是唯一会在 `pre-execute` 里做 I/O 的地方。
 *
 * ## 为什么锚定 `tools/pre-execute`
 *
 * 实测（VERIFY.md 附录 A）：`prepareExecution` 是工具执行的唯一入口，`deny` 会在
 * `dispatchToolBody` **之前**短路，所以工具体根本不会执行——这是真正的拦截。
 * 相对地，`fs/write-intent` **不能否决**，而且 `pwsh`/`bash` 从不上报它，所以不能把它
 * 当文件写总闸。
 *
 * ## 性能约束（很重要）
 *
 * `pre-execute` 没有超时，而且运行在**单一有序通道**里：在这里做的任何 I/O 都会阻塞本轮，
 * 且中途不可取消。因此：
 * - 决策本身是内存里的纯函数；
 * - 只有「受保护路径 + 需要备份」时才做一次有上限的文件复制；
 * - 超过上限 → **拒绝写入**，绝不无备份放行。
 *
 * ## 诚实边界
 *
 * 本模块拦不住：`pwsh`/`bash` 里的改名删除（命令文本不透明）、后台任务、宿主终端、
 * 客户端 API，以及用户手工双击脚本。README 必须逐条写明，不得宣称"能阻止一切破坏"。
 */

import { existsSync, statSync } from 'node:fs'

import { classifySafely, detectEmittedScript, inferAction } from './rules.js'
import { backupFileBeforeWrite } from './backup.js'
import { commandDigest } from './journal.js'
import { describePath } from './paths.js'

/** 同一个路径连续写多少次之后进入熔断观察。 */
export const CIRCUIT_THRESHOLD = 2

/** 熔断状态在内存里保留多久（毫秒）。 */
const CIRCUIT_TTL_MS = 30 * 60_000

/**
 * 从工具执行上下文里解析会话 id 与工作目录。
 *
 * 实测（VERIFY.md 附录 C）：`Agent` 的公共面只有 `id`，运行时面额外有 `session`，
 * 而 `session.header.cwd` 是权威的工作目录。没有 `exec.cwd` 这种东西。
 * 解析不出来时返回 null —— 标记为「未知」，不猜、不崩。
 *
 * @param {unknown} exec - 工具执行对象。
 * @returns {{sessionId: string|null, cwd: string|null}} 解析结果。
 */
export function resolveAgentContext(exec) {
  const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined
  if (agent === null || typeof agent !== 'object') return { sessionId: null, cwd: null }

  const session = agent.session
  const header = session !== null && typeof session === 'object' ? session.header : undefined

  const sessionId = typeof agent.id === 'string'
    ? agent.id
    : header !== null && typeof header === 'object' && typeof header.id === 'string'
      ? header.id
      : null

  const cwd = header !== null && typeof header === 'object' && typeof header.cwd === 'string'
    ? header.cwd
    : null

  return { sessionId, cwd }
}

/**
 * 记录「同一路径连续写且校验摘要变化」的状态，用于熔断（§6.5 / T7）。
 *
 * 只保存路径的哈希、大小与 mtime，不保存文件内容，也不保存命令原文。
 */
export class CircuitTracker {
  /**
   * @param {{threshold?: number, ttlMs?: number, now?: () => number}} [options] - 选项。
   */
  constructor(options = {}) {
    this.threshold = Number(options.threshold ?? CIRCUIT_THRESHOLD)
    this.ttlMs = Number(options.ttlMs ?? CIRCUIT_TTL_MS)
    this.now = options.now ?? (() => Date.now())
    this.entries = new Map()
  }

  /**
   * 读取某条路径的当前摘要（大小 + mtime 取整）。
   *
   * @param {string} target - 文件路径。
   * @returns {string|null} 摘要，读不到时为 null。
   */
  probeDigest(target) {
    try {
      if (!existsSync(target)) return 'absent'
      const stat = statSync(target)
      return `${stat.size}:${Math.round(stat.mtimeMs)}`
    } catch {
      return null
    }
  }

  /**
   * 在放行一次写之前，判断是否应触发熔断。
   *
   * @param {string} target - 目标路径。
   * @returns {{pause: boolean, writes: number, changed: boolean}} 判定结果。
   */
  inspect(target, digestBefore) {
    const key = target
    const now = this.now()
    const previous = this.entries.get(key)
    if (previous !== undefined && now - previous.at > this.ttlMs) this.entries.delete(key)

    const current = this.entries.get(key)
    if (current === undefined) {
      return { pause: false, writes: 0, changed: false }
    }

    const changed = current.digest !== null && digestBefore !== null && current.digest !== digestBefore
    const writes = current.writes + 1
    return { pause: writes >= this.threshold && changed, writes, changed }
  }

  /**
   * 记录一次已放行的写。
   *
   * @param {string} target - 目标路径。
   * @param {string|null} digestAfter - 写完后的摘要（调用时取，可能拿不到）。
   * @returns {void}
   */
  record(target, digestAfter) {
    const previous = this.entries.get(target)
    this.entries.set(target, {
      writes: (previous?.writes ?? 0) + 1,
      digest: digestAfter,
      at: this.now(),
    })
  }
}

/**
 * 决定一次工具调用该怎么处理。**纯决策**，不产生任何副作用。
 *
 * 把决策与副作用分开，是为了让 T1–T9 这类用例可以只测决策；副作用在
 * {@link GuardRuntime.handlePreExecute} 里按决策执行。
 *
 * @param {object} input - 决策输入。
 * @param {object} input.engine - 已编译的规则引擎。
 * @param {string} input.toolName - 工具名。
 * @param {unknown} input.args - 已解析的参数。
 * @param {object} input.dshState - `{running: boolean, detail: string}`。
 * @param {object} [input.budget] - `{goalClass: string}`。
 * @returns {{decision: object, action: string, targets: string[], note: string|null}} 决策结果。
 */
export function decideToolCall(input) {
  const inferred = inferAction(input.toolName, input.args)
  const decision = classifySafely(inferred.action, inferred.targets, {
    engine: input.engine,
    dshState: input.dshState,
    budget: input.budget ?? { goalClass: 'workspace-content' },
  })

  // G-4：`emit-script` 是一个独立形态——**生成**引用受保护路径的可执行脚本。
  // 它不禁止，但必须告警（§6.2 默认决策：附回滚说明、UI 高亮、绝不"一键"）。
  // 放在常规分类之后覆盖，因为"写一个 .bat"本身可能只是普通工作区写入。
  if (inferred.action === 'write' && inferred.content !== null) {
    const emitted = detectEmittedScript({
      target: inferred.targets[0] ?? '',
      content: inferred.content,
      engine: input.engine,
    })
    if (emitted.isEmitScript) {
      return {
        decision: {
          kind: 'require-confirmation',
          reason: '正在生成一个引用受保护路径的可执行脚本：这类脚本绝不能做成"一键交给用户双击"的形态'
            + '（这正是历史事故的 root cause R4）。需要确认，并且必须附上人工回滚说明。',
          code: 'emit-script',
          warning: '不得把 agent 的不确定性转成用户的一次双击（DESIGN.md R4）',
          requiresBackup: false,
          classification: decision.classification,
          targets: decision.targets,
          emittedScript: { referenced: emitted.referenced },
        },
        action: 'emit-script',
        targets: inferred.targets,
        note: 'generated-script-references-protected-path',
      }
    }
  }

  return { decision, action: inferred.action, targets: inferred.targets, note: inferred.note }
}

/**
 * 运行时：持有日志、存储、引擎，并把决策执行到底。
 */
export class GuardRuntime {
  /**
   * @param {object} options - 构造输入。
   * @param {import('./store.js').GuardStore} options.store - 插件存储。
   * @param {import('./journal.js').Journal} options.journal - 日志。
   * @param {object} options.config - 生效配置。
   * @param {() => string[]} options.workspaceRoots - 取当前工作区根的方法。
   * @param {() => {running: boolean, detail: string}} [options.dshStateProvider] - 取宿主状态。
   */
  constructor(options) {
    this.store = options.store
    this.journal = options.journal
    this.config = options.config
    this.workspaceRoots = options.workspaceRoots
    this.dshStateProvider = options.dshStateProvider ?? (() => ({ running: true, detail: '未探测' }))
    this.circuit = new CircuitTracker({ threshold: this.config.circuitThreshold })
    this.warning = null
  }

  /** 加载并编译规则引擎（每次调用都重编译：工作区可能变化，编译很便宜）。 */
  engine() {
    return this.config.buildEngine(this.workspaceRoots())
  }

  /**
   * 处理一次 `tools/pre-execute`。
   *
   * @param {object} exec - 工具执行对象。
   * @param {() => Promise<object>} next - waterfall 的后续。
   * @returns {Promise<object>} 决定。
   */
  async handlePreExecute(exec, next) {
    if (!this.config.enabled) return next()

    const toolName = typeof exec?.name === 'string' ? exec.name : ''
    const args = exec?.arguments
    const { sessionId, cwd } = resolveAgentContext(exec)

    let outcome
    try {
      outcome = decideToolCall({
        engine: this.engine(),
        toolName,
        args,
        dshState: this.dshStateProvider(),
        budget: { goalClass: this.config.goalClass },
      })
    } catch (error) {
      // 引擎故障：fail-safe，但绝不无备份放行——这里改为拒绝并说明原因，
      // 因为备份需要先知道目标，而目标解析已经失败了。
      this.warning = `规则引擎故障：${error?.message ?? String(error)}`
      return {
        kind: 'deny',
        reason: 'dsh-agent-guard：规则引擎故障，无法判定影响面。为避免无备份放行，本次调用被拒绝（fail-safe）。'
          + '请把这条消息与原始错误一并交给用户。',
      }
    }

    const { decision, action, targets } = outcome

    // 读操作不记录、不干预，避免噪音（§6.2 / T5）。
    if (action === 'read' || decision.kind === 'allowed') {
      return next()
    }

    const base = {
      tool: toolName,
      action,
      targets,
      sessionId,
      cwd,
      classification: {
        protected: decision.classification.protected,
        reason: decision.classification.reason,
        budget: decision.classification.budget,
      },
      // 命令原文不入库，只存不可反推的摘要。
      commandDigest: typeof args?.command === 'string' ? commandDigest(args.command) : null,
      note: outcome.note,
    }

    if (decision.kind === 'blocked') {
      this.journal.append({ ...base, decision: 'blocked', code: decision.code, reason: decision.reason })
      return {
        kind: 'deny',
        reason: `dsh-agent-guard 已阻止本次调用：${decision.reason}`
          + (decision.warning !== null ? `\n提示：${decision.warning}` : ''),
      }
    }

    if (decision.kind === 'pause-required') {
      this.journal.append({ ...base, decision: 'pause-required', code: decision.code, reason: decision.reason })
      // 熔断不是"拒绝"，是"必须由人决定"：交给审批通道（`ask`）。
      return {
        kind: 'ask',
        reason: `dsh-agent-guard 熔断：${decision.reason}`,
        displayReason: {
          en: 'Guard circuit breaker: two consecutive writes changed this path. Continue?',
          'zh-CN': '护栏熔断：同一路径连续两次写操作都改变了状态，是否继续？',
        },
      }
    }

    if (decision.kind === 'require-justification' || decision.kind === 'require-confirmation') {
      // 转成审批请求：由人决定，而不是由 agent 自己说"我有理由"。
      const reserved = this.journal.reserve({ ...base, decision: 'asked', code: decision.code, reason: decision.reason })
      void reserved
      return {
        kind: 'ask',
        reason: `dsh-agent-guard：${decision.reason}`,
        displayReason: {
          en: 'A protected path is about to be modified. Allow it (a backup has been taken if possible)?',
          'zh-CN': '即将修改受保护路径。是否允许？（如可备份，已先备份）',
        },
      }
    }

    // allowed-with-backup：先备份，再放行。
    const reserved = this.journal.reserve({ ...base, decision: 'allowed-with-backup', code: decision.code, reason: decision.reason })
    const backup = this.backupTargets(targets, decision)
    if (!backup.ok) {
      this.journal.settle(reserved, {
        ...base,
        decision: 'blocked',
        code: `${decision.code}+backup-${backup.kind}`,
        reason: `备份失败（${backup.error}）：按 fail-closed 拒绝写入，绝不无备份放行。`,
        result: 'blocked-no-backup',
      })
      return {
        kind: 'deny',
        reason: `dsh-agent-guard 已阻止本次调用：备份失败（${backup.error}）。`
          + '按「绝不无备份放行」原则拒绝；请先确认数据目录可写（见 guard_journal 的状态输出）。',
      }
    }

    // 熔断检查放在备份之后、放行之前：它关心的是"这次写会不会又一次改变状态"。
    for (const target of backup.targets) {
      const digestBefore = this.circuit.probeDigest(target)
      const verdict = this.circuit.inspect(target, digestBefore)
      if (verdict.pause) {
        this.journal.settle(reserved, {
          ...base,
          decision: 'pause-required',
          code: 'circuit-breaker',
          reason: '同一路径连续写且校验摘要变化，强制暂停等待人工确认',
          result: 'paused',
        })
        return {
          kind: 'ask',
          reason: 'dsh-agent-guard 熔断：同一路径连续两次写操作都改变了状态，是否继续？',
          displayReason: {
            en: 'Two consecutive writes changed this path. Continue?',
            'zh-CN': '同一路径连续两次写操作都改变了状态，是否继续？',
          },
        }
      }
    }

    this.journal.settle(reserved, {
      ...base,
      decision: 'allowed-with-backup',
      code: decision.code,
      reason: decision.reason,
      backup: backup.path,
      backupKind: backup.kind,
      result: 'allowed',
    })

    // 记录这次写，供下一次熔断判定使用。
    for (const target of backup.targets) {
      this.circuit.record(target, this.circuit.probeDigest(target))
    }
    return next()
  }

  /**
   * 对决定里涉及的受保护目标做写前备份。
   *
   * @param {string[]} targets - 目标路径。
   * @param {object} decision - 决策对象。
   * @returns {{ok: boolean, kind: string, path: string|null, error: string|null, targets: string[]}}
   *   备份结果。`ok:false` 时调用方必须拒绝写入。
   */
  backupTargets(targets, decision) {
    const protectedTargets = decision.classification.targets
      .filter((entry) => entry.protected)
      .map((entry) => entry.target)

    // 未命中受保护路径时无需备份，但仍要报告目标以供熔断追踪。
    const list = protectedTargets.length > 0 ? protectedTargets : []

    if (list.length === 0) {
      return { ok: true, kind: 'not-required', path: null, error: null, targets }
    }
    if (!this.config.backupEnabled) {
      // 用户显式关掉备份时，受保护写入必须被拒绝——否则就是无备份放行。
      return {
        ok: false,
        kind: 'disabled',
        path: null,
        error: '备份已被配置关闭；受保护路径的写入在没有备份的情况下不被允许',
        targets: list,
      }
    }

    let last = { ok: true, kind: 'absent', path: null, error: null }
    for (const target of list) {
      const result = backupFileBeforeWrite({
        store: this.store,
        target,
        reason: `pre-write:${decision.code}`,
        maxBytes: this.config.maxBackupBytes,
      })
      if (!result.ok) return { ...result, targets: list }
      last = result
    }
    return { ...last, targets: list }
  }
}

/**
 * 构建运行时。
 *
 * @param {object} options - 构造输入，见 {@link GuardRuntime}。
 * @returns {GuardRuntime} 运行时。
 */
export function createGuardRuntime(options) {
  return new GuardRuntime(options)
}

/**
 * 供面板使用的「受保护路径健康」速览。
 *
 * @param {string[]} targets - 待检查路径。
 * @returns {Array<{target: string, exists: boolean, kind: string}>} 检查结果。
 */
export function describeTargets(targets) {
  return targets.map((target) => {
    const info = describePath(target)
    return { target, exists: info.exists, kind: info.kind }
  })
}
