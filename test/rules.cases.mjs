/**
 * Rule-engine tests T1–T9 from `DESIGN.md` §12.1, plus the failure-path guarantees
 * from §6.6.
 *
 * Every case is pure: these tests construct a compiled engine from temp-home-
 * relative paths and assert decisions. No DSH state is read or written.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { buildEngine } from '../lib/index.js'
import { classify, classifySafely, DECISIONS } from '../lib/rules.js'

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
