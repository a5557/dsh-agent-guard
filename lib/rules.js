/**
 * The rule engine: a pure classifier that turns (action, targets, context) into a
 * decision. This module performs NO I/O — no filesystem calls, no clock reads, no
 * randomness — so every rule is directly unit-testable (T1–T9 in `DESIGN.md` §12.1).
 *
 * Failure policy (`DESIGN.md` §6.6): when the engine itself faults, the caller must
 * degrade to `allowed-with-backup` plus an `engine-fault` warning. It must never
 * degrade to an unbacked allow. {@link classifySafely} implements that wrapper.
 */

import { compilePattern, matchesPattern, normalizeForCompare, describePath, resolvePhysical } from './paths.js'

/** Decision kinds, ordered from most to least permissive where relevant. */
export const DECISIONS = Object.freeze([
  'allowed',
  'allowed-with-backup',
  'require-justification',
  'require-confirmation',
  'pause-required',
  'blocked',
])

/** Actions the engine understands (`DESIGN.md` §6.2). */
export const ACTIONS = Object.freeze([
  'read',
  'link',
  'write',
  'rename-many',
  'delete',
  'kill',
  'exec-script',
  'emit-script',
])

/** Write levels, used by the impact budget (`DESIGN.md` §6.4). */
export const BUDGETS = Object.freeze(['display', 'workspace-content', 'tooling', 'maintenance'])

/**
 * Build the engine's runtime shape from parsed rule data.
 *
 * Compiled once so classification stays allocation-light on the hot path.
 *
 * @param {object} rules - parsed `rules/default.json` (or a user override).
 * @param {{dshHome: string, workspaceRoots?: string[]}} context - substitution inputs.
 * @returns {{protected: Array<{id: string, label: string, compiled: object, budget: string}>,
 *            actions: Record<string, {decision: string, warn?: string}>,
 *            boundaries: {protectWorkspaceRoots: boolean, workspaceMetaDirName: string},
 *            unknownActionDecision: string, maxRenamesBeforeReject: number}}
 *   the compiled engine.
 */
export function compileRules(rules, context) {
  const workspaceRoots = Array.isArray(context.workspaceRoots) ? context.workspaceRoots : []
  const protectedEntries = []

  // The protected table must live in the SAME identity space as the targets it is
  // compared against. `classifyTarget` matches a target's physical path, so a
  // pattern base left in its logical form stops matching whenever an ancestor is a
  // reparse point -- and a miss means "allow a core-data write".
  //
  // Not a Windows-only concern: on macOS `os.tmpdir()` is `/var/folders/...` and
  // `/var` is an absolute symlink to `/private/var`, so every fixture path was
  // rewritten while `$DSH_HOME` stayed logical; the whole table missed, and the
  // denial cases were the only ones that failed (three-platform CI, macOS only).
  //
  // One-way and fail-closed: a path that does not exist yet keeps its spelling, so
  // a fixture such as `C:\home` compiles exactly as before.
  const canonicalHome = resolvePhysical(String(context.dshHome ?? ''))
  const canonicalRoots = workspaceRoots.map((root) => resolvePhysical(String(root)))
  const patternContext = { ...context, dshHome: canonicalHome }

  for (const entry of rules?.protected ?? []) {
    const pattern = String(entry.pattern ?? '')
    const label = String(entry.label ?? entry.id ?? '')
    const budget = String(entry.budget ?? 'core-data')
    const id = String(entry.id ?? '')

    // `<workspace>` expands to one pattern per registered workspace root, because
    // workspace locations are only known at runtime.
    if (pattern.includes('<workspace>') || entry.perWorkspaceRoot === true) {
      const template = pattern.includes('<workspace>') ? pattern : `${'<workspace>'}/${entry.tail ?? ''}`
      for (const root of canonicalRoots) {
        const expanded = template.replaceAll('<workspace>', root)
        protectedEntries.push({
          id,
          label,
          budget,
          compiled: compilePattern(expanded, patternContext),
          perWorkspaceRoot: true,
        })
      }
      continue
    }

    protectedEntries.push({
      id,
      label,
      budget,
      compiled: compilePattern(pattern, patternContext),
      perWorkspaceRoot: false,
    })
  }

  // Workspace roots are protected against `link` above all: creating a junction on a
  // workspace root is precisely what split "registered path" from "resolved path" in
  // the incident (`DESIGN.md` §1.1 step 4). This entry is derived from the roots, not
  // hardcoded in the rule data, because a shipped rule set must not name a real path.
  if (rules?.boundaries?.protectWorkspaceRoots !== false) {
    for (const root of canonicalRoots) {
      protectedEntries.push({
        id: 'workspace-root',
        label: '工作区根（身份锚点）',
        budget: 'workspace-root',
        compiled: compilePattern(root, patternContext),
        perWorkspaceRoot: true,
      })
    }
  }

  return {
    protected: protectedEntries,
    actions: rules?.actions ?? {},
    boundaries: {
      protectWorkspaceRoots: rules?.boundaries?.protectWorkspaceRoots !== false,
      workspaceMetaDirName: String(rules?.boundaries?.workspaceMetaDirName ?? '.dsh'),
    },
    unknownActionDecision: String(rules?.unknownActionDecision ?? 'require-confirmation'),
    maxRenamesBeforeReject: Number(rules?.maxRenamesBeforeReject ?? 2),
    // The engine reports the SAME (physical) identity it matches against, so a
    // caller comparing `engine.dshHome` with a target cannot reintroduce the split.
    dshHome: canonicalHome,
    workspaceRoots: canonicalRoots,
  }
}

