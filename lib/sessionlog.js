/**
 * Read-only access to DSH's session store.
 *
 * This module only ever READS. It never creates, renames, deletes, or writes
 * anything under `$DSH_HOME` — that constraint is the point of the plugin
 * (`DESIGN.md` §2.2, appendix A).
 *
 * Container facts, established by first-hand measurement (see
 * `.verify/session-format-evidence.md`):
 * - A session log is `<space>/<session>/session.v4.jsonl.zstd` where `<space>` is
 *   the encoded key of a workspace path (e.g. `--C-proj--`).
 * - The file is a sequence of concatenated zstd frames; the FIRST frame is the
 *   identity header. `zlib.zstdDecompressSync` returns at the end of the first
 *   frame, so one call yields exactly the header.
 * - Reading a bounded prefix is enough: a header frame is small, so the inspector
 *   stays O(header) rather than O(store).
 */

import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Bytes to read on the first attempt; enlarged on retry for oversized headers. */
const INITIAL_READ_BYTES = 8 * 1024

/** Upper bound for header reading, so a corrupt file cannot exhaust memory. */
const MAX_READ_BYTES = 128 * 1024

/**
 * Result of reading one session's identity header.
 *
 * @typedef {object} HeaderRead
 * @property {boolean} ok - whether a complete, parseable header was recovered.
 * @property {object|null} header - the parsed header, when `ok`.
 * @property {'ok'|'unreadable'|'incomplete'} status - failure classification.
 * @property {string|null} error - failure detail, when not `ok`.
 * @property {number} bytes - bytes read from disk.
 */

/**
 * Read and decode one session log's first frame.
 *
 * A truncated read is retried with a larger window. Only an explicit success is
 * reported as `ok`: an undecodable file is `unreadable` and a decodable prefix
 * that is not a complete JSON header is `incomplete`. Callers must not treat
 * either failure as "no record" — that inference is the mistake this plugin
 * exists to prevent (`DESIGN.md` R2).
 *
 * @param {string} file - absolute path to a `session*.jsonl.zstd` file.
 * @returns {HeaderRead} the read result.
 */
export function readSessionHeader(file) {
  let total = 0
  let lastError = null

  for (let limit = INITIAL_READ_BYTES; limit <= MAX_READ_BYTES; limit *= 2) {
    let bytes
    try {
      bytes = readPrefix(file, limit)
    } catch (error) {
      return {
        ok: false,
        header: null,
        status: 'unreadable',
        error: `${error?.code ?? 'error'}: ${error?.message ?? String(error)}`,
        bytes: total,
      }
    }
    total = bytes.length

    let text
    try {
      text = zstdDecompressSync(bytes).toString('utf8')
    } catch (error) {
      lastError = `${error?.code ?? 'error'}: ${error?.message ?? String(error)}`
      // A truncated final frame can fail to decode; a larger window may complete it.
      continue
    }

    const trimmed = text.trim()
    if (trimmed.length === 0) {
      lastError = 'empty-header-frame'
      continue
    }

    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      lastError = `header-json: ${error?.message ?? String(error)}`
      continue
    }

    // Structural completeness check: a real header always carries type and id.
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.type !== 'string' || typeof parsed.id !== 'string') {
      lastError = 'header-missing-type-or-id'
      continue
    }

    return { ok: true, header: parsed, status: 'ok', error: null, bytes: total }
  }

  return { ok: false, header: null, status: 'incomplete', error: lastError, bytes: total }
}

/**
 * Read at most `limit` bytes from the start of a file.
 *
 * @param {string} file - file to read.
 * @param {number} limit - maximum byte count.
 * @returns {Buffer} the bytes actually read.
 */
