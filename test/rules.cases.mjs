/**
 * Rule-engine tests T1–T9 from `DESIGN.md` §12.1, plus the failure-path guarantees
 * from §6.6.
 *
 * Every case is pure: these tests construct a compiled engine from temp-home-
 * relative paths and assert decisions. No DSH state is read or written.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildEngine } from '../lib/index.js'
import { classify, classifySafely, DECISIONS, detectEmittedScript } from '../lib/rules.js'
import { IS_WINDOWS, normalizeForCompare } from '../lib/paths.js'

const DSH_HOME = join('C:', 'fixture-dsh-home')
const WORKSPACE = join('C:', 'fixture-dsh-home', 'workspaces', 'proj')

/** A compiled engine over fixture paths; no filesystem access is required. */
function engine() {
  return buildEngine({ dshHome: DSH_HOME, workspaceRoots: [WORKSPACE] })
}

/** Context with DSH treated as running and a permissive budget. */
function context(overrides = {}) {
  return {
    engine: engine(),
    dshState: { running: true },
    budget: { goalClass: 'workspace-content', justified: false },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// T1 — a write to the workspace registry while DSH runs must not be allowed.
// ---------------------------------------------------------------------------
test('T1: write $DSH_HOME/storages/workspace.json (DSH running) → blocked/require-justification', () => {
  const decision = classify('write', [join(DSH_HOME, 'storages', 'workspace.json')], context())
  assert.ok(
    decision.kind === 'blocked' || decision.kind === 'require-justification',
    `expected blocked or require-justification, got ${decision.kind}`,
  )
  assert.equal(decision.classification.protected, true, 'the registry must classify as protected')
  assert.equal(decision.classification.budget, 'core-data')
  // A hard block forbids the action outright, so it imposes no backup obligation;
  // the gate that permits the write does. Neither outcome may be an unbacked write.
  assert.equal(decision.kind === 'blocked', decision.requiresBackup === false)
})

test('T1b: once DSH is stopped, the same write is gated and obliges a backup', () => {
  const decision = classify(
    'write',
    [join(DSH_HOME, 'storages', 'workspace.json')],
    context({ dshState: { running: false } }),
  )
  assert.equal(decision.kind, 'require-justification')
  assert.equal(decision.requiresBackup, true, 'a permitted core-data write must require a backup first')
})

// ---------------------------------------------------------------------------
// T2 — renaming several protected session directories is the incident's shape.
// ---------------------------------------------------------------------------
test('T2: rename-many over session storage dirs → blocked + incident warning', () => {
  const targets = [
    join(DSH_HOME, 'sessions', '--D-proj-a--'),
    join(DSH_HOME, 'sessions', '--D-proj-b--'),
  ]
  const decision = classify('rename-many', targets, context())
  assert.equal(decision.kind, 'blocked')
  assert.equal(decision.code, 'rename-many-protected')
  assert.match(decision.warning ?? '', /历史事故形态/, 'the warning must name the historical incident shape')
})

test('T2b: renaming ONE protected directory is not the batch shape', () => {
  const decision = classify('rename-many', [join(DSH_HOME, 'sessions', '--D-proj-a--')], context())
  assert.notEqual(decision.kind, 'blocked')
})

// ---------------------------------------------------------------------------
// T3 — a junction on a workspace root requires confirmation.
// ---------------------------------------------------------------------------
test('T3: link at a workspace root → require-confirmation + identity-split warning', () => {
  const decision = classify('link', [WORKSPACE], context())
  assert.equal(decision.kind, 'require-confirmation')
  assert.equal(decision.code, 'link-protected')
  assert.match(decision.warning ?? '', /身份分裂/)
})

// ---------------------------------------------------------------------------
// T4 — deleting session storage is refused.
// ---------------------------------------------------------------------------
test('T4: delete $DSH_HOME/sessions/** → blocked', () => {
  const decision = classify('delete', [join(DSH_HOME, 'sessions', '--D-proj-a--')], context())
  assert.equal(decision.kind, 'blocked')
  assert.equal(decision.code, 'delete-protected')
})

test('T4b: delete with explicit destructive authorisation still requires confirmation and a backup', () => {
  const decision = classify('delete', [join(DSH_HOME, 'sessions', '--D-proj-a--')], context({ allowDestructive: true }))
  assert.equal(decision.kind, 'require-confirmation')
  assert.equal(decision.requiresBackup, true)
})

// ---------------------------------------------------------------------------
// T5 — reads pass and are not journaled (no noise).
// ---------------------------------------------------------------------------
test('T5: read of a session header → allowed, no backup, no journal', () => {
  const decision = classify('read', [join(DSH_HOME, 'sessions', '--D-proj-a--', 'session-1')], context())
  assert.equal(decision.kind, 'allowed')
  assert.equal(decision.code, 'read-passthrough')
  assert.equal(decision.requiresBackup, false)
})

// ---------------------------------------------------------------------------
// T6 — the impact budget refuses core-data writes for a display-classified goal.
// ---------------------------------------------------------------------------
test('T6: goalClass=display writing core data → blocked (impact budget)', () => {
  const decision = classify(
    'write',
    [join(DSH_HOME, 'storages', 'workspace.json')],
    context({ budget: { goalClass: 'display', justified: false } }),
  )
  assert.equal(decision.kind, 'blocked')
  assert.equal(decision.code, 'budget-exceeded')
})

test('T6b: budget upgrade is never granted by the agent alone — display stays display', () => {
  // A display-classified goal cannot write core data even when DSH is stopped and a
  // justification is offered: only the user may upgrade the classification.
  const decision = classify(
    'write',
    [join(DSH_HOME, 'sessions', '--D-proj-a--')],
    context({ dshState: { running: false }, budget: { goalClass: 'display', justified: true } }),
  )
  assert.equal(decision.kind, 'blocked')
  assert.equal(decision.code, 'budget-exceeded')
})

test('T6c: workspace-content writing workspace files is allowed', () => {
  const decision = classify('write', [join(WORKSPACE, 'src', 'index.js')], context())
  assert.equal(decision.kind, 'allowed')
  assert.equal(decision.code, 'workspace-write')
})

// ---------------------------------------------------------------------------
// T7 — circuit breaker on repeated writes whose checksum moved.
// ---------------------------------------------------------------------------
test('T7: second consecutive write on one path with changed checksum → pause-required', () => {
  const target = join(WORKSPACE, 'src', 'index.js')
  const decision = classify('write', [target], context({ priorWritesOnSamePath: 2, checksumChanged: true }))
  assert.equal(decision.kind, 'pause-required')
  assert.equal(decision.code, 'circuit-breaker')
})

test('T7b: a repeat write with an unchanged checksum does not trip the breaker', () => {
  const target = join(WORKSPACE, 'src', 'index.js')
  const decision = classify('write', [target], context({ priorWritesOnSamePath: 2, checksumChanged: false }))
  assert.equal(decision.kind, 'allowed')
})

test('T7c: a first write never trips the breaker', () => {
  const target = join(WORKSPACE, 'src', 'index.js')
  const decision = classify('write', [target], context({ priorWritesOnSamePath: 1, checksumChanged: true }))
  assert.equal(decision.kind, 'allowed')
})

// ---------------------------------------------------------------------------
// T8 — an undeterminable DSH state is treated as "not stopped" (fail-closed).
// ---------------------------------------------------------------------------
test('T8: dshState running=unknown writing core data → blocked (fail-closed)', () => {
  const decision = classify(
    'write',
    [join(DSH_HOME, 'storages', 'workspace.json')],
    context({ dshState: { running: 'unknown' } }),
  )
  assert.equal(decision.kind, 'blocked')
  assert.equal(decision.code, 'core-data-while-running')
})

test('T8b: core-data write is only justification-gated once DSH is known stopped', () => {
  const decision = classify(
    'write',
    [join(DSH_HOME, 'storages', 'workspace.json')],
    context({ dshState: { running: false } }),
  )
  assert.equal(decision.kind, 'require-justification')
  assert.equal(decision.requiresBackup, true)
})

// ---------------------------------------------------------------------------
// T9 — an engine fault degrades to "backup + warn", never to an unbacked allow.
// ---------------------------------------------------------------------------
test('T9: engine fault → allowed-with-backup + engine-fault warning', () => {
  const poisoned = {
    get protected() {
      throw new Error('synthetic engine fault')
    },
  }
  const decision = classifySafely('write', [join(DSH_HOME, 'storages', 'workspace.json')], {
    engine: poisoned,
    dshState: { running: true },
  })
  assert.equal(decision.kind, 'allowed-with-backup')
  assert.equal(decision.warning, 'engine-fault')
  assert.equal(decision.code, 'engine-fault')
  assert.equal(decision.requiresBackup, true, 'a fault must never yield an unbacked allow')
})

// ---------------------------------------------------------------------------
// Contract coverage beyond T1–T9
// ---------------------------------------------------------------------------
test('unknown actions fail closed toward confirmation, not allowance', () => {
  const decision = classify('exfiltrate-everything', [join(WORKSPACE, 'x')], context())
  assert.equal(decision.kind, 'require-confirmation')
  assert.equal(decision.code, 'unknown-action')
  assert.equal(decision.requiresBackup, true)
})

test('every decision kind is one the documented set names', () => {
  const samples = [
    classify('read', [join(WORKSPACE, 'a')], context()),
    classify('write', [join(WORKSPACE, 'a')], context()),
    classify('write', [join(DSH_HOME, 'storages', 'x')], context()),
    classify('link', [WORKSPACE], context()),
    classify('delete', [join(DSH_HOME, 'sessions', 'x')], context()),
  ]
  for (const decision of samples) {
    assert.ok(DECISIONS.includes(decision.kind), `${decision.kind} must be a documented decision kind`)
    assert.equal(typeof decision.reason, 'string')
    assert.ok(decision.reason.length > 0, 'every decision must carry a human-readable reason')
  }
})

test('kill and emit-script require confirmation and carry their warnings', () => {
  const killed = classify('kill', [], context())
  assert.equal(killed.kind, 'require-confirmation')
  assert.match(killed.warning ?? '', /先备份/)

  const emitted = classify('emit-script', [join(DSH_HOME, 'sessions', 'x')], context())
  assert.equal(emitted.kind, 'require-confirmation')
  assert.equal(emitted.code, 'emit-script')
  assert.equal(emitted.requiresBackup, false, 'emitting a script changes no data itself')
})

test('an empty target list never claims protection it did not establish', () => {
  const decision = classify('write', [], context())
  assert.equal(decision.classification.protected, false)
  assert.equal(decision.kind, 'allowed')
})

test('classification is deterministic for identical inputs', () => {
  const ctx = context()
  const a = classify('write', [join(DSH_HOME, 'storages', 'workspace.json')], ctx)
  const b = classify('write', [join(DSH_HOME, 'storages', 'workspace.json')], ctx)
  assert.deepEqual(a, b)
})

// ---------------------------------------------------------------------------
// Protected-path identity when part of the path is a reparse point.
//
// `classifyTarget` matches a target's PHYSICAL path (`realpathSync`), so if the
// protected table is compiled from the logical `$DSH_HOME`, any ancestor that is a
// reparse point makes every entry miss -- and a miss means "allow a core-data write".
//
// This is not hypothetical: macOS `os.tmpdir()` is `/var/folders/…` and `/var` is
// an absolute symlink to `/private/var`, so `realpathSync` rewrote every fixture
// path while `$DSH_HOME` kept the logical one. Ubuntu and Windows runners have real
// `/tmp` and `%TEMP%`, so the three-platform matrix failed exactly and only on
// macOS, in every case that asserts a denial. The link below recreates that shape
// on any platform, so the regression cannot come back quietly.
// ---------------------------------------------------------------------------
/** Link a directory to `linkPath`, preferring `type` (a junction needs no elevation). */
function linkDirectory(target, linkPath, type) {
  try {
    symlinkSync(target, linkPath, type)
    return true
  } catch {
    return false
  }
}

/**
 * Create a directory link that this runtime actually RESOLVES, or return false.
 *
 * "does not resolve" is not a detail that may be skipped silently: on Windows a
 * junction created by `fs.symlinkSync(..., 'junction')` is followed by
 * `fs.realpathSync.native` but not by `fs.realpathSync`, and a directory symlink
 * needs Developer Mode. This check makes the difference visible (the case skips
 * with a reason) instead of letting a link-shaped plain directory masquerade as a
 * passing regression test -- which is how a test quietly stops testing anything.
 *
 * @param {string} target - directory the link should point at.
 * @param {string} linkPath - path of the link to create.
 * @returns {boolean} whether a resolvable link now exists at `linkPath`.
 */
function linkThatResolves(target, linkPath) {
  const { realpathSync } = process.getBuiltinModule('node:fs')
  const types = IS_WINDOWS ? ['junction', 'dir'] : ['dir']
  for (const type of types) {
    // A leftover entry from a failed attempt would make the next one fail with EEXIST.
    rmSync(linkPath, { recursive: true, force: true })
    if (!linkDirectory(target, linkPath, type)) continue
    try {
      if (normalizeForCompare(realpathSync.native(linkPath)) !== normalizeForCompare(linkPath)) return true
    } catch {
      // Unresolvable link: fall through to the next type.
    }
  }
  rmSync(linkPath, { recursive: true, force: true })
  return false
}

test('protected identity survives a symlinked path component (macOS /var shape)', (t) => {
  const realRoot = mkdtempSync(join(tmpdir(), 'dsh-guard-link-'))
  t.after(() => rmSync(realRoot, { recursive: true, force: true }))

  // A distinct name, so the logical path genuinely differs from the physical one
  // even on systems without a `var -> /private/var` style indirection.
  const linkRoot = `${realRoot}-link`
  // A junction is a reparse point too, and unlike a symlink it needs no elevation on
  // Windows -- so this case actually runs on every platform instead of skipping.
  if (!linkThatResolves(realRoot, linkRoot)) {
    t.skip('this runtime cannot create a directory link it resolves: the regression cannot be reproduced here')
    return
  }
  t.after(() => rmSync(linkRoot, { recursive: true, force: true }))

  const physicalHome = join(realRoot, 'home')
  const logicalHome = join(linkRoot, 'home')
  for (const dir of ['sessions', 'storages']) mkdirSync(join(physicalHome, dir), { recursive: true })
  const physicalWorkspace = join(physicalHome, 'workspaces', 'proj')
  mkdirSync(join(physicalWorkspace, 'src'), { recursive: true })

  assert.notEqual(logicalHome, physicalHome, 'the fixture must actually exercise the link')

  // The engine is built from the path shape a caller has in hand (logical), exactly
  // as the host hands `$DSH_HOME` to the plugin.
  const engine = buildEngine({ dshHome: logicalHome, workspaceRoots: [logicalHome] })

  const coreData = classify('write', [join(logicalHome, 'storages', 'workspace.json')], {
    engine,
    dshState: { running: true },
  })
  assert.equal(coreData.classification.protected, true, 'a core-data write must be classified through the link')
  assert.equal(coreData.kind, 'blocked', 'DSH running + core data through a link must still be denied')

  // A reparse point inside a protected directory must not be a way around the table
  // either: `proj/public` points INTO the protected home.
  assert.equal(linkThatResolves(physicalHome, join(physicalWorkspace, 'public')), true, 'the inner link must resolve')
  const viaReparsePoint = classify('write', [join(logicalHome, 'workspaces', 'proj', 'public', 'storages', 'x')], {
    engine,
    dshState: { running: true },
  })
  assert.equal(viaReparsePoint.classification.protected, true, 'a link into protected data must not smuggle a write past the table')
  assert.equal(viaReparsePoint.kind, 'blocked', 'and the write itself must still be denied')

  // A script that renames a session directory is the incident's payload (REL. R4). Its
  // text is matched against the same table, so the same identity space must apply --
  // otherwise "generate a .bat that renames sessions" is classified as a plain
  // workspace write and allowed on a platform where the paths differ in spelling.
  const emitted = detectEmittedScript({
    target: join(logicalHome, 'workspaces', 'proj', 'fix.bat'),
    content: `@echo off\r\nren "${join(logicalHome, 'sessions', '--D-proj-a--')}" "--D-proj-b--"\r\npause\r\n`,
    engine,
  })
  assert.equal(emitted.isEmitScript, true, 'a script referencing protected data must be flagged, never silently allowed')
  assert.equal(emitted.referenced.length, 1)
})

test('a linked path that leads OUTSIDE the protected data stays workspace data', (t) => {
  const realRoot = mkdtempSync(join(tmpdir(), 'dsh-guard-plain-'))
  t.after(() => rmSync(realRoot, { recursive: true, force: true }))

  const linkRoot = `${realRoot}-link`
  if (!linkThatResolves(realRoot, linkRoot)) {
    t.skip('this runtime cannot create a directory link it resolves: the regression cannot be reproduced here')
    return
  }
  t.after(() => rmSync(linkRoot, { recursive: true, force: true }))

  const home = join(linkRoot, 'home')
  const outside = join(linkRoot, 'outside')
  for (const dir of ['sessions', 'storages']) mkdirSync(join(home, dir), { recursive: true })
  mkdirSync(outside, { recursive: true })
  const engine = buildEngine({ dshHome: home, workspaceRoots: [outside] })
  const target = join(outside, 'src', 'index.js')

  const decision = classify('write', [target], { engine, dshState: { running: true } })
  // Being under a link is not itself a violation: only protected identity is.
  // (The target need not exist: normalization must not depend on creation order.)
  assert.equal(decision.classification.protected, false)
  assert.equal(decision.kind, 'allowed')
  assert.equal(decision.code, 'workspace-write')
})
