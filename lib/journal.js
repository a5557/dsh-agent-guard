/**
 * 追加式日志（journal.jsonl）——事故复盘的依据。
 *
 * 设计文档 §5 的硬性要求：
 * - 只追加、不覆盖；
 * - 写入失败要重试，然后降级为内存队列 + UI 告警，**不能静默丢弃**；
 * - 独立于会话存储（写在插件自己的目录里）。
 *
 * §10.2 还要求「另存一份哈希链」，使删改可被发现。这里用最朴素也最可核查的做法：
 * 每条记录都带 `prevHash`，并对「前一条哈希 + 本条内容」求 SHA-256。任何一条被改写
 * 或抽掉，后续哈希就对不上。插件不开采任何密钥，也不做签名——它只保证**可发现**，
 * 不假装能阻止有权限的人改写整条链（那需要带外基线，见附录 B 与 dsh-protect 的分工）。
 *
 * 隐私（§19.7 / §10.3）：这里只记录动作与分类结果，**不记录命令原文、不记录消息正文、
 * 不记录凭据**。可选的 `commandDigest` 是命令文本的哈希前缀，用于「是不是同一条命令」的
 * 比对，无法反推原文。
 */

import { createHash } from 'node:crypto'

/** 日志格式版本，写入每条记录以便未来演进。 */
export const JOURNAL_VERSION = 1

/** 日志文件名（相对插件数据目录）。 */
export const JOURNAL_FILE = 'journal.jsonl'

/** 哈希链的创世值。 */
const GENESIS = 'genesis'

/**
 * 计算一条记录的哈希。
 *
 * 覆盖「前一条哈希 + 本条规范 JSON」，因此改写任意字段都会破坏链。
 *
 * @param {string} prevHash - 上一条记录的哈希。
 * @param {object} record - 本条记录（不含 hash 字段）。
 * @returns {string} 十六进制摘要。
 */
export function hashRecord(prevHash, record) {
  const material = `${prevHash}\n${canonical(record)}`
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

/**
 * 稳定序列化：键按字典序排列，保证同样内容得到同样哈希。
 *
 * @param {unknown} value - 任意可 JSON 化的值。
 * @returns {string} 规范 JSON 文本。
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
  return `{${entries.join(',')}}`
}

/**
 * 从已有日志文本中恢复链的状态。
 *
 * 无法解析的尾部行（例如上一次写入被中断）**不参与**链，但会被计数并在
 * {@link Journal.describe} 中报告——静默跳过会让"日志被截断"看起来像"日志正常"。
 *
 * @param {string|null} text - 日志文件内容。
 * @returns {{seq: number, hash: string, records: number, unparsable: number, brokenAt: number|null}}
 *   恢复出的链状态。
 */
export function recoverChain(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { seq: 0, hash: GENESIS, records: 0, unparsable: 0, brokenAt: null }
  }

  let prevHash = GENESIS
  let seq = 0
  let records = 0
  let unparsable = 0
  let brokenAt = null

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      unparsable += 1
      continue
    }
    if (brokenAt === null && parsed.prevHash !== prevHash) {
      brokenAt = records + 1
    }
    prevHash = typeof parsed.hash === 'string' ? parsed.hash : prevHash
    seq = Number(parsed.seq ?? seq)
    records += 1
  }

  return { seq, hash: prevHash, records, unparsable, brokenAt }
}

/**
 * 校验整条哈希链。
 *
 * @param {string|null} text - 日志文件内容。
 * @returns {{ok: boolean, records: number, unparsable: number, firstMismatchAt: number|null,
 *            detail: string}} 校验结论。`ok:false` 表示**可发现**的篡改或损坏。
 */
export function verifyChain(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: true, records: 0, unparsable: 0, firstMismatchAt: null, detail: '日志为空，无可校验内容' }
  }

  let prevHash = GENESIS
  let records = 0
  let unparsable = 0
  let firstMismatchAt = null

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      unparsable += 1
      continue
    }
    records += 1
    const { hash, ...rest } = parsed
    const expected = hashRecord(prevHash, rest)
    if (firstMismatchAt === null && expected !== hash) firstMismatchAt = records
    prevHash = typeof hash === 'string' ? hash : prevHash
  }

  const ok = firstMismatchAt === null && unparsable === 0
  const detail = ok
    ? `哈希链完整（${records} 条）`
    : firstMismatchAt !== null
      ? `哈希链在第 ${firstMismatchAt} 条断开：该条之后的记录不可信，说明日志被改写或损坏`
      : `有 ${unparsable} 行无法解析（日志可能被截断或损坏）`

  return { ok, records, unparsable, firstMismatchAt, detail }
}

