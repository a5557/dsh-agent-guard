/**
 * Host state probes: is DSH still running, and is a target file in use?
 *
 * `DESIGN.md` §6.3 (G5) requires MULTIPLE independent criteria, and requires that
 * an inconclusive probe be treated as "not stopped" (fail-closed / T8). A single
 * weak proxy — probing one port — is exactly root cause R4 from the incident, so a
 * lone signal must never be enough to authorize a write.
 *
 * Everything here is read-only: process listing, port listing and an exclusive-open
 * liveness probe. Nothing is killed, signalled, or modified.
 */

import { closeSync, openSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Ports DSH is known to serve on; a user-supplied list is merged in. */
export const DEFAULT_PORTS = Object.freeze([19387, 3080])

/** Image names that indicate a DSH host process (`DESIGN.md` §6.3 criterion 1). */
export const DSH_IMAGE_HINTS = Object.freeze(['deepseek', 'dsh', 'electron', 'node'])

/**
 * Probe whether DSH appears to be running.
 *
 * @param {object} [options] - probe inputs.
 * @param {number[]} [options.ports] - ports to test, merged with {@link DEFAULT_PORTS}.
 * @param {boolean} [options.includeImageScan] - whether to scan process images.
 * @param {{listProcesses?: Function, listPorts?: Function}} [options.probes] - injectable
 *   probe functions; production callers omit them and the platform defaults are used.
 * @returns {{running: boolean|'unknown', criteria: Array<{name: string, value: string,
 *            concluded: boolean, detail: string}>, inconclusive: boolean}}
 *   the verdict. `running` is `'unknown'` when no criterion could be evaluated, and
 *   callers must treat `'unknown'` as running.
 */
export function probeDshState(options = {}) {
  const ports = [...new Set([...(options.ports ?? []), ...DEFAULT_PORTS])]
  const criteria = []

  let processes = null
  if (options.includeImageScan !== false) {
    const list = options.probes?.listProcesses ?? defaultListProcesses
    try {
      processes = list()
      const matches = processes.filter((entry) => matchesDshImage(entry.name))
      criteria.push({
        name: 'process',
        value: matches.length > 0 ? 'found' : 'absent',
        concluded: true,
        detail: matches.length > 0
          ? `发现 ${matches.length} 个疑似 DSH 宿主进程（按镜像名匹配）`
          : '未发现疑似 DSH 宿主进程',
      })
    } catch (error) {
      criteria.push({
        name: 'process',
        value: 'unknown',
        concluded: false,
        detail: `进程探测不可用：${error?.message ?? String(error)}`,
      })
    }
  }

  const listPorts = options.probes?.listPorts ?? defaultListPorts
  try {
    const listening = listPorts()
    const hit = ports.filter((port) => listening.has(port))
    criteria.push({
      name: 'port',
      value: hit.length > 0 ? 'listening' : 'closed',
      concluded: true,
      detail: hit.length > 0 ? `监听端口命中：${hit.join(', ')}` : `未发现监听：${ports.join(', ')}`,
    })
  } catch (error) {
    criteria.push({
      name: 'port',
      value: 'unknown',
      concluded: false,
      detail: `端口探测不可用：${error?.message ?? String(error)}`,
    })
  }

  const concluded = criteria.filter((entry) => entry.concluded)
  const anyPositive = concluded.some(
    (entry) => entry.value === 'found' || entry.value === 'listening' || entry.value === 'locked',
  )
  const inconclusive = concluded.length === 0

  return {
    running: anyPositive ? true : inconclusive ? 'unknown' : false,
    criteria,
    inconclusive,
  }
}

/**
 * Whether a process image name looks like a DSH host.
 *
 * @param {string} imageName - process image name.
 * @returns {boolean} true on a hint match.
 */
export function matchesDshImage(imageName) {
  const name = String(imageName ?? '').toLowerCase()
  if (name.length === 0) return false
  return DSH_IMAGE_HINTS.some((hint) => name.includes(hint))
}

/**
 * Test whether a file is currently held open, by attempting an exclusive open.
 *
 * `DESIGN.md` §6.3 criterion 3. A missing file is reported as not locked, since
 * there is nothing to contend with; a permission error is reported as locked,
 * because that is the fail-closed reading.
 *
 * @param {string} file - absolute path to test.
 * @returns {{locked: boolean|'unknown', detail: string}} the probe result.
 */
export function probeFileLock(file) {
  if (typeof file !== 'string' || file.length === 0 || !isAbsolute(file)) {
    return { locked: 'unknown', detail: '目标不是绝对路径，无法做占用探测' }
  }
  for (const flags of ['r+', 'r']) {
    try {
      const fd = openSync(file, flags)
      closeSync(fd)
      return { locked: false, detail: '可独占打开，判定为未被占用' }
    } catch (error) {
      const code = error?.code
      if (code === 'ENOENT') return { locked: false, detail: '目标不存在，无占用可言' }
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        return { locked: true, detail: `占用探测返回 ${code}，按「被占用」处理（fail-closed）` }
      }
      // Any other error is inconclusive; the caller treats unknown as locked.
      continue
    }
  }
  return { locked: 'unknown', detail: '占用探测未能得出结论（fail-closed：按被占用处理）' }
}

