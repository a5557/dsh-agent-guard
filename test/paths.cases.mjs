/**
 * Path, pattern and encoder tests.
 *
 * The encoder vectors are not invented: they were checked against the host's own
 * `projectKey` behaviour and against the live store before being frozen here (see
 * `.verify/verify-encoder.mjs`). The encoding is case-preserving and lossy, so the
 * tests pin exact strings rather than round-tripping.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sep } from 'node:path'

import { projectKey, sessionSegment, encodeUnsafe } from '../lib/encoding.js'
import {
  compilePattern,
  describePath,
  expandHome,
  isInside,
  IS_WINDOWS,
  matchesPattern,
  normalizeForCompare,
  samePath,
} from '../lib/paths.js'

// ---------------------------------------------------------------------------
// Platform-relative path constants.
//
// These tests must assert under THIS platform's path semantics. `C:\home` is not
// an absolute path on Linux, so `path.resolve` treats it as relative and every
// pattern assertion built on it fails. The first version hardcoded Windows paths,
// and the three-platform CI matrix -- configured but never executed -- is what
// finally surfaced it: 175 passed / 7 failed on ubuntu and macos, all green on
// windows.
//
// The implementation itself was already platform-correct (`IS_WINDOWS`); only the
// tests carried the assumption.
// ---------------------------------------------------------------------------
/** A home directory that is absolute on this platform. */
const HOME_DIR = IS_WINDOWS ? 'C:\\home' : '/home/test'
/** A separate root, for the "not inside / not expanded" cases. */
const OTHER_ROOT = IS_WINDOWS ? 'D:\\x' : '/mnt/x'
/** Join segments with this platform's separator. */
const p = (...parts) => parts.join(sep)

// ---------------------------------------------------------------------------
// Encoder: exact behaviour of the host's project-key algorithm.
// ---------------------------------------------------------------------------
test('projectKey reproduces the host store directory-name shape', () => {
  // 用中性的合成路径做向量，避免把作者本机的真实工作区名带进仓库（§19.2）。
  assert.equal(projectKey('C:\\proj-a'), '--C-proj-a--')
  assert.equal(projectKey('C:\\PROJ-B'), '--C-PROJ-B--')
})

test('projectKey collapses separator runs and preserves letter case', () => {
  assert.equal(projectKey('C:\\a\\b'), '--C-a-b--')
  assert.equal(projectKey('/home/user/proj'), '--home-user-proj--')
  // Case must NOT be folded: the live store contains mixed-case keys.
  assert.notEqual(projectKey('C:\\PROJ-B'), projectKey('C:\\proj-b'))
})

test('projectKey escapes unsafe code units as ~XXXX uppercase hex', () => {
  assert.equal(projectKey('D:\\a b'), '--D-a~0020b--')
  assert.equal(projectKey('D:\\x~y'), '--D-x~007Ey--')
})

test('projectKey bounds length and never returns a bare separator run', () => {
  const long = `D:\\${'a'.repeat(400)}`
  const key = projectKey(long)
  assert.ok(key.length <= 255, 'the key must stay within a filesystem component limit')
  assert.ok(key.startsWith('--') && key.endsWith('--'))
  assert.equal(projectKey('\\\\'), '--root--')
})

test('projectKey rejects an empty path instead of inventing a key', () => {
  assert.throws(() => projectKey(''), /empty project path/)
  assert.throws(() => projectKey(null), TypeError)
})

test('sessionSegment escapes path-unsafe characters', () => {
  assert.equal(sessionSegment('session-abc_1'), 'session-abc_1')
  assert.equal(sessionSegment('a/b'), 'a~002Fb')
  assert.equal(encodeUnsafe('~'), '~007E')
})

// ---------------------------------------------------------------------------
// Normalization and containment.
// ---------------------------------------------------------------------------
test('normalizeForCompare is case-insensitive on Windows and otherwise exact', () => {
  const a = normalizeForCompare('D:\\Proj\\Sub\\')
  const b = normalizeForCompare('d:/proj/sub')
  if (IS_WINDOWS) assert.equal(a, b)
  else assert.notEqual(a, b)
})

test('samePath treats an empty path as never matching', () => {
  assert.equal(samePath('', ''), false)
  assert.equal(samePath(p(OTHER_ROOT, 'a'), ''), false)
})

test('isInside is separator-aware and does not confuse sibling prefixes', () => {
  const parent = p(OTHER_ROOT, 'a', 'b')
  const child = p(parent, 'c')
  const sibling = p(OTHER_ROOT, 'a', 'bc')
  assert.equal(isInside(parent, parent), true)
  assert.equal(isInside(parent, child), true)
  assert.equal(isInside(parent, sibling), false, `${sibling} is not inside ${parent}`)
  assert.equal(isInside(p(OTHER_ROOT, 'a'), p(OTHER_ROOT, 'other')), false)
})

// ---------------------------------------------------------------------------
// Protected-path pattern compilation.
// ---------------------------------------------------------------------------
test('compilePattern expands $DSH_HOME and marks recursion', () => {
  const compiled = compilePattern('$DSH_HOME/sessions/**', { dshHome: HOME_DIR })
  assert.equal(compiled.recursive, true)
  assert.equal(matchesPattern(compiled, p(HOME_DIR, 'sessions', '--D-proj--')), true)
  assert.equal(matchesPattern(compiled, p(HOME_DIR, 'sessions')), true, 'the root itself is included')
  assert.equal(matchesPattern(compiled, p(HOME_DIR, 'storages')), false)
})

test('compilePattern compiles an exact path without recursion', () => {
  const compiled = compilePattern('$DSH_HOME/.credentials.yaml', { dshHome: HOME_DIR })
  assert.equal(compiled.recursive, false)
  assert.equal(matchesPattern(compiled, p(HOME_DIR, '.credentials.yaml')), true)
  assert.equal(matchesPattern(compiled, p(HOME_DIR, '.credentials.yaml.bak')), false)
})

test('compilePattern expands a leading tilde against the DSH home', () => {
  const compiled = compilePattern('~/sessions/**', { dshHome: HOME_DIR })
  assert.equal(matchesPattern(compiled, p(HOME_DIR, 'sessions', 'x')), true)
})

test('compilePattern over an empty pattern never matches', () => {
  const compiled = compilePattern('', { dshHome: HOME_DIR })
  assert.equal(matchesPattern(compiled, p(HOME_DIR, 'anything')), false)
})

test('expandHome only expands supported prefixes', () => {
  assert.equal(expandHome('~', HOME_DIR), HOME_DIR)
  assert.equal(expandHome('~/x', HOME_DIR), p(HOME_DIR, 'x'))
  assert.equal(expandHome('~other/x', HOME_DIR), '~other/x')
  assert.equal(expandHome(p(OTHER_ROOT, 'x'), HOME_DIR), p(OTHER_ROOT, 'x'))
})

// ---------------------------------------------------------------------------
// describePath: missing paths must be reported, not thrown.
// ---------------------------------------------------------------------------
test('describePath reports a missing path without throwing', () => {
  const info = describePath(p(OTHER_ROOT, 'definitely-not-present', 'nope'))
  assert.equal(info.exists, false)
  assert.equal(info.kind, 'missing')
  assert.equal(info.realPath, null)
})

test('describePath reports empty input as an error, not as absence', () => {
  const info = describePath('')
  assert.equal(info.exists, false)
  assert.equal(info.error, 'empty-path')
})
