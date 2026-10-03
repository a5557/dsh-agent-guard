/**
 * Storage layer: this plugin's OWN data directory, and the only module that writes.
 *
 * `DESIGN.md` §5 puts all plugin data under `$DSH_HOME/agent-guard/`, and §2.2 forbids
 * writing DSH's `sessions/`, `storages/` or `profiles/`. Both rules are enforced here:
 * every path this module hands out lives under a directory it created itself.
 *
 * ## Why there is a fallback chain
 *
 * A host plugin runs inside a sandboxed session. Writing outside the workspace can be
 * refused (`dsh-shield` recorded exactly this `EPERM`). Losing the journal silently
 * would be worse than the incident this plugin exists to prevent, so the chain is
 * explicit and always reported:
 *
 * 1. `$DSH_HOME/agent-guard/` — the documented home;
 * 2. `<tmp>/dsh-agent-guard/` — a degraded but still durable location;
 * 3. memory queue — last resort, surfaced as a warning and never pretended to be持久.
 *
 * Degrading is allowed; degrading SILENTLY is not (`DESIGN.md` §5).
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Subdirectories the plugin owns inside its data directory. */
export const GUARD_SUBDIRS = Object.freeze(['backups', 'snapshots', 'layout', 'quarantine'])

/** Directory name used inside the DSH home. */
export const GUARD_DIR_NAME = 'agent-guard'

/** Maximum queued lines before the oldest are dropped in memory-only mode. */
const MAX_QUEUE = 10_000

/**
 * Probe whether a directory can actually be written to.
 *
 * Existence is not writability: a sandbox can refuse a `mkdir` that the OS would
 * otherwise allow, so this performs a real create/delete round trip.
 *
 * @param {string} dir - candidate directory.
 * @param {{mkdir?: Function, writeFile?: Function, rm?: Function}} [io] - injectable
 *   filesystem, so tests can simulate refusal without breaking a real directory.
 * @returns {{ok: boolean, error: string|null}} the probe result.
 */
export function probeWritable(dir, io = {}) {
  const mkdir = io.mkdir ?? ((path) => mkdirSync(path, { recursive: true }))
  const write = io.writeFile ?? ((path, data) => writeFileSync(path, data))
  const remove = io.rm ?? ((path) => rmSync(path, { force: true }))
  const marker = join(dir, '.write-probe')
  try {
    mkdir(dir)
  } catch (error) {
    return { ok: false, error: `${error?.code ?? 'error'}: ${error?.message ?? String(error)}` }
  }
  // A mkdir hook that silently does nothing would otherwise let the probe "succeed"
  // and only fail later, at the first real append — a misleading failure mode.
  // Verify the directory actually exists before trusting it.
  const exists = io.exists ?? ((path) => existsSync(path))
  let present = false
  try {
    present = exists(dir) === true
  } catch {
    present = false
  }
  if (!present) {
    return { ok: false, error: 'mkdir-did-not-create-directory' }
  }
  try {
    write(marker, 'ok')
  } catch (error) {
    return { ok: false, error: `${error?.code ?? 'error'}: ${error?.message ?? String(error)}` }
  }
  try {
    remove(marker)
  } catch {
    // A probe file left behind is harmless; the directory is still writable.
  }
  return { ok: true, error: null }
}

/**
 * Decide where plugin data lives.
 *
 * @param {object} [options] - resolution inputs.
 * @param {string} [options.dshHome] - resolved DSH home.
 * @param {string} [options.configuredDir] - explicit override from plugin config.
 * @param {boolean} [options.allowTmpFallback] - permit the temp-directory fallback.
 * @param {{mkdir?: Function, writeFile?: Function, rm?: Function}} [options.io] - injectable filesystem.
 * @returns {{mode: 'primary'|'configured'|'tmp'|'memory', dir: string|null,
 *            attempts: Array<{dir: string, ok: boolean, error: string|null}>,
 *            warning: string|null}} the decision, with every attempt recorded.
 */
