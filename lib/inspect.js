/**
 * `guard_inspect` — one-shot, read-only, authoritative state capture (P1).
 *
 * Purpose (`DESIGN.md` §7): make reading FIRST-HAND evidence the easiest path, so
 * that "counted directories != counted registrations" can never again be read as
 * "data was lost" (root cause R2).
 *
 * Hard requirements honoured here:
 * - read-only: nothing under `$DSH_HOME` is created, modified, renamed or deleted;
 * - no speculation: an `unregistered` count is ALWAYS reported together with the
 *   `origin` breakdown, and subagent records are marked `countsAsConversation: false`;
 * - reproducible: identical inputs produce an identical structure apart from
 *   `generatedAt` and measured timings;
 * - never recommends a repair: findings describe state and suggest the safe
 *   process, never an automatic fix (appendix A).
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { projectKey } from './encoding.js'
import { classifyConversation, HeaderCache, readLayout } from './sessionlog.js'
import { describePath, normalizeForCompare } from './paths.js'
import { probeDshState, resolveDshHome } from './hostcheck.js'

/** Scopes the tool accepts (`DESIGN.md` §7.1). */
export const INSPECT_SCOPES = Object.freeze(['workspaces', 'sessions', 'storage', 'layout', 'processes'])

/** Default cap on how many session headers are decoded in one call. */
const DEFAULT_MAX_HEADERS = 500

/** Default cap on identity rows included in the output. */
const DEFAULT_MAX_IDENTITY_ROWS = 200

/** Finding codes, kept stable because tests and the panel match on them. */
export const FINDING_CODES = Object.freeze([
  'path-as-identity-mismatch',
  'reparse-point-in-workspace',
  'registry-unreadable',
  'session-header-unreadable',
  'session-header-incomplete',
  'unregistered-subagent-records',
  'unregistered-conversation-records',
  'registered-session-missing-on-disk',
  'orphan-session-space',
])

/**
 * Capture the current state of the DSH home.
 *
 * @param {object} [options] - capture inputs.
 * @param {string[]} [options.scope] - scopes to include; default is all of them.
 * @param {string} [options.workspace] - restrict output to one workspace path.
 * @param {number} [options.maxSessions] - cap on decoded headers.
 * @param {boolean} [options.includeHeaders] - decode identity headers (default true).
 * @param {'real'|'redacted'} [options.workspaceTitleMode] - redact titles/paths when 'redacted'.
 * @param {string} [options.dshHome] - explicit DSH home override.
 * @param {{listProcesses?: Function, listPorts?: Function, now?: () => Date}} [options.probes]
 *   - injectable probes, so tests never depend on the real machine.
 * @returns {object} the stable report.
 */
export function guardInspect(options = {}) {
  const scope = Array.isArray(options.scope) && options.scope.length > 0 ? options.scope : [...INSPECT_SCOPES]
  const dshHome = resolveDshHome(options.dshHome)
  const includeHeaders = options.includeHeaders !== false
  const maxHeaders = Number(options.maxSessions ?? DEFAULT_MAX_HEADERS)
  const titleMode = options.workspaceTitleMode === 'redacted' ? 'redacted' : 'real'
  const now = options.probes?.now ?? (() => new Date())
  const findings = []

  const registry = readRegistry(dshHome, findings)
  const layout = scope.includes('layout') || scope.includes('sessions') ? readLayout(join(dshHome, 'sessions')) : []
  const layoutBySpace = new Map(layout.map((entry) => [entry.space, entry]))

  const workspaces = buildWorkspaces({
    registry,
    layoutBySpace,
    filter: options.workspace,
    titleMode,
    dshHome,
    findings,
  })

  const sessions = scope.includes('sessions')
    ? buildSessions({ workspaces, layoutBySpace, includeHeaders, maxHeaders, findings })
    : { skipped: true }

  const report = {
    generatedAt: now().toISOString(),
    dsh: buildDshSection({ dshHome, scope, registry, probes: options.probes }),
    workspaces,
    sessions,
    findings,
  }

  if (scope.includes('layout')) report.layout = buildLayoutSection(layoutBySpace)
  return report
}

