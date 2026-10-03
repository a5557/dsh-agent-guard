/**
 * 配置层。
 *
 * 设计文档 §10.1 要求「必须能一键停用」，所以 `enabled` 是配置里的第一开关，并且
 * `apply()` 里还有一道更硬的开关（见 `lib/index.js` 的 `disabled` 处理）。
 *
 * ## 为什么解析与校验是手写的
 *
 * 零运行时依赖是 §11 的承诺之一。官方插件用 `@deepseek-ai/schemastery`（由安装锚点提供，
 * 不是本包依赖），所以这里在可用时导出官方形态的 `Config`（让设置页能发现并可编辑），
 * 同时保留一套**不依赖任何东西**的纯函数解析器：它保证插件在没有该包的环境里也能
 * 正确读到配置，并且让配置逻辑可以无依赖单测。
 *
 * ## 影响预算（§6.4）
 *
 * `goalClass` 只允许四类；升级到 `maintenance` 必须来自配置（也就是用户改的），
 * **agent 在运行期无法把自己升级**——这是规则引擎的硬约束，不是这里的。
 */

/** 影响预算的四个类别（§6.4）。 */
export const GOAL_CLASSES = Object.freeze(['display', 'workspace-content', 'tooling', 'maintenance'])

/** 默认配置。每一项都能被用户覆盖。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 总开关：false 时插件不拦截任何调用（一键停用）。 */
  enabled: true,
  /** 是否对受保护写入做写前备份。关掉它会让受保护写入被拒绝（而不是无备份放行）。 */
  backupEnabled: true,
  /** 是否写 journal.jsonl。 */
  journalEnabled: true,
  /** 是否每轮生成回滚点。 */
  snapshotEnabled: true,
  /** 两次自动快照的最小间隔（毫秒），用于高频回合去抖。 */
  snapshotMinIntervalMs: 60_000,
  /** 快照保留策略（§8）。 */
  keepRecent: 30,
  keepHourly: 24,
  keepDaily: 14,
  /** 单文件备份上限。超限即拒绝写入（fail-closed）。 */
  maxBackupBytes: 8 * 1024 * 1024,
  /** 本会话的影响预算类别。只有用户改配置才能升级到 maintenance。 */
  goalClass: 'workspace-content',
  /** 熔断阈值：同一路径连续写多少次后进入熔断观察。 */
  circuitThreshold: 2,
  /** 插件数据目录覆盖（默认 $DSH_HOME/agent-guard/）。 */
  dir: null,
})

/**
 * 把任意输入规范化成一份完整、可用的配置。
 *
 * 非法值一律回落到默认值，并在 `warnings` 里说明——配置错误导致护栏静默失效，
 * 比护栏拒绝工作更危险，所以这里从不抛错，只报告。
 *
 * @param {unknown} input - 用户配置（可能来自 profile 的 cordis.patch.yml）。
 * @returns {{config: object, warnings: string[]}} 规范化结果。
 */
export function resolveConfig(input) {
  const warnings = []
  const raw = input !== null && typeof input === 'object' ? input : {}
  const config = { ...DEFAULT_CONFIG }

  const bool = (key) => {
    if (raw[key] === undefined) return
    if (typeof raw[key] !== 'boolean') {
      warnings.push(`配置项 ${key} 期望布尔值，收到 ${typeof raw[key]}，已回落默认值 ${DEFAULT_CONFIG[key]}`)
      return
    }
    config[key] = raw[key]
  }

  const positiveInt = (key, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
    if (raw[key] === undefined) return
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      warnings.push(`配置项 ${key} 期望 ${min}-${max} 的整数，收到 ${JSON.stringify(value)}，已回落默认值 ${DEFAULT_CONFIG[key]}`)
      return
    }
    config[key] = value
  }

  for (const key of ['enabled', 'backupEnabled', 'journalEnabled', 'snapshotEnabled']) {
    bool(key)
  }
  positiveInt('snapshotMinIntervalMs', { min: 0 })
  positiveInt('keepRecent')
  positiveInt('keepHourly')
  positiveInt('keepDaily')
  positiveInt('maxBackupBytes', { min: 1024 })
  positiveInt('circuitThreshold', { min: 1 })

  if (raw.goalClass !== undefined) {
    if (!GOAL_CLASSES.includes(raw.goalClass)) {
      warnings.push(`配置项 goalClass 必须是 ${GOAL_CLASSES.join(' / ')} 之一，收到 ${JSON.stringify(raw.goalClass)}，已回落默认值 ${DEFAULT_CONFIG.goalClass}`)
    } else {
      config.goalClass = raw.goalClass
    }
  }

  if (raw.dir !== undefined && raw.dir !== null) {
    if (typeof raw.dir !== 'string' || raw.dir.trim().length === 0) {
      warnings.push('配置项 dir 期望非空字符串，已回落默认位置 $DSH_HOME/agent-guard/')
    } else {
      config.dir = raw.dir
    }
  }

  return { config, warnings }
}

