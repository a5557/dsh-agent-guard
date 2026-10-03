/**
 * Test fixtures: synthetic `DSH_HOME` trees built in the OS temp directory.
 *
 * Discipline (`DESIGN.md` §12.3): every test runs against a temporary DSH_HOME.
 * The real `~/.dsh` is never touched, and no fixture is derived from a real
 * session — all content here is invented, with placeholder names only.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { projectKey } from '../lib/encoding.js'

/**
 * Create a temporary DSH_HOME.
 *
 * @param {string} [label] - short label used in the directory name.
 * @returns {{home: string, cleanup: () => void}} the fixture handle.
 */
export function makeTempHome(label = 'guard') {
  const home = mkdtempSync(join(tmpdir(), `dsh-${label}-`))
  for (const dir of ['sessions', 'storages', 'profiles']) {
    mkdirSync(join(home, dir), { recursive: true })
  }
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

/**
 * Write a synthetic session log.
 *
 * The real container is a sequence of concatenated zstd frames whose FIRST frame
 * is exactly one header line. Frames after the first stand in for appended event
 * batches, so tests exercise the "stop at the first frame" behaviour.
 *
 * @param {object} input - fixture inputs.
 * @param {string} input.home - temporary DSH_HOME.
 * @param {string} input.cwd - the session's recorded working directory.
 * @param {string} input.id - session id.
 * @param {string} [input.origin] - omit for a user conversation (matching reality).
 * @param {number} [input.delegationDepth] - delegation depth, when delegated.
 * @param {string} [input.parentSession] - parent session id, when delegated.
 * @param {number} [input.version] - header format version.
 * @param {number} [input.extraFrames] - number of appended event frames after the header.
 * @param {string} [input.fileName] - override the log file name.
 * @returns {{dir: string, file: string, header: object}} what was written.
 */
export function writeSyntheticSession(input) {
  const version = input.version ?? 4
  const header = {
    type: 'session',
    version,
    id: input.id,
    createdAt: input.createdAt ?? 1_700_000_000_000,
    cwd: input.cwd,
    isSeeded: false,
  }
  if (input.parentSession !== undefined) header.parentSession = input.parentSession
  if (input.origin !== undefined) header.origin = input.origin
  if (input.delegationDepth !== undefined) header.delegationDepth = input.delegationDepth
  if (input.agentPreset !== undefined) header.agentPreset = input.agentPreset

  const space = projectKey(input.cwd)
  const dir = join(input.home, 'sessions', space, input.id)
  mkdirSync(dir, { recursive: true })

  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))]
  for (let i = 0; i < (input.extraFrames ?? 0); i += 1) {
    frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: i, data: { turn: i } })}\n`, 'utf8')))
  }

  const fileName = input.fileName ?? `session.v${version}.jsonl.zstd`
  const file = join(dir, fileName)
  writeFileSync(file, Buffer.concat(frames))
  return { dir, file, header }
}

/**
 * Write a workspace registry in the shape the host actually uses.
 *
 * @param {object} input - registry inputs.
 * @param {string} input.home - temporary DSH_HOME.
 * @param {Array<{id: string, path: string, title?: string, sessionIds?: string[]}>} input.workspaces
 *   registered workspaces.
 * @param {string[]} [input.archivedSessionIds] - archived ids.
 * @returns {string} the registry file path.
 */
export function writeRegistry(input) {
  const table = {}
  for (const workspace of input.workspaces) {
    table[workspace.id] = {
      path: workspace.path,
      title: workspace.title ?? 'fixture-workspace',
      sessionIds: workspace.sessionIds ?? [],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    }
  }
  const data = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: input.workspaces.map((workspace) => workspace.id),
      archivedSessionIds: input.archivedSessionIds ?? [],
    },
    tables: { workspaces: table },
  }
  const file = join(input.home, 'storages', 'workspace.json')
  writeFileSync(file, JSON.stringify(data), 'utf8')
  return file
}

/**
 * Build a workspace path inside a temp home so tests never reference a real one.
 *
 * @param {string} home - temporary DSH_HOME.
 * @param {string} leaf - final path segment.
 * @returns {string} an absolute fixture path.
 */
export function fixtureWorkspace(home, leaf = 'proj') {
  const path = join(home, 'workspaces', leaf)
  mkdirSync(path, { recursive: true })
  return path
}

/**
 * Deterministic probe stubs so tests never depend on the real machine.
 *
 * @param {{running?: boolean|'unknown', ports?: number[]}} [options] - desired verdict.
 * @returns {{listProcesses: Function, listPorts: Function, now: Function}} probes.
 */
export function stubProbes(options = {}) {
  const running = options.running ?? false
  return {
    listProcesses: () => (running === true ? [{ pid: 4242, name: 'DeepSeek Harness.exe' }] : [{ pid: 1, name: 'explorer.exe' }]),
    listPorts: () => new Set(running === true ? [19387] : []),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  }
}