/**
 * Read and structurally validate the workspace registry.
 *
 * A malformed or absent registry is reported as a finding rather than thrown: an
 * inspector that crashes on the exact situation it exists to diagnose is useless.
 * The count is never reported as zero when it is merely unknown.
 *
 * @param {string} dshHome - resolved DSH home.
 * @param {Array<object>} findings - finding sink.
 * @returns {{ok: boolean, workspaces: Array<object>, archivedSessionIds: string[], error: string|null}}
 */
export function readRegistry(dshHome, findings = []) {
  const file = join(dshHome, 'storages', 'workspace.json')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    const detail = `${error?.code ?? 'error'}: ${error?.message ?? String(error)}`
    findings.push({
      code: 'registry-unreadable',
      severity: 'warn',
      detail: '无法读取工作区注册表 storages/workspace.json。'
        + '登记数在本次取证中视为「未知」，不能用 0 代替——未知与零是两件事。',
    })
    return { ok: false, workspaces: [], archivedSessionIds: [], error: detail }
  }

  try {
    const data = JSON.parse(raw)
    const table = data?.tables?.workspaces
    const list = table !== null && typeof table === 'object'
      ? Object.entries(table).map(([id, value]) => ({ id, ...value }))
      : []
    const order = Array.isArray(data?.global?.workspaceIds) ? data.global.workspaceIds : []
    const archived = Array.isArray(data?.global?.archivedSessionIds) ? data.global.archivedSessionIds : []
    list.sort((a, b) => {
      const ai = order.indexOf(a.id)
      const bi = order.indexOf(b.id)
      return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi)
    })
    return { ok: true, workspaces: list, archivedSessionIds: archived, error: null }
  } catch (error) {
    findings.push({
      code: 'registry-unreadable',
      severity: 'error',
      detail: '工作区注册表不是可解析的 JSON。这本身就是需要人工介入的状态；'
        + '本工具不会尝试修复，也不会把它当成「没有工作区」。',
    })
    return { ok: false, workspaces: [], archivedSessionIds: [], error: `json: ${error?.message ?? String(error)}` }
  }
}

/**
 * Build the per-workspace section.
 *
 * @param {object} input - assembly inputs.
 * @returns {Array<object>} one row per registered workspace.
 */
function buildWorkspaces(input) {
  const { registry, layoutBySpace, filter, titleMode, dshHome, findings } = input
  const rows = []

  for (const workspace of registry.workspaces) {
    const path = String(workspace.path ?? '')
    if (filter !== undefined && normalizeForCompare(filter) !== normalizeForCompare(path)) continue

    const info = describePath(path)
    const space = safeProjectKey(path)
    const layoutEntry = space === null ? undefined : layoutBySpace.get(space)
    const registeredIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
    const onDiskSessions = layoutEntry?.entries ?? []

    if (!info.exists) {
      findings.push({
        code: 'path-as-identity-mismatch',
        severity: 'warn',
        detail: '一个已登记工作区的路径当前不存在。会话存储目录名是路径的编码键，'
          + '路径失效会让其会话无法按组显示。安全的处置是「把目录物理搬回注册路径」'
          + '或「由用户在应用内重新登记」，而不是改写注册表或建立联接；本工具不提供自动修复。',
      })
    }

    if (info.kind === 'junction' || info.kind === 'symlink') {
      findings.push({
        code: 'reparse-point-in-workspace',
        severity: 'error',
        detail: `工作区根是一个${info.kind === 'junction' ? '目录联接' : '符号链接'}：注册路径与解析后的真实路径不同，`
          + '这正是身份分裂的形态（注册路径 ≠ 真实路径）。本工具只报告，不提供「接回旧路径」之类的修复。',
      })
    }

    rows.push({
      id: titleMode === 'redacted' ? '<workspace-id>' : workspace.id,
      title: titleMode === 'redacted' ? '<title>' : String(workspace.title ?? ''),
      path: titleMode === 'redacted' ? '<workspace>' : path,
      exists: info.exists,
      kind: info.kind,
      realPathMatches: info.realPath === null ? null : normalizeForCompare(info.realPath) === normalizeForCompare(path),
      space,
      registeredSessions: registeredIds.length,
      registeredSessionIds: registeredIds,
      onDiskSessions: onDiskSessions.length,
      archivedSessions: registeredIds.filter((id) => registry.archivedSessionIds.includes(id)).length,
      dshHomeMatches: path.length > 0 ? normalizeForCompare(path) === normalizeForCompare(dshHome) : false,
    })
  }

  // A space on disk that no registered workspace encodes to is stale state, not loss.
  const reachable = new Set(registry.workspaces.map((workspace) => safeProjectKey(String(workspace.path ?? ''))))
  for (const space of layoutBySpace.keys()) {
    if (space === '_no-cwd' || reachable.has(space)) continue
    findings.push({
      code: 'orphan-session-space',
      severity: 'info',
      detail: '存在一个会话存储目录，但没有任何已登记工作区的路径编码到它：说明该工作区曾在注册表中，现已不在。'
        + '这不代表数据丢失；如需清理请由用户确认后手动处理（本工具不自动删除）。',
    })
  }

  return rows
}