/**
 * 尝试获取官方的 schemastery，用于把 Config 声明成官方形态。
 *
 * 为什么需要多个解析锚点（实测）：`@deepseek-ai/schemastery` 是由安装锚点提供的
 * peer（DSH 自己带着它），不是会被单独装进 profile 的普通依赖。所以从本插件自身的
 * 位置 require 它会 MODULE_NOT_FOUND，必须再试 DSH 自己的安装位置。
 *
 * 拿不到就返回 null：这是降级，不是错误——配置解析本身不依赖它，
 * 只是设置页会少一份可编辑的 schema。
 *
 * @returns {object|null} schemastery 的 z，或 null。
 */
export function loadSchemastery() {
  const { createRequire } = process.getBuiltinModule('node:module')
  const anchors = [import.meta.url]

  const runtimeRoot = process.env.DSH_RUNTIME_ROOT
  if (typeof runtimeRoot === 'string' && runtimeRoot.length > 0) {
    anchors.push(`${runtimeRoot.replace(/[\\/]+$/, '')}/package.json`)
  }

  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData.length > 0) {
    anchors.push(`${appData}/npm/node_modules/@deepseek-ai/dsh/package.json`)
    anchors.push(`${appData}/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery/package.json`)
  }

  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      const loaded = require('@deepseek-ai/schemastery')
      const z = loaded?.default ?? loaded
      if (typeof z?.object === 'function') return z
    } catch {
      // 换下一个锚点。
    }
  }
  return null
}

/**
 * 构建官方形态的 Config（若 schemastery 可用）。
 *
 * 默认值必须与 DEFAULT_CONFIG 一致，否则「设置页显示的默认值」与「插件实际生效的
 * 默认值」会分歧——那比没有 schema 更糟。
 *
 * @returns {object|null} schemastery schema，或 null。
 */
export function buildConfigSchema() {
  const z = loadSchemastery()
  if (z === null || typeof z.object !== 'function') return null
  try {
    return z.object({
      enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
      backupEnabled: z.boolean().default(DEFAULT_CONFIG.backupEnabled),
      journalEnabled: z.boolean().default(DEFAULT_CONFIG.journalEnabled),
      snapshotEnabled: z.boolean().default(DEFAULT_CONFIG.snapshotEnabled),
      // 用 number().min(0) 而不是 natural()：后者要求正数，会把合法的 0（关闭去抖）判为非法。
      snapshotMinIntervalMs: z.number().min(0).default(DEFAULT_CONFIG.snapshotMinIntervalMs),
      keepRecent: z.number().min(0).default(DEFAULT_CONFIG.keepRecent),
      keepHourly: z.number().min(0).default(DEFAULT_CONFIG.keepHourly),
      keepDaily: z.number().min(0).default(DEFAULT_CONFIG.keepDaily),
      maxBackupBytes: z.number().min(1024).default(DEFAULT_CONFIG.maxBackupBytes),
      goalClass: z.union(GOAL_CLASSES).default(DEFAULT_CONFIG.goalClass),
      circuitThreshold: z.number().min(1).default(DEFAULT_CONFIG.circuitThreshold),
      dir: z.string().default(''),
    })
  } catch {
    // schema 构造失败不应阻止插件加载：解析器仍然工作。
    return null
  }
}

/**
 * 加载器可读的 Config 声明。
 *
 * 官方插件导出 `Config` 后，`dsh --dump-config-schema` 才能发现该插件的配置，
 * 设置页也才能把它渲染成可编辑表单。拿不到 schemastery 时为 `null`，
 * 此时加载器会把它当作「无配置 schema」——插件照常工作，只是设置页少了表单。
 */
export const Config = buildConfigSchema()
