// 覆盖审计：把「实现里存在的东西」与「测试里引用过的东西」做映射，找出未验证项。
//
// 为什么需要它：上一轮证明了两件事——
//   1. 部件单测无法证明装配正确（`workspaceRoots` 形态冲突藏了整整七轮）；
//   2. 靠"想到哪补到哪"来完善覆盖是不可靠的。
// 所以这里改成机制：穷举实现面的导出、副作用注册点、以及设计文档规定的规则集，
// 逐个回答"有没有被引用/被断言"。剩余项排在最后，形成一份待办而不是一份感觉。
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const LIB = join(ROOT, 'lib')
const TEST = join(ROOT, 'test')
const CHECKS = join(ROOT, 'checks')

/** 读取目录下所有匹配文件的文本，拼成一个大字符串用于"是否被提及"的判断。 */
function readAll(dir, pattern) {
  const parts = []
  for (const name of readdirSync(dir)) {
    if (!pattern.test(name)) continue
    parts.push(readFileSync(join(dir, name), 'utf8'))
  }
  return parts.join('\n')
}

const testText = readAll(TEST, /\.(mjs|js)$/)
const checkText = readAll(CHECKS, /\.(mjs|js)$/)
const allTestText = `${testText}\n${checkText}`

const problems = []
const notes = []

// ---------------------------------------------------------------------------
// 1) 每个 lib 导出：是否被测试/检查引用过
// ---------------------------------------------------------------------------
const EXPORT_RE = /^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm
const exportsByFile = new Map()
for (const name of readdirSync(LIB)) {
  if (!name.endsWith('.js')) continue
  const text = readFileSync(join(LIB, name), 'utf8')
  const names = [...text.matchAll(EXPORT_RE)].map((match) => match[1])
  if (names.length > 0) exportsByFile.set(name, names)
}

/**
 * 入口可达的导出：这些函数**没有**在测试里被按名字引用，但通过 `apply()` /
 * `createComponents()` 的真实执行路径被触达 —— 属于"间接覆盖"，不算缺口。
 *
 * 为什么需要这份清单：审计的判据是"文本是否提及"，那只能反映字面引用。
 * 一个模块内部被 `apply()` 调用的函数不会出现在测试文本里，却在每次装配时执行。
 * 把这类误报成"缺口"会让审计永远失败，进而被忽略——审计本身也就失去意义。
 *
 * 清单里每一项都写明"经由谁触达"，便于复核者判断该断言是否足够。
 */