/**
 * Classify one target against the protected-path table.
 *
 * A reparse point is resolved before matching so a junction pointing at a
 * protected directory cannot smuggle a write past the table — this is the exact
 * failure mode from the incident (`DESIGN.md` R1 / §1.1 step 4).
 *
 * @param {string} target - path under evaluation.
 * @param {object} engine - compiled engine.
 * @param {{resolveLinks?: boolean}} [options] - `resolveLinks` defaults to true.
 * @returns {{protected: boolean, reason: string|null, budget: string,
 *            matchedId: string|null, resolved: string}} classification.
 */
export function classifyTarget(target, engine, options = {}) {
  const resolveLinks = options.resolveLinks !== false
  const original = String(target ?? '')
  // A link's *physical* location decides protection, not its registered name. The
  // resolution also covers a target that does not exist yet, so "which file will
  // this become" -- not "does it exist right now" -- decides the verdict.
  const candidate = resolveLinks ? resolvePhysical(original) : original

  for (const entry of engine.protected) {
    // Per-workspace patterns were already expanded once per root at compile time,
    // so a plain match is sufficient here.
    if (matchesPattern(entry.compiled, candidate)) {
      return { protected: true, reason: entry.label, budget: entry.budget, matchedId: entry.id, resolved: candidate }
    }
  }

  return { protected: false, reason: null, budget: 'workspace-data', matchedId: null, resolved: candidate }
}

/**
 * Classify a single action. Pure: the same inputs always yield the same decision.
 *
 * @param {string} action - one of {@link ACTIONS}.
 * @param {string[]} targets - paths the action would affect.
 * @param {object} context - decision inputs.
 * @param {object} context.engine - compiled engine.
 * @param {object} [context.dshState] - `{running: boolean|'unknown'}` for DSH.
 * @param {object} [context.budget] - `{goalClass: string, justified: boolean}`.
 * @param {string} [context.justification] - agent-supplied reason, when present.
 * @param {boolean} [context.allowDestructive] - explicit opt-in for deletion.
 * @param {boolean} [context.checksumChanged] - whether a repeat write changed state.
 * @param {number} [context.priorWritesOnSamePath] - consecutive writes on this path.
 * @returns {{kind: string, reason: string, code: string, warning: string|null,
 *            requiresBackup: boolean, classification: object, targets: Array<object>}}
 *   the decision, with the evidence needed to journal it.
 */