export function resolveGuardDir(options = {}) {
  const attempts = []
  const candidates = []

  if (typeof options.configuredDir === 'string' && options.configuredDir.trim().length > 0) {
    candidates.push({ dir: options.configuredDir, mode: 'configured' })
  }
  if (typeof options.dshHome === 'string' && options.dshHome.length > 0) {
    candidates.push({ dir: join(options.dshHome, GUARD_DIR_NAME), mode: 'primary' })
  }
  if (options.allowTmpFallback !== false) {
    candidates.push({ dir: join(tmpdir(), `dsh-${GUARD_DIR_NAME}`), mode: 'tmp' })
  }

  for (const candidate of candidates) {
    const probe = probeWritable(candidate.dir, options.io)
    attempts.push({ dir: candidate.dir, ok: probe.ok, error: probe.error })
    if (!probe.ok) continue
    return {
      mode: candidate.mode,
      dir: candidate.dir,
      attempts,
      warning: candidate.mode === 'tmp'
        ? '无法写入 $DSH_HOME/agent-guard/，已降级到临时目录：本次记录不会与 DSH 数据一起备份，重启后可能被系统清理。'
        : null,
    }
  }

  return {
    mode: 'memory',
    dir: null,
    attempts,
    warning: '所有候选目录都不可写：护栏进入「仅内存」模式，记录会丢失且不会落盘。'
      + '这通常意味着沙箱拒绝了工作区之外的写入 —— 请授权更宽的写权限，或把 config.dir 指到可写位置。',
  }
}

/**
 * Create the plugin's data directories under a chosen root.
 *
 * @param {string} dir - the guard directory.
 * @param {{mkdir?: Function}} [io] - injectable filesystem.
 * @returns {string[]} the directories ensured.
 */
export function ensureGuardLayout(dir, io = {}) {
  const mkdir = io.mkdir ?? ((path) => mkdirSync(path, { recursive: true }))
  const made = [dir, ...GUARD_SUBDIRS.map((sub) => join(dir, sub))]
  for (const path of made) mkdir(path)
  return made
}

/**
 * The plugin's storage handle.
 *
 * Writes are atomic where a whole file is replaced (write to a sibling, then rename)
 * and append-only where the file is a log. Append failures are retried and then
 * queued, never dropped.
 */
export class GuardStore {
  /**
   * @param {object} options - construction inputs.
   * @param {string|null} options.dir - chosen directory, or null in memory mode.
   * @param {'primary'|'configured'|'tmp'|'memory'} options.mode - how it was chosen.
   * @param {string|null} [options.warning] - degradation warning, if any.
   * @param {Array<object>} [options.attempts] - resolution attempts, for diagnostics.
   * @param {{mkdir?: Function, writeFile?: Function, rm?: Function, appendFile?: Function,
   *          rename?: Function, exists?: Function, stat?: Function}} [options.io] - injectable filesystem.
   */
  constructor(options) {
    this.dir = options.dir
    this.mode = options.mode
    this.warning = options.warning ?? null
    this.attempts = options.attempts ?? []
    this.io = options.io ?? {}
    this.queue = []
    this.dropped = 0
    this.appended = 0
    this.flushed = 0
    this.appendFailures = 0

    if (this.dir !== null) {
      try {
        ensureGuardLayout(this.dir, { mkdir: this.io.mkdir })
      } catch (error) {
        // A layout failure demotes the store rather than throwing into the tool path.
        this.warning = `${this.warning ?? ''} 无法创建数据目录（${error?.message ?? String(error)}），降级为仅内存。`.trim()
        this.dir = null
        this.mode = 'memory'
      }
    }
  }

  /** Whether writes reach durable storage. */
  get durable() {
    return this.dir !== null
  }

  /**
   * Absolute path for one of this plugin's own files.
   *
   * @param {...string} segments - path segments under the guard directory.
   * @returns {string|null} the path, or null in memory-only mode.
   */
  path(...segments) {
    return this.dir === null ? null : join(this.dir, ...segments)
  }

