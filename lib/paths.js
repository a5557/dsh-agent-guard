/**
 * Path normalization and classification primitives.
 *
 * Every function here is read-only: it consumes path strings and, where needed,
 * filesystem *metadata*. Nothing in this module writes.
 *
 * Design notes:
 * - DSH treats an absolute path as an identity (`DESIGN.md` R1). Comparisons must
 *   therefore tolerate normalization differences, be case-insensitive on Windows,
 *   and resolve reparse points (junction / symlink) before deciding containment.
 * - Windows-only probes degrade to "unsupported" on other platforms instead of
 *   throwing (`DESIGN.md` §11).
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize, resolve, sep } from 'node:path'

/** True on platforms whose paths are case-insensitive and backslash-separated. */
export const IS_WINDOWS = process.platform === 'win32'

/** Drive-root shape, e.g. `D:`. */
const DRIVE_ROOT = /^[A-Za-z]:$/

/**
 * Normalize a path for comparison.
 *
 * Folds separators, removes a trailing separator, and lowercases on Windows.
 * Deliberately does not touch the filesystem, so it is safe for paths that do
 * not exist.
 *
 * @param {string} input - path text.
 * @returns {string} the comparison form, or an empty string for invalid input.
 */
export function normalizeForCompare(input) {
  if (typeof input !== 'string' || input.length === 0) return ''
  let out = normalize(input)
  // Windows accepts both separators; fold them so `D:/a` and `D:\a` compare equal.
  if (IS_WINDOWS) out = out.replace(/\//g, '\\')
  if (out.length > 1 && out.endsWith(sep)) {
    const without = out.slice(0, -1)
    if (!DRIVE_ROOT.test(without)) out = without
  }
  return IS_WINDOWS ? out.toLowerCase() : out
}

/**
 * Compare two paths for equality under this platform's identity rules.
 *
 * @param {string} a - first path.
 * @param {string} b - second path.
 * @returns {boolean} whether both denote the same location.
 */
export function samePath(a, b) {
  const left = normalizeForCompare(a)
  const right = normalizeForCompare(b)
  return left.length > 0 && left === right
}

/**
 * Whether `child` is `parent` itself or lies beneath it.
 *
 * Separator-aware, so `D:\a\bc` is NOT considered inside `D:\a\b`.
 *
 * @param {string} parent - candidate ancestor.
 * @param {string} child - candidate descendant.
 * @returns {boolean} true when contained.
 */
export function isInside(parent, child) {
  const p = normalizeForCompare(parent)
  const c = normalizeForCompare(child)
  if (p.length === 0 || c.length === 0) return false
  if (p === c) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/**
 * Classify how a path currently exists on disk.
 *
 * Distinguishes a real directory from a reparse point, because a junction is
 * precisely the state that splits "registered path" from "resolved path" in the
 * incident this plugin exists to prevent (`DESIGN.md` §1.1 step 4).
 *
 * @param {string} target - path to inspect.
 * @returns {{exists: boolean, kind: 'dir'|'file'|'junction'|'symlink'|'missing',
 *            realPath: string|null, linkTarget: string|null, error: string|null}}
 *   a metadata description; never throws.
 */
export function describePath(target) {
  const absent = { exists: false, kind: 'missing', realPath: null, linkTarget: null, error: null }
  if (typeof target !== 'string' || target.length === 0) {
    return { ...absent, error: 'empty-path' }
  }

  let stat
  try {
    stat = lstatSync(target)
  } catch (error) {
    if (error && error.code === 'ENOENT') return absent
    return { ...absent, error: `${error?.code ?? 'error'}: ${error?.message ?? String(error)}` }
  }

  const isLink = stat.isSymbolicLink()
  let linkTarget = null
  if (isLink) {
    try {
      linkTarget = readlinkSync(target)
    } catch {
      linkTarget = null
    }
  }

  let realPath = null
  let error = null
  try {
    realPath = realpathSync(target)
  } catch (caught) {
    error = `${caught?.code ?? 'error'}: ${caught?.message ?? String(caught)}`
  }

  return {
    exists: true,
    kind: !isLink ? (stat.isDirectory() ? 'dir' : 'file') : looksLikeJunction(linkTarget) ? 'junction' : 'symlink',
    realPath,
    linkTarget,
    error,
  }
}

/**
 * Heuristic label for a reparse point.
 *
 * Windows junctions surface through `lstat` as symbolic links and resolve to a
 * `\\?\`-prefixed target, whereas directory symlinks usually do not. This only
 * chooses the more informative label for a report; it is never a security
 * verdict, so a mislabel cannot change a decision.
 *
 * @param {string|null} linkTarget - raw reparse target, if any.
 * @returns {boolean} whether to label the entry a junction.
 */
export function looksLikeJunction(linkTarget) {
  return typeof linkTarget === 'string' && linkTarget.startsWith('\\\\?\\')
}

/**
 * Resolve a path to its physical location when possible.
 *
 * Falls back to the input when the path does not exist, so callers may still
 * normalize a target that has yet to be created.
 *
 * @param {string} target - path to resolve.
 * @returns {string} the real path when it exists, else the input.
 */
export function resolveReal(target) {
  return describePath(target).realPath ?? target
}

/**
 * Expand `~`, `~/` and `~\` against a supplied home directory.
 *
 * Mirrors the host's own expansion so configured paths behave identically.
 *
 * @param {string} input - configured path text.
 * @param {string} home - the home directory to expand against.
 * @returns {string} the expanded path.
 */
export function expandHome(input, home) {
  if (typeof input !== 'string') return ''
  if (input === '~') return home
  if (input.startsWith('~/') || input.startsWith('~\\')) return resolve(home, input.slice(2))
  return input
}

/**
 * Compile a protected-path pattern into matcher input.
 *
 * Supports the subset the rule set needs: `$DSH_HOME` substitution, `~`
 * expansion, and a trailing `/**` meaning "this directory and everything below".
 * A bare path matches only itself.
 *
 * @param {string} pattern - pattern text, e.g. `$DSH_HOME/sessions/**`.
 * @param {{dshHome: string}} context - substitution inputs.
 * @returns {{base: string, recursive: boolean}} normalized matcher input.
 */
export function compilePattern(pattern, context) {
  let text = String(pattern ?? '').trim()
  if (text.length === 0) return { base: '', recursive: false }
  if (text === '$DSH_HOME' || text.startsWith('$DSH_HOME/') || text.startsWith('$DSH_HOME\\')) {
    text = context.dshHome + text.slice('$DSH_HOME'.length)
  }
  text = expandHome(text, context.dshHome)
  let recursive = false
  if (text.endsWith('/**') || text.endsWith('\\**')) {
    recursive = true
    text = text.slice(0, -3)
  }
  return { base: normalizeForCompare(text), recursive }
}

/**
 * Whether a path matches a compiled pattern.
 *
 * @param {{base: string, recursive: boolean}} compiled - output of {@link compilePattern}.
 * @param {string} candidate - path to test.
 * @returns {boolean} true on a match.
 */
export function matchesPattern(compiled, candidate) {
  const target = normalizeForCompare(candidate)
  if (compiled.base.length === 0 || target.length === 0) return false
  return compiled.recursive ? isInside(compiled.base, target) : compiled.base === target
}

/**
 * Whether a path string is absolute under this platform's rules.
 *
 * @param {string} input - path text.
 * @returns {boolean} true when absolute.
 */
export function isAbsolutePath(input) {
  return typeof input === 'string' && input.length > 0 && isAbsolute(input)
}