/**
 * Build the sessions section by reconciling EVERY space under the store against the
 * registry.
 *
 * Scanning only registered workspaces would silently omit orphaned spaces and make
 * `total` understate the store — the same class of error as reading a count as
 * evidence. Every session directory found on disk is therefore accounted for.
 *
 * @param {object} input - assembly inputs.
 * @returns {object} the sessions section.
 */
function buildSessions(input) {
  const { workspaces, layoutBySpace, includeHeaders, maxHeaders, findings } = input
  const cache = new HeaderCache()
  const identities = []
  const byWorkspace = []
  const orphanSpaces = []
  let decoded = 0
  let unreadable = 0
  let incomplete = 0
  let truncated = false
  let totalDirs = 0

  // Index spaces by the workspace that claims them, so an orphaned space is still
  // visited rather than quietly skipped.
  const spaceToWorkspace = new Map()
  for (const row of workspaces) {
    if (row.space !== null && !spaceToWorkspace.has(row.space)) spaceToWorkspace.set(row.space, row)
  }

  /**
   * Decode one space's sessions.
   *
   * @param {string} space - encoded space name.
   * @param {object|null} row - the claiming workspace row, or null when orphaned.
   * @returns {object} per-space tallies.
   */
  const scanSpace = (space, row) => {
    const entries = layoutBySpace.get(space)?.entries ?? []
    totalDirs += entries.length

    const registeredIds = new Set(row?.registeredSessionIds ?? [])
    const onDiskIds = new Set(entries.map((entry) => entry.session))
    const tally = {
      registered: registeredIds.size,
      registeredFoundOnDisk: 0,
      onDiskSessions: entries.length,
      onDiskConversations: 0,
      onDiskSubagent: 0,
      onDiskUnreadable: 0,
      unregisteredConversations: 0,
      unregisteredSubagent: 0,
      missingFromDisk: [],
    }

    if (!includeHeaders) {
      for (const id of registeredIds) if (onDiskIds.has(id)) tally.registeredFoundOnDisk += 1
    }

    for (const entry of entries) {
      const isRegistered = registeredIds.has(entry.session)
      if (isRegistered) tally.registeredFoundOnDisk += 1

      if (!includeHeaders || entry.file === null) {
        // Without a header the origin is unknown, so nothing is asserted about it.
        continue
      }
      if (decoded >= maxHeaders) {
        truncated = true
        break
      }

      const read = cache.read(entry.file, { bytes: entry.bytes, mtimeMs: entry.mtimeMs })
      decoded += 1
      if (!read.ok) {
        if (read.status === 'unreadable') unreadable += 1
        else incomplete += 1
        tally.onDiskUnreadable += 1
        findings.push({
          code: read.status === 'unreadable' ? 'session-header-unreadable' : 'session-header-incomplete',
          severity: 'warn',
          detail: '有一个会话文件的身份头未能完整解出。'
            + '这不是「没有记录」：读不出来必须当作不确定处理，绝不能用它推断数据缺失或存在（DESIGN.md R2）。',
        })
        continue
      }

      const verdict = classifyConversation(read.header)
      if (verdict.countsAsConversation) {
        tally.onDiskConversations += 1
        if (!isRegistered) tally.unregisteredConversations += 1
      } else {
        tally.onDiskSubagent += 1
        if (!isRegistered) tally.unregisteredSubagent += 1
      }

      identities.push({
        id: read.header.id,
        space,
        workspace: row === null ? null : row.title,
        registered: isRegistered,
        origin: read.header.origin ?? null,
        delegationDepth: read.header.delegationDepth ?? 0,
        parentSession: typeof read.header.parentSession === 'string' ? read.header.parentSession : null,
        // The recorded cwd is the identity that the space name only encodes lossily.
        cwd: read.header.cwd ?? null,
        formatVersion: read.header.version ?? null,
        countsAsConversation: verdict.countsAsConversation,
      })
    }

    if (includeHeaders) {
      for (const id of registeredIds) if (!onDiskIds.has(id)) tally.missingFromDisk.push(id)
    }
    return tally
  }

  for (const row of workspaces) {
    if (row.space === null) continue
    const tally = scanSpace(row.space, row)

    if (tally.unregisteredSubagent > 0) {
      findings.push({
        code: 'unregistered-subagent-records',
        severity: 'info',
        detail: `${tally.unregisteredSubagent} 条记录带 origin: "subagent" 或 delegationDepth > 0：这是应用有意不登记的内部记录，`
          + '不是丢失的对话。把它们计入「缺失对话」正是历史事故的误判形态（DESIGN.md §1.1）。',
      })
    }
    if (tally.unregisteredConversations > 0) {
      findings.push({
        code: 'unregistered-conversation-records',
        severity: 'warn',
        detail: `${tally.unregisteredConversations} 条 origin 非 subagent 的记录未被任何工作区登记：这才可能是真正需要用户关注的登记缺失。`
          + '处置方式由用户决定，本工具不自动登记、不改写注册表。',
      })
    }
    if (tally.missingFromDisk.length > 0) {
      findings.push({
        code: 'registered-session-missing-on-disk',
        severity: 'warn',
        detail: `${tally.missingFromDisk.length} 个已登记会话在当前存储目录下没有对应记录。`
          + '这需要用户核对（例如工作区路径曾被移动、会话被清理或归档到别处）；'
          + '本工具只报告，不做任何迁移、登记改写或「修复」。',
      })
    }

    byWorkspace.push({
      workspace: row.title,
      space: row.space,
      registered: tally.registered,
      registeredFoundOnDisk: tally.registeredFoundOnDisk,
      onDiskSessions: tally.onDiskSessions,
      onDiskConversations: tally.onDiskConversations,
      onDiskSubagentRecords: tally.onDiskSubagent,
      onDiskUnreadable: tally.onDiskUnreadable,
      unregistered: tally.unregisteredConversations + tally.unregisteredSubagent,
      unregisteredConversations: tally.unregisteredConversations,
      unregisteredSubagentRecords: tally.unregisteredSubagent,
      missingFromDisk: tally.missingFromDisk.length,
    })
  }

  // Spaces no registered workspace claims. Reported with their origin split so a
  // stale space cannot be mistaken for lost conversations either.
  for (const space of layoutBySpace.keys()) {
    if (spaceToWorkspace.has(space)) continue
    const tally = scanSpace(space, null)
    orphanSpaces.push({
      space,
      onDiskSessions: tally.onDiskSessions,
      onDiskConversations: tally.onDiskConversations,
      onDiskSubagentRecords: tally.onDiskSubagent,
      onDiskUnreadable: tally.onDiskUnreadable,
    })
  }

  return {
    total: totalDirs,
    decoded,
    truncated,
    unreadable,
    incomplete,
    countsAsConversation: identities.filter((entry) => entry.countsAsConversation).length,
    subagentRecords: identities.filter((entry) => !entry.countsAsConversation).length,
    byWorkspace,
    orphanSpaces,
    identity: identities.slice(0, DEFAULT_MAX_IDENTITY_ROWS),
    identityTruncated: identities.length > DEFAULT_MAX_IDENTITY_ROWS,
  }
}