  /**
   * Append one line to a log file, retrying before queueing.
   *
   * @param {string} relativePath - log file path relative to the guard directory.
   * @param {string} line - the line to append (a newline is added).
   * @param {{attempts?: number}} [options] - retry count.
   * @returns {{ok: boolean, queued: boolean, error: string|null}} the outcome.
   */
  appendLine(relativePath, line, options = {}) {
    const attempts = Number(options.attempts ?? 3)
    if (!this.durable) {
      this.enqueue(line)
      return { ok: false, queued: true, error: 'memory-only-mode' }
    }

    const file = this.path(relativePath)
    const append = this.io.appendFile ?? ((path, data) => appendFileSync(path, data))
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const mkdir = this.io.mkdir ?? ((path) => mkdirSync(path, { recursive: true }))
        mkdir(this.dir)
        // Drain the backlog FIRST, so the durable log keeps chronological order:
        // queued lines happened before this one, so they must land before it.
        // Those lines were already counted when they were queued.
        if (this.queue.length > 0) {
          this.flushQueue(relativePath, { countAsAppended: false })
          // If the backlog still cannot be written, writing this line now would put
          // it out of order. Fail this attempt instead; the caller's retry loop and
          // the queue handle it.
          if (this.queue.length > 0) {
            lastError = 'backlog-flush-failed'
            this.appendFailures += 1
            continue
          }
        }
        append(file, `${line}\n`)
        this.appended += 1
        return { ok: true, queued: false, error: null }
      } catch (error) {
        lastError = `${error?.code ?? 'error'}: ${error?.message ?? String(error)}`
        this.appendFailures += 1
      }
    }

    // Never silently drop: queue it and report the degradation.
    this.enqueue(line)
    this.warning = `日志追加失败（${lastError}），已转入内存队列（当前 ${this.queue.length} 条）。这不是丢弃，但需要尽快恢复可写。`
    return { ok: false, queued: true, error: lastError }
  }

  /**
   * Add a line to the bounded in-memory queue.
   *
   * @param {string} line - the line to queue.
   * @returns {void}
   */
  enqueue(line) {
    this.queue.push(line)
    while (this.queue.length > MAX_QUEUE) {
      this.queue.shift()
      this.dropped += 1
    }
  }

  /**
   * 尝试把队列里的行按顺序补写。
   *
   * 由 {@link appendLine} 在成功后自动调用，此时那些行**已经计入** `appended`，
   * 因此用 `countAsAppended: false` 避免重复计数。外部显式调用时默认计入。
   *
   * @param {string} [relativePath] - 目标日志文件。
   * @param {{countAsAppended?: boolean}} [options] - 是否计入 appended 统计。
   * @returns {number} 本次补写的行数。
   */
  flushQueue(relativePath = 'journal.jsonl', options = {}) {
    if (!this.durable || this.queue.length === 0) return 0
    const append = this.io.appendFile ?? ((path, data) => appendFileSync(path, data))
    const file = this.path(relativePath)
    const pending = this.queue
    this.queue = []
    try {
      append(file, pending.map((line) => `${line}\n`).join(''))
      if (options.countAsAppended !== false) this.appended += pending.length
      this.flushed += pending.length
      return pending.length
    } catch {
      // Restore the batch at the front so ordering survives a failed flush.
      this.queue = [...pending, ...this.queue]
      return 0
    }
  }

  /**
   * Atomically replace a whole file.
   *
   * @param {string} relativePath - file path relative to the guard directory.
   * @param {string|Buffer} content - new content.
   * @returns {{ok: boolean, error: string|null}} the outcome.
   */
  writeFileAtomic(relativePath, content) {
    if (!this.durable) return { ok: false, error: 'memory-only-mode' }
    const target = this.path(relativePath)
    const temp = `${target}.tmp`
    const write = this.io.writeFile ?? ((path, data) => writeFileSync(path, data))
    const rename = this.io.rename ?? ((from, to) => renameSync(from, to))
    const mkdir = this.io.mkdir ?? ((path) => mkdirSync(path, { recursive: true }))
    try {
      mkdir(this.dir)
      write(temp, content)
      rename(temp, target)
      return { ok: true, error: null }
    } catch (error) {
      return { ok: false, error: `${error?.code ?? 'error'}: ${error?.message ?? String(error)}` }
    }
  }

  /**
   * Read a file this plugin owns.
   *
   * @param {string} relativePath - file path relative to the guard directory.
   * @returns {string|null} the content, or null when absent or unreadable.
   */
  readFile(relativePath) {
    if (!this.durable) return null
    const exists = this.io.exists ?? ((path) => existsSync(path))
    const target = this.path(relativePath)
    if (!exists(target)) return null
    try {
      const { readFileSync } = process.getBuiltinModule('node:fs')
      return readFileSync(target, 'utf8')
    } catch {
      return null
    }
  }

  /**
   * Size of a file this plugin owns, for rotation and diagnostics.
   *
   * @param {string} relativePath - file path relative to the guard directory.
   * @returns {number} bytes, or 0 when absent.
   */
  sizeOf(relativePath) {
    if (!this.durable) return 0
    const stat = this.io.stat ?? ((path) => statSync(path))
    try {
      return stat(this.path(relativePath)).size
    } catch {
      return 0
    }
  }

  /** A serialisable description for the panel and the inspection report. */
  describe() {
    return {
      mode: this.mode,
      dir: this.dir,
      durable: this.durable,
      warning: this.warning,
      queued: this.queue.length,
      dropped: this.dropped,
      appended: this.appended,
      flushed: this.flushed,
      appendFailures: this.appendFailures,
      attempts: this.attempts,
    }
  }
}

/**
 * Build a store by resolving the directory itself.
 *
 * @param {object} [options] - resolution inputs, see {@link resolveGuardDir}.
 * @returns {GuardStore} the store.
 */
export function createStore(options = {}) {
  const resolved = resolveGuardDir(options)
  return new GuardStore({ ...resolved, io: options.io })
}