export function classify(action, targets, context) {
  const engine = context.engine
  const list = (Array.isArray(targets) ? targets : [targets]).filter(
    (value) => typeof value === 'string' && value.length > 0,
  )

  const classified = list.map((target) => ({
    target,
    ...classifyTarget(target, engine, { resolveLinks: context.resolveLinks !== false }),
  }))
  const protectedHits = classified.filter((entry) => entry.protected)
  const summary = {
    protected: protectedHits.length > 0,
    reason: protectedHits[0]?.reason ?? null,
    budget: protectedHits[0]?.budget ?? 'workspace-data',
    matchedId: protectedHits[0]?.matchedId ?? null,
    targets: classified,
  }

  // A decision is only meaningful if it says what must happen before the action
  // runs. `requiresBackup` therefore reports the OBLIGATION this decision imposes:
  // an allowed-with-backup write, or a confirmation/justification gate on a
  // protected target, obliges a backup first. A hard block imposes nothing, because
  // the action must not run at all.
  const decide = (kind, reason, code, extra = {}) => {
    const gated = kind === 'allowed-with-backup' || kind === 'require-confirmation' || kind === 'require-justification'
    const requiresBackup = extra.requiresBackup ?? (gated && (summary.protected || kind === 'allowed-with-backup'))
    return {
      kind,
      reason,
      code,
      warning: extra.warning ?? null,
      requiresBackup,
      classification: summary,
      targets: classified,
    }
  }

  // Unknown actions fail closed toward confirmation rather than silent allowance.
  if (!ACTIONS.includes(action)) {
    return decide(
      engine.unknownActionDecision,
      `未知动作 "${action}"：无法判定影响面，按需确认处理（fail-closed）`,
      'unknown-action',
      { requiresBackup: true },
    )
  }

  if (action === 'read') {
    // `DESIGN.md` §6.2: reads pass and are not journaled, to avoid noise (T5).
    return decide('allowed', '只读访问不干预', 'read-passthrough', { requiresBackup: false })
  }

  // A write to core data while DSH is not known to be stopped is refused (G5/T8):
  // "cannot determine" counts as running.
  const dshRunning = context.dshState?.running !== false
  const touchesCoreData = protectedHits.some((entry) => entry.budget === 'core-data')

  // Impact budget (`DESIGN.md` §6.4 / T6): a display-classified goal may not write
  // core data at all. Upgrading the class requires explicit user confirmation, so
  // the engine never grants it on the agent's own word.
  const goalClass = String(context.budget?.goalClass ?? 'workspace-content')
  if (touchesCoreData && goalClass === 'display') {
    return decide(
      'blocked',
      '本会话目标被归类为「显示/界面」，影响面不覆盖核心数据：拒绝写入 DSH 私有存储（影响预算）',
      'budget-exceeded',
      { warning: '显示类问题不应通过改写核心数据解决（DESIGN.md R3）' },
    )
  }

  // Circuit breaker (`DESIGN.md` §6.5 / T7): two consecutive writes on the same
  // path whose checksum summary changed require a human decision.
  if (
    (action === 'write' || action === 'link') &&
    Number(context.priorWritesOnSamePath ?? 0) >= 2 &&
    context.checksumChanged === true
  ) {
    return decide(
      'pause-required',
      '同一路径连续写操作且校验摘要发生变化：强制暂停，等待人工确认（DESIGN.md §6.5）',
      'circuit-breaker',
      { warning: '两次改动都改变了状态，是否继续？' },
    )
  }

  if (action === 'rename-many') {
    const protectedDirs = protectedHits.length
    const threshold = engine.maxRenamesBeforeReject
    if (protectedDirs >= threshold) {
      return decide(
        'blocked',
        `一次操作重命名 ${protectedDirs} 个受保护目录：这正是历史事故形态，拒绝执行`,
        'rename-many-protected',
        { warning: '成批改名会话存储目录正是历史事故形态：目录名就是路径编码键，改名会让注册路径与磁盘布局错位（DESIGN.md §1.1）' },
      )
    }
    if (list.length >= threshold) {
      return decide(
        'require-confirmation',
        `一次操作重命名 ${list.length} 个目录（未达受保护阈值）：需要确认`,
        'rename-many',
      )
    }
    return decide('allowed', '单目录改名，未触及受保护路径', 'rename-single')
  }

  if (action === 'delete') {
    if (protectedHits.length > 0 && context.allowDestructive !== true) {
      return decide(
        'blocked',
        '删除受保护路径下的内容：默认拒绝（需显式 --allow-destructive 且已备份）',
        'delete-protected',
      )
    }
    if (protectedHits.length > 0) {
      return decide(
        'require-confirmation',
        '已显式授权删除受保护内容：仍需确认，且必须先备份',
        'delete-protected-authorized',
        { requiresBackup: true },
      )
    }
    return decide('allowed-with-backup', '删除工作区内容：先备份后执行', 'delete-workspace')
  }

  if (action === 'link') {
    if (protectedHits.length > 0) {
      return decide(
        'require-confirmation',
        '在受保护路径上创建联接/符号链接：会让「注册路径」与「真实路径」分裂，需要确认',
        'link-protected',
        { warning: '第二个名字会导致身份分裂（DESIGN.md §1.1 step 4）' },
      )
    }
    return decide('allowed', '工作区内创建链接，未触及受保护路径', 'link-workspace')
  }

  if (action === 'kill') {
    return decide(
      'require-confirmation',
      '结束 DSH 相关进程：需确认，且重启前先备份',
      'kill-dsh-process',
      { warning: '重启前先备份（DESIGN.md §6.2）' },
    )
  }

  if (action === 'exec-script') {
    return decide(
      'require-confirmation',
      '运行引用了受保护路径的脚本：需确认，并展示脚本摘要',
      'exec-script',
    )
  }

  if (action === 'emit-script') {
    // Not forbidden, but never "one click" (`DESIGN.md` §6.2 / appendix A).
    return decide(
      'require-confirmation',
      '生成引用受保护路径的可执行脚本：告警并在 UI 高亮，必须附回滚说明',
      'emit-script',
      { requiresBackup: false, warning: '不得把 agent 的不确定性转成用户的一次双击（DESIGN.md R4）' },
    )
  }

  // `write`
  if (protectedHits.length > 0) {
    if (touchesCoreData && dshRunning) {
      return decide(
        'blocked',
        '目标属于 DSH 核心数据，且无法确认 DSH 已完全停止：拒绝写入（fail-closed）',
        'core-data-while-running',
        { warning: '判据不足时按「未停止」处理，并给出如何正确停止的说明（DESIGN.md §6.3）' },
      )
    }
    if (touchesCoreData) {
      return decide(
        'require-justification',
        '写入 DSH 核心数据（已确认 DSH 停止）：需要显式理由，且先备份',
        'core-data-write',
        { requiresBackup: true },
      )
    }
    return decide(
      'require-justification',
      '写入受保护路径：需要显式理由，且先备份',
      'protected-write',
      { requiresBackup: true },
    )
  }

  return decide('allowed', '工作区普通文件写入，未触及受保护路径', 'workspace-write')
}