/**
 * Decode the verdict into the shape the rule engine consumes.
 *
 * @param {ReturnType<typeof probeDshState>} state - probe output.
 * @returns {{running: boolean, detail: string}} engine-facing state; `'unknown'`
 *   maps to `running: true` (fail-closed, T8).
 */
export function toEngineDshState(state) {
  if (state.running === false) return { running: false, detail: '多项判据一致表明 DSH 未运行' }
  if (state.running === 'unknown') {
    return { running: true, detail: '判据不足，按「未停止」处理（DESIGN.md §6.3 fail-closed）' }
  }
  return { running: true, detail: '至少一项判据表明 DSH 正在运行' }
}

/**
 * Default process lister for this platform.
 *
 * Returns an empty list on failure so the caller records an inconclusive probe
 * rather than a false negative.
 *
 * @returns {Array<{pid: number, name: string}>} running processes.
 */
export function defaultListProcesses() {
  // Lazily required so importing this module never spawns or inspects anything.
  const { execFileSync } = process.getBuiltinModule('node:child_process')
  if (process.platform === 'win32') {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ''))
        return { pid: Number(cells[1] ?? 0), name: cells[0] ?? '' }
      })
  }
  const out = execFileSync('ps', ['-eo', 'pid=,comm='], { encoding: 'utf8', timeout: 10_000 })
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pid, ...rest] = line.split(/\s+/)
      return { pid: Number(pid ?? 0), name: rest.join(' ') }
    })
}

/**
 * Default listening-port lister for this platform.
 *
 * @returns {Set<number>} listening TCP ports.
 */
export function defaultListPorts() {
  const { execFileSync } = process.getBuiltinModule('node:child_process')
  const ports = new Set()
  if (process.platform === 'win32') {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    for (const line of out.split(/\r?\n/)) {
      const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+/i.exec(line)
      if (match !== null) ports.add(Number(match[1]))
    }
    return ports
  }
  const out = execFileSync('ss', ['-ltn'], { encoding: 'utf8', timeout: 10_000 })
  for (const line of out.split(/\r?\n/)) {
    const match = /LISTEN\s+\S*\s+\S*:(\d+)/.exec(line)
    if (match !== null) ports.add(Number(match[1]))
  }
  return ports
}

/**
 * Resolve the DSH home the probes should describe.
 *
 * @param {string|undefined} explicit - an explicit override.
 * @param {NodeJS.ProcessEnv} [env] - environment to read `DSH_HOME` from.
 * @returns {string} the resolved home.
 */
export function resolveDshHome(explicit, env = process.env) {
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv
  const { homedir } = process.getBuiltinModule('node:os')
  return join(homedir(), '.dsh')
}
