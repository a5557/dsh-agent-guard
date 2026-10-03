/**
 * Golden incident samples (`DESIGN.md` §12.2) plus the `protected-inspect` output
 * contract (`§7`).
 *
 * G-1 is the acceptance test that matters most (§17.3): a subagent record must be
 * reported as `countsAsConversation: false` and must NOT be counted as a missing
 * conversation. Everything runs against a temporary DSH_HOME; the real one is never
 * opened.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { guardInspect } from '../lib/inspect.js'
import { classifyConversation, readSessionHeader } from '../lib/sessionlog.js'
import { fixtureWorkspace, makeTempHome, stubProbes, writeRegistry, writeSyntheticSession } from './fixtures.mjs'

/**
 * Build the incident-shaped fixture: one registered user conversation plus
 * intentionally unregistered subagent records and an orphaned space.
 *
 * @returns {{home: string, cleanup: Function, workspace: string}} fixture handle.
 */
function incidentFixture() {
  const temp = makeTempHome('incident')
  const workspace = fixtureWorkspace(temp.home, 'proj')
  const other = fixtureWorkspace(temp.home, 'other')

  // A real user conversation, registered.
  writeSyntheticSession({
    home: temp.home,
    cwd: workspace,
    id: 'session-user-0001',
    extraFrames: 2,
  })
  // Two subagent records in the same space, deliberately NOT registered.
  writeSyntheticSession({
    home: temp.home,
    cwd: workspace,
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    origin: 'subagent',
    delegationDepth: 1,
    parentSession: 'session-user-0001',
    extraFrames: 1,
  })
  writeSyntheticSession({
    home: temp.home,
    cwd: workspace,
    id: 'a1b2c3d4-0000-4000-8000-000000000002',
    origin: 'subagent',
    delegationDepth: 2,
    parentSession: 'a1b2c3d4-0000-4000-8000-000000000001',
  })
  // A record in a space whose workspace is no longer registered.
  writeSyntheticSession({ home: temp.home, cwd: other, id: 'session-orphan-0001' })

  writeRegistry({
    home: temp.home,
    workspaces: [
      { id: 'ws-1', path: workspace, title: 'fixture-workspace', sessionIds: ['session-user-0001'] },
    ],
  })

  return { ...temp, workspace }
}

// ---------------------------------------------------------------------------
// G-1 — identity-head recognition: subagent records are not conversations.
// ---------------------------------------------------------------------------
test('G-1: origin:"subagent" records are marked countsAsConversation:false and are not "missing conversations"', () => {
  const fixture = incidentFixture()
  try {
    const report = guardInspect({ dshHome: fixture.home, probes: stubProbes({ running: false }) })

    // The header must be read from the first frame, with origin intact.
    assert.equal(report.sessions.subagentRecords, 2, 'both subagent records must be identified')
    assert.equal(report.sessions.countsAsConversation, 2, 'the user conversation and the orphan are conversations')

    const subagents = report.sessions.identity.filter((row) => row.origin === 'subagent')
    assert.equal(subagents.length, 2)
    for (const row of subagents) {
      assert.equal(row.countsAsConversation, false)
      assert.equal(row.registered, false, 'subagent records are intentionally unregistered')
      assert.ok(row.delegationDepth >= 1)
      assert.equal(row.parentSession !== null, true)
    }

    // The whole point: an unregistered count must be reported WITH its origin split.
    const row = report.sessions.byWorkspace.find((entry) => entry.space !== null && entry.unregistered > 0)
    assert.ok(row !== undefined, 'the workspace with unregistered records must appear')
    assert.equal(row.unregisteredSubagentRecords, 2)
    assert.equal(row.unregisteredConversations, 0, 'no real conversation may be reported as unregistered')

    assert.ok(
      report.findings.some((finding) => finding.code === 'unregistered-subagent-records'),
      'the subagent finding must be present',
    )
    assert.ok(
      !report.findings.some((finding) => finding.code === 'unregistered-conversation-records'),
      'subagent records must never be narrated as unregistered conversations',
    )
  } finally {
    fixture.cleanup()
  }
})