/**
 * Fault-tolerant wrapper around {@link classify}.
 *
 * `DESIGN.md` §6.6: an engine fault must degrade to `allowed-with-backup` plus an
 * explicit `engine-fault` warning. It must never yield an unbacked allow, so this
 * wrapper is the only entry point callers should use on the hot path.
 *
 * @param {string} action - action name.
 * @param {string[]} targets - affected paths.
 * @param {object} context - classification inputs.
 * @returns {object} a decision, possibly the degraded one.
 */
export function classifySafely(action, targets, context) {
  try {
    return classify(action, targets, context)
  } catch (error) {
    return {
      kind: 'allowed-with-backup',
      reason: `规则引擎故障（${error?.message ?? String(error)}）：降级为「先备份 + 告警」，绝不无备份放行`,
      code: 'engine-fault',
      warning: 'engine-fault',
      requiresBackup: true,
      classification: {
        protected: false,
        reason: null,
        budget: 'unknown',
        matchedId: null,
        targets: [],
      },
      targets: [],
    }
  }
}

/**
 * Cheap, dependency-free action inference from a tool call.
 *
 * Kept separate from {@link classify} so the tool-name mapping stays data-like and
 * testable, while the decision table stays free of tool-specific knowledge.
 *
 * @param {string} toolName - the dispatched tool's registered name.
 * @param {unknown} args - the call's parsed arguments.
 * @returns {{action: string, targets: string[], note: string|null}} inference result.
 */