/**
 * Whether an id was observed among a set of decoded identity rows.
 *
 * Retained for callers that already hold decoded rows; it never substitutes for a
 * header that was not read.
 *
 * @param {string} id - session id.
 * @param {Array<{id: string}>} identities - observed rows.
 * @returns {boolean} true when present.
 */
export function isObservedId(id, identities) {
  return identities.some((entry) => entry.id === id)
}

/**
 * Build the `dsh` section.
 *
 * @param {object} input - assembly inputs.
 * @returns {object} host description.
 */
function buildDshSection(input) {
  const { dshHome, scope, registry, probes } = input
  const state = scope.includes('processes') ? probeDshState({ probes }) : { running: 'unknown', criteria: [] }
  return {
    home: dshHome,
    appRunning: state.running === 'unknown' ? null : state.running,
    runningCriteria: state.criteria,
    ports: scope.includes('processes') ? [19387, 3080] : [],
    version: readDshVersion(dshHome),
    registryReadable: registry.ok,
    profiles: scope.includes('storage') ? listProfiles(dshHome) : undefined,
  }
}

/**
 * Read the running DSH version from its own package manifest when discoverable.
 *
 * Returns null rather than a guess: an unknown version must not be invented. The
 * lookup is purely local (it reads a `package.json`); nothing is installed and no
 * network call is made.
 *
 * @param {string} dshHome - resolved DSH home (kept for a uniform call signature).
 * @returns {string|null} the version, or null when not discoverable.
 */