test('G-1b: classifyConversation treats a positive delegation depth as internal even without origin', () => {
  assert.equal(classifyConversation({ origin: 'subagent' }).countsAsConversation, false)
  assert.equal(classifyConversation({ delegationDepth: 1 }).countsAsConversation, false)
  // User conversations carry no origin field at all — the common real case.
  assert.equal(classifyConversation({ type: 'session', id: 'x' }).countsAsConversation, true)
  assert.equal(classifyConversation({ origin: 'user' }).countsAsConversation, true)
  assert.equal(classifyConversation(null).countsAsConversation, false)
})

test('G-1c: a decodable header yields the identity fields the report relies on', () => {
  const fixture = incidentFixture()
  try {
    const report = guardInspect({ dshHome: fixture.home, probes: stubProbes({ running: false }) })
    const row = report.sessions.identity.find((entry) => entry.id === 'session-user-0001')
    assert.ok(row !== undefined, 'the registered conversation must appear in the identity list')
    assert.equal(row.cwd, fixture.workspace)
    assert.equal(row.formatVersion, 4)
    assert.equal(row.countsAsConversation, true)
    assert.equal(row.registered, true)
  } finally {
    fixture.cleanup()
  }
})

test('G-1d: readSessionHeader never mistakes an unreadable file for an absent record', async () => {
  const temp = makeTempHome('unreadable')
  try {
    const dir = join(temp.home, 'sessions', '--D-x--', 'session-broken')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    // Bytes that are not a zstd frame at all.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, Buffer.from('not-a-zstd-frame'))
    const result = readSessionHeader(file)
    assert.equal(result.ok, false)
    assert.ok(result.status === 'unreadable' || result.status === 'incomplete')
    assert.ok(typeof result.error === 'string' && result.error.length > 0)
    assert.equal(result.header, null)
  } finally {
    temp.cleanup()
  }
})

// ---------------------------------------------------------------------------
// G-2 — path/identity split is reported and no automatic repair is offered.
// ---------------------------------------------------------------------------
test('G-2: a missing registered path yields path-as-identity-mismatch and no repair advice', () => {
  const temp = makeTempHome('split')
  try {
    const missing = join(temp.home, 'workspaces', 'moved-away')
    writeRegistry({
      home: temp.home,
      workspaces: [{ id: 'ws-moved', path: missing, title: 'fixture-moved', sessionIds: [] }],
    })

    const report = guardInspect({ dshHome: temp.home, probes: stubProbes({ running: false }) })
    const finding = report.findings.find((entry) => entry.code === 'path-as-identity-mismatch')
    assert.ok(finding !== undefined, 'a missing registered path must be flagged')
    assert.equal(finding.severity, 'warn')

    const row = report.workspaces.find((entry) => entry.id === 'ws-moved')
    assert.equal(row.exists, false)
    assert.equal(row.kind, 'missing')

    // The tool must describe the safe process and refuse to invent a repair.
    const text = JSON.stringify(report)
    assert.ok(!/junction|mklink/i.test(finding.detail) || /不要用联接/.test(finding.detail),
      'the finding may mention junctions only to warn against them')
    assert.match(finding.detail, /不提供自动修复/)
  } finally {
    temp.cleanup()
  }
})

test('G-2b: the inspector never proposes writing to DSH storage', () => {
  const fixture = incidentFixture()
  try {
    const report = guardInspect({ dshHome: fixture.home, probes: stubProbes({ running: false }) })
    const text = JSON.stringify(report)
    for (const forbidden of ['自动修复', '迁移', 'rename', 'rewrite']) {
      assert.ok(!text.includes(forbidden), `the report must not suggest "${forbidden}"`)
    }
  } finally {
    fixture.cleanup()
  }
})

// ---------------------------------------------------------------------------
// §7 output contract
// ---------------------------------------------------------------------------
test('§7: output is reproducible apart from generatedAt', () => {
  const fixture = incidentFixture()
  try {
    const probes = stubProbes({ running: false })
    const first = guardInspect({ dshHome: fixture.home, probes })
    const second = guardInspect({ dshHome: fixture.home, probes })
    assert.deepEqual(second, first, 'identical inputs must produce an identical structure')
  } finally {
    fixture.cleanup()
  }
})

