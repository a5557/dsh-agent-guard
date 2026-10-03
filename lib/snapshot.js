/**
 * 回滚点触发（P3，`DESIGN.md` §8）。
 *
 * 触发时机：① 每轮开始；② 任何受保护路径写入前；③ 用户手动。
 *
 * 关于锚点的一个实测修正（VERIFY.md Q2）：设计文档写的是 `turn/start`，但
 * `agent/turn-stopping` 是 **serial** 模式，明确可以在回合关闭前被 await，
 * 因此更适合放"采集 + 落盘"这类需要跑完的工作；`turn/start` 只是 emit，
 * 不会等待监听器。所以这里同时订阅两者，并以 `turn-stopping` 为准，
 * 再用时间门控兜住高频回合，避免快照把回合拖慢。
 *
 * 快照本身的成本已经被刻意压到最低：只清点目录（不解压身份头）+ 复制小注册表，
 * 并带一个最小间隔，保证它便宜到可以每轮跑。
 */

import { createSnapshot, pruneSnapshots, stamp } from './backup.js'

/** 两次自动快照之间的最小间隔（毫秒），用于高频回合去抖。 */
export const DEFAULT_MIN_INTERVAL_MS = 60_000

/**
 * 快照调度器：按最小间隔决定是否真的落盘，并维护保留策略。
 */
export class SnapshotScheduler {
  /**
   * @param {object} options - 构造输入。
   * @param {import('./store.js').GuardStore} options.store - 插件存储。
   * @param {string} options.dshHome - DSH 数据目录。
   * @param {object} options.config - 生效配置。
   * @param {() => number} [options.now] - 时钟（测试用）。
   * @param {string|null} [options.guardVersion] - 自身版本，写进 meta。
   */
  constructor(options) {
    this.store = options.store
    this.dshHome = options.dshHome
    this.config = options.config
    this.now = options.now ?? (() => Date.now())
    this.guardVersion = options.guardVersion ?? null
    this.lastAt = 0
    this.lastResult = null
    this.skipped = 0
    this.errors = 0
    this.turnCounter = 0
  }

  /**
   * 是否应当落一次快照。
   *
   * @param {number} intervalMs - 最小间隔。
   * @returns {boolean} 是否执行。
   */
  shouldRun(intervalMs = this.config.snapshotMinIntervalMs) {
    if (!this.config.snapshotEnabled) return false
    if (!this.store.durable) return false
    return this.now() - this.lastAt >= intervalMs
  }

  /**
   * 执行一次快照（含保留策略清理）。
   *
   * @param {object} [input] - 输入。
   * @param {string} [input.reason] - 触发原因。
   * @param {object} [input.context] - 附加元信息。
   * @param {boolean} [input.force] - 跳过最小间隔检查（手动触发）。
   * @returns {{ok: boolean, skipped: boolean, id: string|null, bytes: number, error: string|null,
   *            pruned: string[]}} 结果。
   */
  run(input = {}) {
    if (input.force !== true && !this.shouldRun()) {
      this.skipped += 1
      return { ok: true, skipped: true, id: null, bytes: 0, error: null, pruned: [] }
    }

    const result = createSnapshot({
      store: this.store,
      dshHome: this.dshHome,
      reason: input.reason ?? 'turn-start',
      context: { guardVersion: this.guardVersion, ...input.context },
    })
    this.lastAt = this.now()
    this.lastResult = result
    if (!result.ok) {
      this.errors += 1
      return { ...result, skipped: false, pruned: [] }
    }

    const pruned = pruneSnapshots({
      store: this.store,
      keepRecent: this.config.keepRecent,
      keepHourly: this.config.keepHourly,
      keepDaily: this.config.keepDaily,
      now: new Date(this.now()),
    })

    return { ...result, skipped: false, pruned: pruned.removed }
  }

  /**
   * 处理一次回合事件。
   *
   * @param {object} payload - 事件载荷。
   * @returns {{ok: boolean, skipped: boolean, id: string|null, bytes: number, error: string|null,
   *            pruned: string[]}} 结果。
   */
  onTurn(payload) {
    this.turnCounter += 1
    return this.run({
      reason: 'turn-start',
      context: { sessionId: payload?.agent?.id ?? null, turn: payload?.turn ?? null },
    })
  }

  /** 供面板使用的状态摘要。 */
  describe() {
    return {
      enabled: this.config.snapshotEnabled,
      minIntervalMs: this.config.snapshotMinIntervalMs,
      lastAt: this.lastAt === 0 ? null : new Date(this.lastAt).toISOString(),
      lastResult: this.lastResult === null ? null : { ok: this.lastResult.ok, id: this.lastResult.id, error: this.lastResult.error },
      skipped: this.skipped,
      errors: this.errors,
      turns: this.turnCounter,
      durable: this.store.durable,
    }
  }
}

/**
 * 取一个当前时间戳 id，供手动快照使用。
 *
 * @param {Date} [date] - 时间。
 * @returns {string} 时间戳。
 */
export function snapshotStamp(date) {
  return stamp(date)
}
