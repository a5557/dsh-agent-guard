/**
 * 备份与回滚点（P3，`DESIGN.md` §8）。
 *
 * 两条不可动摇的约束：
 * 1. **只读采集，不移动原文件**：备份是「复制到自己的目录」，绝不碰原路径；
 * 2. **只提供人工回滚说明，不提供自动回滚命令**。自动回滚本身就会是一个"一键改数据"
 *    的功能——那正是事故的形态（附录 A）。
 *
 * 性能约束（来自实测，见 VERIFY.md 附录 A）：`tools/pre-execute` 没有超时，且运行在
 * 单一有序通道里，所以**写前备份的预算必须很小**。任何超预算的目标一律**拒绝写入**
 * （fail-closed），而不是「先放行、事后补备份」。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { readLayout } from './sessionlog.js'

/** 单文件备份上限：8 MiB。超过即拒绝写入，而不是无备份放行。 */
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024

/** 注册表副本上限：32 MiB（正常只有几 KiB，这里只防病态情况撑爆快照）。 */
export const MAX_REGISTRY_BYTES = 32 * 1024 * 1024

/**
 * 时间戳目录名：`20261001-214221`。本地时间，便于人直接对照。
 *
 * @param {Date} [date] - 时间。
 * @returns {string} 目录名。
 */
export function stamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 计算文件哈希（流式不必要，这里都是小文件）。
 *
 * @param {string} file - 文件路径。
 * @returns {string|null} 十六进制摘要，读不到时为 null。
 */