test('§7: inspecting does not write to the DSH home', async () => {
  const fixture = incidentFixture()
  try {
    const { readdirSync, statSync } = await import('node:fs')
    const snapshot = () => {
      const out = []
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else out.push(`${full}:${statSync(full).size}`)
        }
      }
      walk(fixture.home)
      return out.sort()
    }
    const before = snapshot()
    guardInspect({ dshHome: fixture.home, probes: stubProbes({ running: false }) })
    assert.deepEqual(snapshot(), before, 'a read-only inspector must leave the tree byte-identical')
  } finally {
    fixture.cleanup()
  }
})

test('§7: redacted mode removes real paths and titles', () => {
  const fixture = incidentFixture()
  try {
    const report = guardInspect({
      dshHome: fixture.home,
      probes: stubProbes({ running: false }),
      workspaceTitleMode: 'redacted',
    })
    const text = JSON.stringify(report)
    assert.ok(!text.includes('fixture-workspace'), 'titles must be redacted')
    assert.ok(!text.includes(fixture.workspace.replace(/\\/g, '\\\\')) || text.includes('<workspace>'))
    assert.ok(text.includes('<workspace>'))
  } finally {
    fixture.cleanup()
  }
})

test('§7.3: an unreadable registry is reported, never silently treated as zero workspaces', () => {
  const temp = makeTempHome('noregistry')
  try {
    const report = guardInspect({ dshHome: temp.home, probes: stubProbes({ running: false }) })
    const finding = report.findings.find((entry) => entry.code === 'registry-unreadable')
    assert.ok(finding !== undefined, 'a missing registry must be flagged rather than reported as empty')
    assert.equal(report.dsh.registryReadable, false)
    assert.equal(report.workspaces.length, 0)
  } finally {
    temp.cleanup()
  }
})

test('§7.2: DSH running state is reported from probes, with fail-closed unknown handling', () => {
  const fixture = incidentFixture()
  try {
    const running = guardInspect({ dshHome: fixture.home, probes: stubProbes({ running: true }) })
    assert.equal(running.dsh.appRunning, true)

    const unknown = guardInspect({
      dshHome: fixture.home,
      probes: {
        listProcesses: () => {
          throw new Error('synthetic probe failure')
        },
        listPorts: () => {
          throw new Error('synthetic probe failure')
        },
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      },
    })
    assert.equal(unknown.dsh.appRunning, null, 'an unevaluable probe must report null, not false')
  } finally {
    fixture.cleanup()
  }
})

test('§7: maxSessions caps decoding and says so instead of pretending completeness', () => {
  const fixture = incidentFixture()
  try {
    const report = guardInspect({
      dshHome: fixture.home,
      probes: stubProbes({ running: false }),
      maxSessions: 1,
    })
    assert.equal(report.sessions.decoded, 1)
    assert.equal(report.sessions.truncated, true, 'a capped run must be flagged as incomplete')
  } finally {
    fixture.cleanup()
  }
})

test('scope selection omits sections that were not requested', () => {
  const fixture = incidentFixture()
  try {
    const report = guardInspect({
      dshHome: fixture.home,
      probes: stubProbes({ running: false }),
      scope: ['workspaces'],
    })
    assert.equal(report.sessions.skipped, true)
    assert.equal(report.layout, undefined)
    assert.equal(report.dsh.appRunning, null, 'processes were not in scope')
  } finally {
    fixture.cleanup()
  }
})

test('workspace filter restricts output to one workspace', () => {
  const fixture = incidentFixture()
  try {
    const report = guardInspect({
      dshHome: fixture.home,
      probes: stubProbes({ running: false }),
      workspace: fixture.workspace,
    })
    assert.equal(report.workspaces.length, 1)
    assert.equal(report.workspaces[0].id, 'ws-1')
  } finally {
    fixture.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Orphaned spaces carry no deletion advice
// ---------------------------------------------------------------------------
test('an orphaned session space is reported as info without proposing deletion', () => {
  const fixture = incidentFixture()
  try {
    const report = guardInspect({ dshHome: fixture.home, probes: stubProbes({ running: false }) })
    const finding = report.findings.find((entry) => entry.code === 'orphan-session-space')
    assert.ok(finding !== undefined, 'the orphaned space must be reported')
    assert.equal(finding.severity, 'info')
    assert.match(finding.detail, /不自动删除/)
  } finally {
    fixture.cleanup()
  }
})

// Keep an explicit reference so unused-import removal cannot silently drop rmSync.
void rmSync
