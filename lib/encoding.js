/**
 * Workspace-path encoding, mirroring the host's own project-key algorithm.
 *
 * DSH derives a session's storage directory name from the session's `cwd`
 * (`DESIGN.md` R1: "path is identity"). Reproducing that algorithm exactly is what
 * lets the inspector compare "registered path" against "on-disk layout" without
 * guessing — guessing here would be a correctness bug, not a cosmetic one.
 *
 * Algorithm reproduced from the host implementation
 * (`@deepseek-ai/dsh-session-persistence-jsonl`, `projectKey`):
 * - `/`, `\` and `:` collapse into a single `-` per run;
 * - `[A-Za-z0-9._-]` passes through UNCHANGED (the encoding is case-preserving);
 * - every other code unit becomes `~` plus its uppercase 4-digit hex code;
 * - the result is `--` + readable-with-leading-dashes-trimmed + `--`, bounded to
 *   251 readable characters (or the literal `root` when nothing survives).
 *
 * The mapping is intentionally lossy (separator runs collapse, long paths
 * truncate), so it must never be used to RECOVER a path. Recovering a path
 * requires reading a session's `cwd`, which is exactly what the inspector does.
 */

/** Maximum readable length kept before the surrounding dashes. */
const MAX_READABLE = 251

/** Code units that pass through unchanged. */
const SAFE = /^[A-Za-z0-9._-]$/

/**
 * Encode a workspace path into its session-storage directory name.
 *
 * @param {string} cwd - the session's project directory.
 * @returns {string} the encoded directory name, e.g. `--C-proj-a--`.
 * @throws {Error} when `cwd` is empty, matching the host's own contract.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string') throw new TypeError('projectKey expects a string')
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')

  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && SAFE.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const trimmed = readable.replace(/^-+/, '') || 'root'
  return `--${trimmed.slice(0, MAX_READABLE)}--`
}

/**
 * Encode a session id into one safe path segment.
 *
 * @param {string} id - the session id.
 * @returns {string} the encoded segment.
 */
export function sessionSegment(id) {
  return encodeUnsafe(String(id))
}

/**
 * Escape every code unit outside the filesystem-safe set.
 *
 * @param {string} input - text to escape.
 * @returns {string} the escaped text.
 */
export function encodeUnsafe(input) {
  let out = ''
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && SAFE.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}
