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
  assert.equal(samePath('D:\\a', ''), false)
})

test('isInside is separator-aware and does not confuse sibling prefixes', () => {
  assert.equal(isInside('D:\\a\\b', 'D:\\a\\b'), true)
  assert.equal(isInside('D:\\a\\b', 'D:\\a\\b\\c'), true)
  assert.equal(isInside('D:\\a\\b', 'D:\\a\\bc'), false, 'D:\\a\\bc is not inside D:\\a\\b')
  assert.equal(isInside('D:\\a', 'D:\\other'), false)
})

// ---------------------------------------------------------------------------
// Protected-path pattern compilation.
// ---------------------------------------------------------------------------
test('compilePattern expands $DSH_HOME and marks recursion', () => {
  const compiled = compilePattern('$DSH_HOME/sessions/**', { dshHome: 'C:\\home' })
  assert.equal(compiled.recursive, true)
  assert.equal(matchesPattern(compiled, 'C:\\home\\sessions\\--D-proj--'), true)
  assert.equal(matchesPattern(compiled, 'C:\\home\\sessions'), true, 'the root itself is included')
  assert.equal(matchesPattern(compiled, 'C:\\home\\storages'), false)
})

test('compilePattern compiles an exact path without recursion', () => {
  const compiled = compilePattern('$DSH_HOME/.credentials.yaml', { dshHome: 'C:\\home' })
  assert.equal(compiled.recursive, false)
  assert.equal(matchesPattern(compiled, 'C:\\home\\.credentials.yaml'), true)
  assert.equal(matchesPattern(compiled, 'C:\\home\\.credentials.yaml.bak'), false)
})

test('compilePattern expands a leading tilde against the DSH home', () => {
  const compiled = compilePattern('~/sessions/**', { dshHome: 'C:\\home' })
  assert.equal(matchesPattern(compiled, 'C:\\home\\sessions\\x'), true)
})

test('compilePattern over an empty pattern never matches', () => {
  const compiled = compilePattern('', { dshHome: 'C:\\home' })
  assert.equal(matchesPattern(compiled, 'C:\\home\\anything'), false)
})

test('expandHome only expands supported prefixes', () => {
  assert.equal(expandHome('~', 'C:\\home'), 'C:\\home')
  assert.equal(expandHome('~/x', 'C:\\home'), 'C:\\home\\x')
  assert.equal(expandHome('~other/x', 'C:\\home'), '~other/x')
  assert.equal(expandHome('D:\\x', 'C:\\home'), 'D:\\x')
})

// ---------------------------------------------------------------------------
// describePath: missing paths must be reported, not thrown.
// ---------------------------------------------------------------------------
test('describePath reports a missing path without throwing', () => {
  const info = describePath('Z:\\definitely-not-present\\nope')
  assert.equal(info.exists, false)
  assert.equal(info.kind, 'missing')
  assert.equal(info.realPath, null)
})

test('describePath reports empty input as an error, not as absence', () => {
  const info = describePath('')
  assert.equal(info.exists, false)
  assert.equal(info.error, 'empty-path')
})