export function inferAction(toolName, args) {
  const record = args !== null && typeof args === 'object' ? args : {}
  const targets = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0) targets.push(value)
  }

  switch (toolName) {
    case 'read':
    case 'glob':
    case 'grep':
      push(record.path)
      push(record.file_path)
      return { action: 'read', targets, note: null }
    case 'write':
      push(record.file_path)
      push(record.path)
      // 写入的内容也保留：判断「是不是在生成一个引用受保护路径的脚本」需要它。
      return { action: 'write', targets, note: null, content: readContent(record) }
    case 'edit':
      push(record.file_path)
      push(record.path)
      return { action: 'write', targets, note: null, content: readContent(record) }
    default:
      break
  }

  // Shell-ish tools: the target paths are embedded in command text, so they are
  // extracted rather than trusted. This is deliberately conservative: a command we
  // cannot parse yields an empty target list and therefore no protection claim.
  const command = typeof record.command === 'string' ? record.command : null
  if (command !== null) {
    for (const match of extractPathLike(command)) push(match)
    return { action: 'exec-script', targets, note: 'command-text' }
  }

  return { action: 'unknown', targets, note: null }
}

/**
 * 取出写入类工具的文本内容，用于脚本生成检测。
 *
 * @param {object} record - 已解析的工具参数。
 * @returns {string|null} 内容文本，取不到时为 null。
 */
function readContent(record) {
  for (const key of ['content', 'new_string', 'newText', 'text']) {
    if (typeof record[key] === 'string' && record[key].length > 0) return record[key]
  }
  return null
}

/** 可执行脚本的扩展名（生成这些东西要格外小心）。 */
export const SCRIPT_EXTENSIONS = Object.freeze(['.bat', '.cmd', '.ps1', '.sh', '.bash', '.vbs'])

/**
 * 判断某个路径是否像可执行脚本。
 *
 * @param {string} filePath - 目标路径。
 * @returns {boolean} 是否像脚本。
 */
export function looksLikeScript(filePath) {
  const text = String(filePath ?? '').toLowerCase()
  return SCRIPT_EXTENSIONS.some((extension) => text.endsWith(extension))
}

/**
 * 检测「**生成**一个引用受保护路径的可执行脚本」这一具体形态（G-4）。
 *
 * 设计文档 §6.2 把 `emit-script` 单列：**不禁止**，但必须告警、在 UI 高亮、并附回滚说明。
 * 它针对的正是事故的 root cause R4——把 agent 的不确定性转成用户的一次双击。
 *
 * 判据刻意保守：只有当「目标像脚本」且「内容里真的出现了受保护路径」时才成立。
 * 单纯写一个 `.bat` 不算，内容里必须引用受保护位置。
 *
 * @param {object} input - 检测输入。
 * @param {string} input.target - 即将写入的文件路径。
 * @param {string|null} input.content - 即将写入的内容。
 * @param {object} input.engine - 已编译的规则引擎。
 * @returns {{isEmitScript: boolean, referenced: string[]}} 检测结果。
 */
export function detectEmittedScript(input) {
  const { target, content, engine } = input
  if (content === null || content === undefined) return { isEmitScript: false, referenced: [] }
  if (!looksLikeScript(target)) return { isEmitScript: false, referenced: [] }

  const referenced = []
  for (const candidate of extractPathLike(content)) {
    // Resolve the same way `classifyTarget` does for a real target. Skipping it here
    // was a hole: on macOS every path in the script text starts with `/var/...` while
    // the protected table now holds `/private/var/...`, so a `.bat` that renames a
    // session directory was classified as an ordinary workspace write and allowed.
    // Linux and Windows runners have no such indirection, which is why only two of
    // the three platforms failed this case.
    const classified = classifyTarget(candidate, engine)
    if (classified.protected) referenced.push(candidate)
  }
  return { isEmitScript: referenced.length > 0, referenced }
}

/** Path-like tokens inside command text (absolute paths and `~`-rooted paths). */
const PATH_TOKEN = /(?:[A-Za-z]:[\\/][^\s"'`|<>]*|~[\\/][^\s"'`|<>]*|\/(?:[^\s"'`|<>/]+\/)*[^\s"'`|<>/]+)/g

/**
 * Extract path-like tokens from free-form command text.
 *
 * @param {string} command - raw command line.
 * @returns {string[]} deduplicated candidate paths, in first-seen order.
 */
export function extractPathLike(command) {
  const seen = new Set()
  const out = []
  for (const match of String(command).matchAll(PATH_TOKEN)) {
    const token = match[0].replace(/[.,;:)\]]+$/, '')
    const key = normalizeForCompare(token)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(token)
  }
  return out
}