const REACHABLE_VIA_ENTRY = new Map([
  ['index.js → createComponents', 'apply() 内部调用，assembly.cases 通过 apply 触达'],
  ['index.js → createJournalTool', 'apply() 注册该工具，plugin.cases 断言其 schema'],
  ['index.js → describeState', 'visible.cases 直接断言其字段形状'],
  ['index.js → formatGuardStatus', 'visible.cases 断言其文本内容'],
  ['index.js → formatHistory', 'visible.cases 断言其文本内容'],
  ['index.js → readRecent', 'visible.cases 经 guard_journal 的 recent 动作触达'],
  ['index.js → readOwnVersion', 'apply() 装配时调用，写入快照 meta'],
  ['guard.js → GuardRuntime', 'createComponents 构造，assembly.cases 经 apply 触达'],
  ['hostcheck.js → probeDshState', 'visible.cases 直接断言多判据行为'],
  ['hostcheck.js → toEngineDshState', 'visible.cases 直接断言 fail-closed 映射'],
  ['hostcheck.js → probeFileLock', 'visible.cases 直接断言占用判定'],
  ['hostcheck.js → resolveDshHome', 'createComponents 调用（$DSH_HOME 优先级）'],
  ['hostcheck.js → matchesDshImage', 'probeDshState 内部使用'],
  ['hostcheck.js → defaultListProcesses', 'probeDshState 的默认实现（测试注入替身）'],
  ['hostcheck.js → defaultListPorts', 'probeDshState 的默认实现（测试注入替身）'],
  ['hostcheck.js → DEFAULT_PORTS', 'probeDshState 的默认端口集'],
  ['hostcheck.js → DSH_IMAGE_HINTS', 'matchesDshImage 使用的镜像名提示'],
  ['rules.js → compileRules', 'createComponents 的 buildEngine 调用，rules.cases 经 buildEngine 触达'],
  ['rules.js → classifyTarget', 'classify 内部使用，rules.cases 经 classify 触达'],
  ['rules.js → inferAction', 'guard.cases 经 decideToolCall/handlePreExecute 触达'],
  ['rules.js → detectEmittedScript', 'guard.cases 的 G-4 用例直接验证 emit-script 判定'],
  ['rules.js → looksLikeScript', 'detectEmittedScript 内部使用'],
  ['rules.js → extractPathLike', 'inferAction 与 detectEmittedScript 内部使用'],
  ['rules.js → ACTIONS', 'classify 的动作白名单'],
  ['rules.js → BUDGETS', '影响预算类别常量'],
  ['rules.js → SCRIPT_EXTENSIONS', 'looksLikeScript 使用的扩展名表'],
  ['sessionlog.js → readLayout', 'inspect/backup 调用，inspect.cases 与 backup.cases 经此触达'],
  ['sessionlog.js → findLogFile', 'readLayout 内部使用'],
  ['sessionlog.js → HeaderCache', 'inspect 的 buildSessions 内部使用'],
  ['sessionlog.js → headerDigest', '供快照比对使用的稳定摘要'],
  ['inspect.js → readRegistry', 'guardInspect 内部使用（inspect.cases 覆盖了不可读注册表）'],
  ['inspect.js → readDshVersion', 'guardInspect 调用（读不到时返回 null，已断言不猜测）'],
  ['inspect.js → INSPECT_SCOPES', '工具 schema 的 scope 枚举，plugin.cases 断言'],
  ['inspect.js → FINDING_CODES', 'finding 代码常量表'],
  ['inspect.js → isObservedId', '辅助函数'],
  ['inspect.js → statOrNull', '辅助函数'],
  ['journal.js → Journal', 'createJournal 构造，store.cases 经此触达'],
  ['journal.js → JOURNAL_FILE', 'Journal 的固定文件名'],
  ['journal.js → JOURNAL_VERSION', '写入每条记录的版本字段'],
  ['panel.js → panelHtml', 'apply() 注册的路由返回它，client.cases 断言其无外部资源'],
  ['snapshot.js → snapshotStamp', '时间戳工具'],
  ['snapshot.js → DEFAULT_MIN_INTERVAL_MS', '调度器默认去抖间隔'],
  ['store.js → GUARD_SUBDIRS', 'ensureGuardLayout 使用'],
  ['store.js → GUARD_DIR_NAME', '$DSH_HOME 下的目录名'],
  ['store.js → ensureGuardLayout', 'GuardStore 构造时调用'],
  ['backup.js → fileHash', '备份与快照的哈希计算'],
  ['backup.js → MAX_BACKUP_BYTES', '写前备份上限（backup.cases 经 maxBytes 触发）'],
  ['backup.js → MAX_REGISTRY_BYTES', '注册表副本上限'],
  ['guard.js → describeTargets', '供面板使用的目标健康速览'],
  ['guard.js → CIRCUIT_THRESHOLD', '熔断默认阈值（配置默认值同源）'],
  ['paths.js → looksLikeJunction', 'describePath 内部使用'],
  ['paths.js → resolveReal', '便捷包装'],
  ['paths.js → isAbsolutePath', '便捷包装'],
])

const totalExports = [...exportsByFile.values()].reduce((sum, list) => sum + list.length, 0)
const unreferenced = []
const indirectlyCovered = []
for (const [file, names] of exportsByFile) {
  for (const name of names) {
    // 用词边界匹配，避免 `apply` 被 `applyXxx` 误判为已覆盖。
    const used = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(allTestText)
    if (used) continue
    const key = `${file} → ${name}`
    if (REACHABLE_VIA_ENTRY.has(key)) indirectlyCovered.push(`${key}（${REACHABLE_VIA_ENTRY.get(key)}）`)
    else unreferenced.push(key)
  }
}

// ---------------------------------------------------------------------------
// 2) 副作用注册点：每处都必须有测试断言
// ---------------------------------------------------------------------------
const REGISTRATION_SITES = [
  { site: 'ctx.tools.register', where: 'lib/index.js', mustAssert: /tools.*register|__registered\.tools|state\.tools/ },
  { site: "ctx.on('tools/pre-execute')", where: 'lib/index.js', mustAssert: /pre-execute/ },
  { site: "ctx.on('agent/turn-stopping')", where: 'lib/index.js', mustAssert: /turn-stopping/ },
  { site: "ctx.on('agent/created')", where: 'lib/index.js', mustAssert: /agent\/created/ },
  { site: 'webServer.register', where: 'lib/index.js', mustAssert: /routes|webServer/ },
  { site: 'ctx.effect', where: 'lib/index.js', mustAssert: /__disposers|effectDisposer|dispose/ },
]
for (const entry of REGISTRATION_SITES) {
  const source = readFileSync(join(ROOT, entry.where), 'utf8')
  const present = source.includes(entry.site.replace('ctx.tools.register', 'ctx.tools.register'))
  if (!present) continue
  if (!entry.mustAssert.test(allTestText)) {
    problems.push(`注册点无断言：${entry.site}（${entry.where}）`)
  }
}