/**
 * 日志写入器。
 *
 * 每次追加都走 store 的重试 + 队列降级路径；`reserve`/`finalize` 两步式写入让
 * 「熔断需要知道上一次写完之后校验摘要是否变化」得以实现：先落一条 `pending`，
 * 动作结束后再补一条 `settled` 并带上前后摘要。
 */
export class Journal {
  /**
   * @param {object} options - 构造输入。
   * @param {import('./store.js').GuardStore} options.store - 存储句柄。
   * @param {boolean} [options.enabled] - 是否启用记录。
   */
  constructor(options) {
    this.store = options.store
    this.enabled = options.enabled !== false
    const recovered = recoverChain(this.store.readFile(JOURNAL_FILE))
    this.seq = recovered.seq
    this.prevHash = recovered.hash
    this.records = recovered.records
    this.unparsable = recovered.unparsable
    this.chainBrokenAt = recovered.brokenAt
    this.appendFailures = 0
  }

  /**
   * 追加一条记录。
   *
   * @param {object} record - 记录内容（`seq`/`prevHash`/`hash`/`version` 由这里补）。
   * @returns {{ok: boolean, queued: boolean, seq: number, hash: string, error: string|null}}
   *   写入结果；`queued` 表示进了内存队列。
   */
  append(record) {
    if (!this.enabled) return { ok: true, queued: false, seq: this.seq, hash: this.prevHash, error: null }

    const seq = this.seq + 1
    const body = { version: JOURNAL_VERSION, seq, ...record, prevHash: this.prevHash }
    const hash = hashRecord(this.prevHash, body)
    const line = JSON.stringify({ ...body, hash })

    const result = this.store.appendLine(JOURNAL_FILE, line)
    if (!result.ok) this.appendFailures += 1

    // 即使只是进了队列，也推进链状态：哈希链描述的是"逻辑上已记录"的顺序。
    this.seq = seq
    this.prevHash = hash
    this.records += 1

    return { ok: result.ok, queued: result.queued, seq, hash, error: result.error }
  }

  /**
   * 追加一条「动作已开始」的记录，返回可交给 {@link settle} 的凭据。
   *
   * @param {object} record - 记录内容。
   * @returns {{seq: number, hash: string, startedAt: number}} 凭据。
   */
  reserve(record) {
    const appended = this.append({ phase: 'pending', ...record })
    return { seq: appended.seq, hash: appended.hash, startedAt: Date.now() }
  }

  /**
   * 为一次已 `reserve` 的动作补一条结算记录。
   *
   * @param {{seq: number}} reserved - {@link reserve} 的返回值。
   * @param {object} record - 结算内容（结果、决定、备份位置等）。
   * @returns {{ok: boolean, seq: number}} 写入结果。
   */
  settle(reserved, record) {
    const appended = this.append({ phase: 'settled', forSeq: reserved.seq, ...record })
    return { ok: appended.ok, seq: appended.seq }
  }

  /** 校验当前日志文件里的哈希链。 */
  verify() {
    return verifyChain(this.store.readFile(JOURNAL_FILE))
  }

  /** 供面板与取证报告使用的状态摘要。 */
  describe() {
    return {
      enabled: this.enabled,
      file: this.store.path(JOURNAL_FILE),
      records: this.records,
      seq: this.seq,
      unparsable: this.unparsable,
      // 启动时就发现链断开，说明日志在本次会话之前已被改写或损坏。
      chainBrokenAt: this.chainBrokenAt,
      appendFailures: this.appendFailures,
      queued: this.store.queue.length,
      durable: this.store.durable,
      warning: this.store.warning,
    }
  }
}

/**
 * 构建日志写入器。
 *
 * @param {import('./store.js').GuardStore} store - 存储句柄。
 * @param {{enabled?: boolean}} [options] - 选项。
 * @returns {Journal} 日志写入器。
 */
export function createJournal(store, options = {}) {
  return new Journal({ store, enabled: options.enabled })
}

/**
 * 计算命令文本的短摘要（不记录原文）。
 *
 * @param {string} command - 命令原文。
 * @returns {string} 12 位十六进制前缀。
 */
export function commandDigest(command) {
  return createHash('sha256').update(String(command ?? ''), 'utf8').digest('hex').slice(0, 12)
}