function readPrefix(file, limit) {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(limit)
    const read = readSync(fd, buffer, 0, limit, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * Decide whether a session header denotes a real conversation.
 *
 * Established by measurement plus host-source evidence: user conversations carry
 * NO `origin` field at all, while internal subagent records carry
 * `origin: 'subagent'`. The host's own display filter tests exactly
 * `session.origin === 'subagent'`.
 *
 * `delegationDepth > 0` is additionally treated as non-conversational. The host
 * writes `delegationDepth: 0` for ordinary sessions, so a positive depth always
 * marks delegated work — and a header with a missing `origin` but a real depth is
 * safer classified as internal than promoted to a "conversation".
 *
 * Caveat kept explicit: "unregistered therefore subagent" is NOT an invariant.
 * Registration is also performed by a one-time bootstrap that has no origin
 * filter, and an unregistered id may simply be a session whose directory is gone.
 * Classification therefore always comes from the header, never from bookkeeping.
 *
 * @param {object|null} header - a parsed identity header.
 * @returns {{countsAsConversation: boolean, reason: string}} the classification.
 */
export function classifyConversation(header) {
  if (header === null || typeof header !== 'object') {
    return { countsAsConversation: false, reason: 'unknown-origin' }
  }
  if (header.origin === 'subagent') {
    return { countsAsConversation: false, reason: 'origin-is-subagent' }
  }
  const depth = Number(header.delegationDepth ?? 0)
  if (Number.isFinite(depth) && depth > 0) {
    return { countsAsConversation: false, reason: 'delegation-depth-positive' }
  }
  return {
    countsAsConversation: true,
    reason: header.origin === undefined ? 'origin-absent' : `origin=${String(header.origin)}`,
  }
}

/**
 * List the encoded session spaces under a store root, with cheap layout facts.
 *
 * This does NOT decode any session file: it collects directory names and entry
 * counts only, so a per-turn snapshot stays inexpensive.
 *
 * @param {string} sessionsRoot - the `sessions` directory.
 * @returns {Array<{space: string, entries: Array<{session: string, file: string,
 *            bytes: number, mtimeMs: number}>}>} the layout, or an empty list when
 *   the root is absent.
 */
export function readLayout(sessionsRoot) {
  let spaces
  try {
    spaces = readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const out = []
  for (const space of spaces) {
    if (!space.isDirectory()) continue
    const spaceDir = join(sessionsRoot, space.name)
    let entries
    try {
      entries = readdirSync(spaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    const sessions = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(spaceDir, entry.name)
      const file = findLogFile(dir)
      if (file === null) {
        sessions.push({ session: entry.name, file: null, bytes: 0, mtimeMs: 0 })
        continue
      }
      let stat
      try {
        stat = statSync(file)
      } catch {
        sessions.push({ session: entry.name, file, bytes: 0, mtimeMs: 0 })
        continue
      }
      sessions.push({ session: entry.name, file, bytes: stat.size, mtimeMs: stat.mtimeMs })
    }
    out.push({ space: space.name, entries: sessions })
  }
  return out
}

/**
 * Locate the log file inside one session directory.
 *
 * Prefers the versioned name but accepts any `*.jsonl.zstd`, because the store has
 * been observed to contain older format versions (`version` 0/3/4 were all present
 * in the measured store).
 *
 * @param {string} dir - a session directory.
 * @returns {string|null} the log path, or null when absent.
 */
export function findLogFile(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const preferred = names.find((name) => name === 'session.v4.jsonl.zstd')
  if (preferred !== undefined) return join(dir, preferred)
  const any = names.filter((name) => name.endsWith('.jsonl.zstd')).sort()
  return any.length > 0 ? join(dir, any[0]) : null
}

/**
 * Short, stable digest of a header's identity fields.
 *
 * Used for snapshot comparison (G4 circuit breaking) without storing personal
 * content: it covers identity and layout fields only, never message text.
 *
 * @param {object|null} header - a parsed identity header.
 * @returns {string} a 16-character hex digest.
 */
export function headerDigest(header) {
  const material = header === null || typeof header !== 'object'
    ? 'null'
    : JSON.stringify([
        header.type ?? null,
        header.version ?? null,
        header.id ?? null,
        header.cwd ?? null,
        header.origin ?? null,
        header.delegationDepth ?? null,
        typeof header.parentSession === 'string' ? header.parentSession : null,
      ])
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/**
 * Mtime-and-size keyed cache for header reads.
 *
 * The inspector is called repeatedly during a session; caching by file identity
 * keeps repeat calls cheap while staying correct when a log is appended to.
 */
export class HeaderCache {
  /** @param {{maxEntries?: number}} [options] - cache sizing. */
  constructor(options = {}) {
    this.maxEntries = Number(options.maxEntries ?? 4096)
    this.entries = new Map()
    this.hits = 0
    this.misses = 0
  }

  /**
   * Read a header through the cache.
   *
   * @param {string} file - log path.
   * @param {{bytes: number, mtimeMs: number}} stat - current file facts.
   * @returns {HeaderRead} the (possibly cached) result.
   */
  read(file, stat) {
    const key = `${file}|${stat.bytes}|${Math.round(stat.mtimeMs)}`
    const cached = this.entries.get(key)
    if (cached !== undefined) {
      this.hits += 1
      return cached
    }
    this.misses += 1
    const result = readSessionHeader(file)
    if (this.entries.size >= this.maxEntries) {
      // Simple bounded eviction: drop the oldest inserted entry.
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(key, result)
    return result
  }
}