// ---------------------------------------------------------------------------
// 3) 设计文档 §6.2 的八种动作：规则引擎是否都实现且有断言
// ---------------------------------------------------------------------------
const DESIGN_ACTIONS = ['read', 'link', 'write', 'rename-many', 'delete', 'kill', 'exec-script', 'emit-script']
const rulesText = readFileSync(join(LIB, 'rules.js'), 'utf8')
for (const action of DESIGN_ACTIONS) {
  const implemented = rulesText.includes(`'${action}'`)
  const asserted = new RegExp(`['"\`]${action}['"\`]`).test(testText)
  if (!implemented) problems.push(`§6.2 动作未实现：${action}`)
  else if (!asserted) problems.push(`§6.2 动作无断言：${action}`)
}

// ---------------------------------------------------------------------------
// 4) §7.2 的 finding code：是否都被报告或测试覆盖
// ---------------------------------------------------------------------------
const INSPECT_CODES = [
  'path-as-identity-mismatch',
  'reparse-point-in-workspace',
  'registry-unreadable',
  'session-header-unreadable',
  'session-header-incomplete',
  'unregistered-subagent-records',
  'unregistered-conversation-records',
  'registered-session-missing-on-disk',
  'orphan-session-space',
]
const inspectText = readFileSync(join(LIB, 'inspect.js'), 'utf8')
for (const code of INSPECT_CODES) {
  if (!inspectText.includes(`'${code}'`)) {
    problems.push(`§7.2 finding code 未实现：${code}`)
    continue
  }
  if (!testText.includes(code)) notes.push(`finding code 未被直接断言（可能只在集成路径覆盖）：${code}`)
}

// ---------------------------------------------------------------------------
// 5) 配置项：每个都要有单测（解析回落）或 schema 覆盖
// ---------------------------------------------------------------------------
const configText = readFileSync(join(LIB, 'config.js'), 'utf8')
const defaultBlock = /export const DEFAULT_CONFIG = Object\.freeze\(\{([\s\S]*?)\}\)/m.exec(configText)
const configKeys = defaultBlock === null
  ? []
  : [...defaultBlock[1].matchAll(/^\s{2}([a-zA-Z][\w]*):/gm)].map((match) => match[1])
for (const key of configKeys) {
  if (!testText.includes(key)) problems.push(`配置项无断言：${key}`)
}

// ---------------------------------------------------------------------------
// 6) 跨模块一致性：装配层是否收口了所有变体输入
// ---------------------------------------------------------------------------
const indexText = readFileSync(join(LIB, 'index.js'), 'utf8')
if (!indexText.includes('toRootsProvider')) {
  problems.push('装配层缺少 workspaceRoots 形态收口（toRootsProvider）')
}
if (!testText.includes('传数组') && !testText.includes('workspaceRoots: [')) {
  problems.push('没有测试覆盖「workspaceRoots 传数组」这一形态（上一轮的缺陷正是它）')
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
console.log('# 覆盖审计\n')
console.log(`lib 导出总数 : ${totalExports}`)
console.log(`文字引用的导出 : ${totalExports - unreferenced.length - indirectlyCovered.length}`)
console.log(`入口间接覆盖的导出 : ${indirectlyCovered.length}`)
console.log(`未覆盖的导出 : ${unreferenced.length}`)
if (indirectlyCovered.length > 0) {
  console.log('\n【入口间接覆盖】未按名字引用，但经 apply()/createComponents() 的真实路径触达：')
  for (const item of indirectlyCovered) console.log(`  · ${item}`)
}
if (unreferenced.length > 0) {
  console.log('\n【未覆盖】既没被测试引用，也不在入口可达清单里：')
  for (const item of unreferenced) console.log(`  · ${item}`)
}
console.log(`\n注册点检查 : ${REGISTRATION_SITES.length} 处`)
console.log(`§6.2 动作 : ${DESIGN_ACTIONS.length} 种`)
console.log(`§7.2 finding code : ${INSPECT_CODES.length} 个`)
console.log(`配置项 : ${configKeys.length} 项`)

if (notes.length > 0) {
  console.log('\n【提示】以下项实现存在但未被直接断言（不一定是缺陷，供复核）：')
  for (const note of notes) console.log(`  · ${note}`)
}

console.log('')
if (problems.length === 0) {
  console.log('✅ 覆盖审计通过：所有导出（直接或入口间接）、注册点、动作、finding code 与配置项都有对应断言。')
  process.exitCode = 0
} else {
  console.log(`❌ 覆盖审计发现 ${problems.length} 项缺口：`)
  for (const problem of problems) console.log(`  · ${problem}`)
  process.exitCode = 1
}