export function fileHash(file) {
  try {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/**
 * 写前备份一个受保护文件。
 *
 * 目标不存在时不算失败：新建文件本来就没有可备份的内容，这会在结果里如实标注。
 *
 * @param {object} input - 备份输入。
 * @param {import('./store.js').GuardStore} input.store - 插件存储。
 * @param {string} input.target - 即将被写入的绝对路径。
 * @param {string} [input.reason] - 触发原因，写入 meta。
 * @param {number} [input.maxBytes] - 大小上限。
 * @param {object} [input.io] - 可注入的文件系统（测试用）。
 * @returns {{ok: boolean, kind: 'copied'|'absent'|'too-large'|'failed'|'memory-only',
 *            path: string|null, digest: string|null, bytes: number, error: string|null}}
 */
export function backupFileBeforeWrite(input) {
  const { store, target } = input
  const maxBytes = Number(input.maxBytes ?? MAX_BACKUP_BYTES)
  const mkdir = input.io?.mkdir ?? ((path) => mkdirSync(path, { recursive: true }))
  const copy = input.io?.copyFile ?? ((from, to) => copyFileSync(from, to))
  const exists = input.io?.exists ?? ((path) => existsSync(path))
  const stat = input.io?.stat ?? ((path) => statSync(path))

  if (!store.durable) {
    return { ok: false, kind: 'memory-only', path: null, digest: null, bytes: 0, error: 'memory-only-mode' }
  }

  if (!exists(target)) {
    // 新建文件没有旧内容可回滚；这是事实，不是失败。
    return { ok: true, kind: 'absent', path: null, digest: null, bytes: 0, error: null }
  }

  let size
  try {
    size = stat(target).size
  } catch (error) {
    return { ok: false, kind: 'failed', path: null, digest: null, bytes: 0, error: `${error?.code ?? 'error'}: ${error?.message ?? String(error)}` }
  }

  if (size > maxBytes) {
    // 超预算：调用方必须据此拒绝写入，绝不无备份放行。
    return {
      ok: false,
      kind: 'too-large',
      path: null,
      digest: null,
      bytes: size,
      error: `目标 ${size} 字节，超过备份上限 ${maxBytes} 字节`,
    }
  }

  const dir = store.path('backups', stamp())
  const digest = fileHash(target)
  // 用哈希前缀做文件名，避免把真实文件名（可能含个人信息）写进我们自己的目录结构里。
  const name = `${(digest ?? 'nohash').slice(0, 16)}.bak`
  const destination = join(dir, name)

  try {
    mkdir(dir)
    copy(target, destination)
    writeFileSync(join(dir, `${name}.meta.json`), JSON.stringify({
      reason: input.reason ?? 'protected-write',
      targetLength: target.length,
      // 目标路径本身可能含个人信息，这里只记录哈希，人工排查时以报告里的 target 为准。
      targetDigest: createHash('sha256').update(target, 'utf8').digest('hex').slice(0, 16),
      bytes: size,
      digest,
      at: new Date().toISOString(),
    }, null, 2))
    return { ok: true, kind: 'copied', path: destination, digest, bytes: size, error: null }
  } catch (error) {
    return {
      ok: false,
      kind: 'failed',
      path: null,
      digest: null,
      bytes: size,
      error: `${error?.code ?? 'error'}: ${error?.message ?? String(error)}`,
    }
  }
}

/**
 * 生成一个回合回滚点（P3）。
 *
 * 内容见 §8：`meta.json` + 注册表副本 + 目录布局清单 + `hashes.sha256`。
 * 只读采集：注册表是**复制**，布局是**清点**，任何原文件都不被移动或修改。
 *
 * @param {object} input - 快照输入。
 * @param {import('./store.js').GuardStore} input.store - 插件存储。
 * @param {string} input.dshHome - DSH 数据目录。
 * @param {string} input.reason - 触发原因（turn-start / pre-write / manual）。
 * @param {object} [input.context] - 附加元信息（会话 id、版本等）。
 * @param {boolean} [input.includeLayout] - 是否清点目录布局（默认是）。
 * @param {object} [input.io] - 可注入文件系统。
 * @returns {{ok: boolean, id: string|null, dir: string|null, bytes: number, error: string|null}}
 */
export function createSnapshot(input) {
  const { store, dshHome, reason } = input
  const mkdir = input.io?.mkdir ?? ((path) => mkdirSync(path, { recursive: true }))
  const exists = input.io?.exists ?? ((path) => existsSync(path))

  if (!store.durable) {
    return { ok: false, id: null, dir: null, bytes: 0, error: 'memory-only-mode' }
  }

  const id = stamp()
  const dir = store.path('snapshots', id)
  const files = {}

  try {
    mkdir(dir)

    // 1) 注册表副本（若存在）
    const registrySource = join(dshHome, 'storages', 'workspace.json')
    if (exists(registrySource)) {
      const size = (input.io?.stat ?? statSync)(registrySource).size
      if (size <= MAX_REGISTRY_BYTES) {
        const destination = join(dir, 'workspace.json')
        ;(input.io?.copyFile ?? copyFileSync)(registrySource, destination)
        files['workspace.json'] = { digest: fileHash(destination), bytes: size }
      } else {
        files['workspace.json'] = { skipped: 'too-large', bytes: size }
      }
    } else {
      files['workspace.json'] = { skipped: 'absent' }
    }

    // 2) 目录布局清单：只清点，不解压（每轮快照要便宜）
    let layoutBytes = 0
    if (input.includeLayout !== false) {
      const layout = readLayout(join(dshHome, 'sessions'))
      const compact = layout.map((space) => ({
        space: space.space,
        sessions: space.entries.length,
        bytes: space.entries.reduce((sum, entry) => sum + entry.bytes, 0),
        latestMtimeMs: space.entries.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0),
      }))
      const layoutFile = join(dir, 'layout.json')
      const content = JSON.stringify({ generatedAt: new Date().toISOString(), spaces: compact }, null, 2)
      writeFileSync(layoutFile, content)
      layoutBytes = Buffer.byteLength(content)
      files['layout.json'] = { digest: fileHash(layoutFile), bytes: layoutBytes }
    }

    // 3) meta
    const meta = {
      id,
      reason,
      at: new Date().toISOString(),
      sessionId: input.context?.sessionId ?? null,
      dshVersion: input.context?.dshVersion ?? null,
      guardVersion: input.context?.guardVersion ?? null,
      note: '本快照由 dsh-agent-guard 只读采集生成；不提供自动回滚命令，回滚方式见 README 的「人工回滚」一节。',
    }
    const metaFile = join(dir, 'meta.json')
    writeFileSync(metaFile, JSON.stringify(meta, null, 2))
    const metaBytes = Buffer.byteLength(JSON.stringify(meta, null, 2))

    // 4) hashes.sha256：覆盖上面所有产物
    const lines = []
    for (const [name, info] of Object.entries(files)) {
      if (info.digest !== undefined) lines.push(`${info.digest}  ${name}`)
    }
    lines.push(`${fileHash(metaFile)}  meta.json`)
    writeFileSync(join(dir, 'hashes.sha256'), `${lines.join('\n')}\n`)

    const total = metaBytes + layoutBytes + (files['workspace.json']?.bytes ?? 0)
    return { ok: true, id, dir, bytes: total, error: null }
  } catch (error) {
    return { ok: false, id, dir, bytes: 0, error: `${error?.code ?? 'error'}: ${error?.message ?? String(error)}` }
  }
}

/**
 * 按保留策略清理**本插件自己的**快照目录。
 *
 * §8：默认保留最近 30 份 + 每小时 1 份（24 小时）+ 每天 1 份（14 天）。
 * 只删 `snapshots/` 下、名字符合本插件时间戳格式的目录；任何不认识的名字一律保留。
 *
 * @param {object} input - 清理输入。
 * @param {import('./store.js').GuardStore} input.store - 插件存储。
 * @param {number} [input.keepRecent] - 保留最近份数。
 * @param {number} [input.keepHourly] - 每小时保留份数（近 24 小时）。
 * @param {number} [input.keepDaily] - 每天保留份数（近 14 天）。
 * @param {Date} [input.now] - 参照时间。
 * @param {boolean} [input.dryRun] - 只计算不删除。
 * @param {object} [input.io] - 可注入文件系统。
 * @returns {{kept: string[], removed: string[], unknown: string[], error: string|null}}
 */
export function pruneSnapshots(input) {
  const { store } = input
  const keepRecent = Number(input.keepRecent ?? 30)
  const keepHourly = Number(input.keepHourly ?? 24)
  const keepDaily = Number(input.keepDaily ?? 14)
  const now = input.now ?? new Date()
  const readdir = input.io?.readdir ?? ((path) => readdirSync(path))
  const remove = input.io?.rm ?? ((path) => rmSync(path, { recursive: true, force: true }))

  const root = store.path('snapshots')
  if (root === null) return { kept: [], removed: [], unknown: [], error: 'memory-only-mode' }

  let names
  try {
    names = readdir(root)
  } catch {
    return { kept: [], removed: [], unknown: [], error: null }
  }

  // 只认自己的时间戳目录，其余（用户手工放的、别的工具的）一律不碰。
  const mine = []
  const unknown = []
  for (const name of names) {
    const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name)
    if (match === null) {
      unknown.push(name)
      continue
    }
    const at = new Date(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]), Number(match[6]),
    )
    mine.push({ name, at, ageMs: now.getTime() - at.getTime() })
  }
  mine.sort((a, b) => b.at.getTime() - a.at.getTime())

  const keep = new Set()
  for (const entry of mine.slice(0, keepRecent)) keep.add(entry.name)

  const hourKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`
  const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`

  const seenHours = new Set()
  const seenDays = new Set()
  let hourlyKept = 0
  let dailyKept = 0
  for (const entry of mine) {
    if (entry.ageMs <= 24 * 3600_000 && hourlyKept < keepHourly) {
      const key = hourKey(entry.at)
      if (!seenHours.has(key)) {
        seenHours.add(key)
        keep.add(entry.name)
        hourlyKept += 1
      }
    }
  }
  for (const entry of mine) {
    if (entry.ageMs <= 14 * 24 * 3600_000 && dailyKept < keepDaily) {
      const key = dayKey(entry.at)
      if (!seenDays.has(key)) {
        seenDays.add(key)
        keep.add(entry.name)
        dailyKept += 1
      }
    }
  }

  const removed = []
  const kept = []
  for (const entry of mine) {
    if (keep.has(entry.name)) {
      kept.push(entry.name)
      continue
    }
    if (input.dryRun === true) {
      removed.push(entry.name)
      continue
    }
    try {
      remove(join(root, entry.name))
      removed.push(entry.name)
    } catch {
      // 删不掉就留着：清理失败绝不影响护栏本身。
      kept.push(entry.name)
    }
  }

  return { kept, removed, unknown, error: null }
}