export function readDshVersion(dshHome) {
  void dshHome
  const candidates = []

  // An explicitly provided root keeps discovery deterministic for embedders and tests.
  const envRoot = process.env.DSH_RUNTIME_ROOT
  if (typeof envRoot === 'string' && envRoot.length > 0) {
    candidates.push(join(envRoot, '@deepseek-ai', 'dsh', 'package.json'))
  }

  try {
    const { execFileSync } = process.getBuiltinModule('node:child_process')
    // Reads only a version string from a local manifest; no install, no network.
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()
    if (root.length > 0) candidates.push(join(root, '@deepseek-ai', 'dsh', 'package.json'))
  } catch {
    // Unavailable under a confined sandbox or without a global npm: the version
    // stays unknown, and the report says so rather than guessing.
  }

  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed.version === 'string') return parsed.version
    } catch {
      continue
    }
  }
  return null
}

/**
 * List profile directory names (names only, never their contents).
 *
 * @param {string} dshHome - resolved DSH home.
 * @returns {string[]} profile directory names.
 */
function listProfiles(dshHome) {
  try {
    const { readdirSync } = process.getBuiltinModule('node:fs')
    return readdirSync(join(dshHome, 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * Build the layout section: directory names, counts and mtimes — no decompression.
 *
 * @param {Map<string, object>} layoutBySpace - layout index.
 * @returns {object} the layout section.
 */
function buildLayoutSection(layoutBySpace) {
  const spaces = []
  for (const [space, entry] of layoutBySpace) {
    spaces.push({
      space,
      sessions: entry.entries.length,
      bytes: entry.entries.reduce((sum, item) => sum + item.bytes, 0),
      latestMtimeMs: entry.entries.reduce((max, item) => Math.max(max, item.mtimeMs), 0),
    })
  }
  return { spaces }
}

/**
 * 把取证报告渲染成紧凑、可读的文本。
 *
 * 刻意用文本而不是原始 JSON：模型读的是这段文字，而一个稳定的摘要正是防止
 * 「数量差」被叙述成「数据丢失」的关键。
 *
 * @param {object} report - {@link guardInspect} 的输出。
 * @returns {string} 渲染后的摘要。
 */
export function formatReport(report) {
  const lines = []
  lines.push(`取证时间：${report.generatedAt}`)
  lines.push(`DSH_HOME：${report.dsh.home}`)
  lines.push(`DSH 版本：${report.dsh.version ?? '未知（不猜测）'}`)
  lines.push(
    `DSH 是否在运行：${report.dsh.appRunning === null ? '判据不足（按「未停止」处理）' : report.dsh.appRunning ? '是' : '否'}`,
  )
  if (Array.isArray(report.dsh.runningCriteria)) {
    for (const criterion of report.dsh.runningCriteria) {
      lines.push(`  · ${criterion.name}：${criterion.value} — ${criterion.detail}`)
    }
  }

  lines.push('')
  lines.push(`工作区：${report.workspaces.length} 个已登记`)
  for (const row of report.workspaces) {
    lines.push(
      `  · ${row.title} — 路径${row.exists ? '存在' : '不存在'}${row.kind === 'dir' ? '' : `（${row.kind}）`}`
      + ` | 已登记会话 ${row.registeredSessions} | 磁盘会话 ${row.onDiskSessions}`,
    )
    if (row.realPathMatches === false) {
      lines.push('    ⚠ 注册路径与解析后的真实路径不一致：这是身份分裂的形态，不要用联接「接回」旧路径。')
    }
  }

  if (report.sessions && report.sessions.skipped !== true) {
    const s = report.sessions
    lines.push('')
    lines.push(`会话：磁盘上 ${s.total} 个会话目录，本次解出 ${s.decoded} 个身份头`)
    lines.push(
      `  · 用户对话 ${s.countsAsConversation} 条 | origin:"subagent" 或 delegationDepth > 0 的内部记录 ${s.subagentRecords} 条`
      + '（内部记录由应用有意不登记，不计入「缺失对话」）',
    )
    if (s.unreadable > 0 || s.incomplete > 0) {
      lines.push(`  · 未能完整解出：unreadable ${s.unreadable} / incomplete ${s.incomplete} —— 视为「不确定」，不是「没有记录」`)
    }
    if (s.truncated) lines.push('  · 已达 maxSessions 上限：本次未覆盖全部会话，结论不完整')
    for (const row of s.byWorkspace) {
      if (row.onDiskSessions === 0 && row.registered === 0) continue
      lines.push(
        `  · ${row.workspace}：登记 ${row.registered}（磁盘上找到 ${row.registeredFoundOnDisk}）| 磁盘 ${row.onDiskSessions}`
        + `（对话 ${row.onDiskConversations} / 内部记录 ${row.onDiskSubagentRecords}）`
        + `| 未登记 ${row.unregistered}`
        + (row.missingFromDisk > 0 ? ` | 登记但磁盘缺失 ${row.missingFromDisk}` : ''),
      )
    }
    for (const orphan of s.orphanSpaces ?? []) {
      lines.push(
        `  · （无登记工作区认领的空间）磁盘 ${orphan.onDiskSessions}`
        + `（对话 ${orphan.onDiskConversations} / 内部记录 ${orphan.onDiskSubagentRecords}）`,
      )
    }
  }

  lines.push('')
  lines.push(`发现（${report.findings.length} 条）`)
  for (const finding of report.findings) {
    lines.push(`  [${finding.severity}] ${finding.code}`)
    lines.push(`      ${finding.detail}`)
  }

  lines.push('')
  lines.push('本工具只读取证，不改数据、不迁移、不提供自动修复。')
  return lines.join('\n')
}

/**
 * Encode a workspace path, tolerating invalid input.
 *
 * @param {string} path - workspace path.
 * @returns {string|null} the space name, or null when it cannot be produced.
 */
function safeProjectKey(path) {
  try {
    return projectKey(path)
  } catch {
    return null
  }
}

/**
 * Stat a path without throwing.
 *
 * @param {string} file - path to stat.
 * @returns {import('node:fs').Stats|null} stats, or null.
 */
export function statOrNull(file) {
  try {
    return statSync(file)
  } catch {
    return null
  }
}