/**
 * 列出已有快照，供面板与人工回滚说明使用。
 *
 * @param {import('./store.js').GuardStore} store - 插件存储。
 * @returns {Array<{id: string, dir: string, bytes: number}>} 快照列表（新到旧）。
 */
export function listSnapshots(store) {
  const root = store.path('snapshots')
  if (root === null) return []
  let names
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names
    .filter((name) => /^\d{8}-\d{6}$/.test(name))
    .sort()
    .reverse()
    .map((name) => {
      const dir = join(root, name)
      let bytes = 0
      try {
        for (const file of readdirSync(dir)) {
          try {
            bytes += statSync(join(dir, file)).size
          } catch {
            // 单个文件读不到不影响列表。
          }
        }
      } catch {
        // 目录不可读就按 0 计。
      }
      return { id: name, dir, bytes }
    })
}

/**
 * 生成**人工**回滚说明（§8：不提供自动回滚命令）。
 *
 * @param {object} input - 输入。
 * @param {import('./store.js').GuardStore} input.store - 插件存储。
 * @param {string} input.id - 快照 id。
 * @param {string} input.dshHome - DSH 数据目录。
 * @returns {{ok: boolean, text: string}} 说明文本。
 */
export function rollbackInstructions(input) {
  const { store, id, dshHome } = input
  const dir = store.path('snapshots', id)
  if (dir === null || !existsSync(dir)) {
    return { ok: false, text: `找不到快照 ${id}：请先运行 list 确认可用快照。` }
  }
  return {
    ok: true,
    text: [
      `人工回滚说明（快照 ${id}）`,
      '',
      `快照目录：${dir}`,
      '',
      '1. 先停止 DSH：确认进程已退出（不要只看端口）。',
      '2. 再自己复制一份当前状态（例如把 storages/workspace.json 另存为 .bak），不要把回滚建立在没有退路的状态上。',
      `3. 用快照里的 workspace.json 覆盖 ${join(dshHome, 'storages', 'workspace.json')}。`,
      '4. 逐项核对快照里的 layout.json 与磁盘现状是否一致（会话目录数、mtime）。',
      '5. 启动 DSH，确认工作区分组与预期一致；若出现新症状，先怀疑这次回滚本身。',
      '',
      '注意：本插件**不提供自动回滚命令**——自动改写应用私有存储正是历史事故的形态。',
      '回滚是人工动作，且每一步都应保留退路。',
    ].join('\n'),
  }
}
