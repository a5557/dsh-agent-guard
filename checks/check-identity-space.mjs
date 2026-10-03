// 身份空间审计（路径比对面）：确保 lib/ 里每一条**比对路径**的地方都在同一个身份空间里。
//
// 为什么需要它：三平台 CI 首次真跑时，macOS 把整张受保护路径表走空了——因为
// `compileRules` 编译的是**逻辑拼写**的基路径，而 `classifyTarget` 比对的是**物理路径**。
// 同一个缝在四条代码路径上重复出现（基路径 / 尚不存在的目标 / Windows 目录联接 /
// 脚本正文里的路径），每一次都表现为"该拒绝却放行"。这类缝靠"逐个文件读一遍"是查不干净的，
// 所以这里改成机制：
//
//   静态半场：列出 lib/ 每个模块导入/调用了哪些身份函数，并断言**只有 paths.js 自己**
//             做符号链接解析（其他模块必须走共享原语，不许自行 realpath）。
//   动态半场：用真实创建的目录链接（Windows 用免提权的 junction）把同一个位置用两种
//             拼写喂进真实 API，断言它们被判成同一个身份。
//
// 动态半场在没有链接能力的环境（受限沙箱、无 Developer Mode 的 Windows）会显式跳过并说明，
// 不会伪装成通过；静态半场在任何环境都跑。
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildEngine } from '../lib/index.js'
import { classifyTarget, detectEmittedScript } from '../lib/rules.js'
import { describePath, normalizeForCompare, resolvePhysical, resolveReal } from '../lib/paths.js'
import { guardInspect } from '../lib/inspect.js'
import { linkThatResolves } from './path-link.mjs'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const LIB = join(ROOT, 'lib')

const failures = []
const notes = []
const say = (line) => process.stdout.write(`${line}\n`)
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name} — ${detail}`)
  say(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — ${detail}`}`)
}

// ---------------------------------------------------------------------------
// 1) 静态：谁在比对路径、谁在自行解析
// ---------------------------------------------------------------------------
const IDENTITY_HELPERS = [
  'normalizeForCompare', 'samePath', 'isInside', 'matchesPattern', 'compilePattern',
  'classifyTarget', 'resolvePhysical', 'resolveReal', 'describePath', 'expandHome', 'isAbsolutePath',
]
const RESOLVER = 'paths.js'

say('[1] 静态：身份函数的使用面')
const rows = []
for (const file of readdirSync(LIB).filter((name) => name.endsWith('.js')).sort()) {
  const text = readFileSync(join(LIB, file), 'utf8')
  const helpers = IDENTITY_HELPERS.filter((helper) => new RegExp(`\\b${helper}\\s*\\(`).test(text))
  const imported = (/import \{([^}]*)\} from '\.\/paths\.js'/.exec(text)?.[1] ?? '')
    .split(',').map((part) => part.trim()).filter(Boolean)
  const resolvesItself = /\brealpathSync\b/.test(text)
  rows.push({ file, imported, helpers, resolvesItself })
  if (helpers.length > 0 || imported.length > 0) {
    say(`  ${file.padEnd(15)} 导入[${imported.join(',') || '-'}] 调用[${helpers.join(',') || '-'}]`)
  }
}

check('只有 paths.js 自行解析符号链接', rows.every((row) => row.file === RESOLVER || !row.resolvesItself),
  `越权解析：${rows.filter((row) => row.file !== RESOLVER && row.resolvesItself).map((row) => row.file).join(', ')}`)
check('比对路径的模块都走共享原语（rules.js / inspect.js）',
  rows.filter((row) => row.file === 'rules.js' || row.file === 'inspect.js')
    .every((row) => row.imported.includes('normalizeForCompare') || row.imported.includes('resolvePhysical')),
  '存在自行实现的比对')

// ---------------------------------------------------------------------------
// 2) 动态：同一个位置、两种拼写，必须判成同一个身份
// ---------------------------------------------------------------------------
say('')
say('[2] 动态：目录链接下的身份一致性')

const realRoot = mkdtempSync(join(tmpdir(), 'idspace-'))
const linkRoot = `${realRoot}-link`
// 能力探测必须发生在**任何断言之前**：如果这个链接解析不到目标，那这一整套
// "两种拼写判成同一个身份"的断言都会在什么都没验证的情况下通过——本检查的第一版
// 就在 CI 上这样绿过一次（macOS/Windows runner 建链接被拒），所以现在一律显式跳过。
const linked = linkThatResolves(realRoot, linkRoot)

if (!linked) {
  notes.push('本环境建不出可解析的目录链接：动态半场已跳过（静态半场仍然有效）')
  say('  ➖ 跳过：本环境建不出可解析的目录链接（静态半场已覆盖）')
} else {
  const physicalHome = join(realRoot, 'home')
  const logicalHome = join(linkRoot, 'home')
  for (const dir of ['sessions', 'storages', 'profiles']) mkdirSync(join(physicalHome, dir), { recursive: true })
  const physicalWorkspace = join(physicalHome, 'workspaces', 'proj')
  mkdirSync(physicalWorkspace, { recursive: true })
  const logicalWorkspace = join(logicalHome, 'workspaces', 'proj')
  writeFileSync(join(physicalHome, 'storages', 'workspace.json'), '{}')

  const engine = buildEngine({ dshHome: logicalHome, workspaceRoots: [logicalWorkspace] })
  const physicalTarget = join(physicalHome, 'storages', 'workspace.json')
  const logicalTarget = join(logicalHome, 'storages', 'workspace.json')

  check('describePath 解析到物理文件',
    describePath(logicalTarget).realPath !== null
    && normalizeForCompare(describePath(logicalTarget).realPath) === normalizeForCompare(physicalTarget),
    String(describePath(logicalTarget).realPath))
  check('resolvePhysical = 将来真正被写的那个文件',
    normalizeForCompare(resolvePhysical(logicalTarget)) === normalizeForCompare(physicalTarget),
    resolvePhysical(logicalTarget))
  check('resolveReal 与 resolvePhysical 对已存在路径一致',
    normalizeForCompare(resolveReal(logicalHome)) === normalizeForCompare(physicalHome), resolveReal(logicalHome))
  check('受保护路径表编译在物理空间',
    engine.protected.some((entry) => normalizeForCompare(entry.compiled.base) === normalizeForCompare(join(physicalHome, 'storages'))),
    '表里没有物理基路径')
  check('两种拼写判成同一个身份',
    classifyTarget(logicalTarget, engine).protected === true
    && classifyTarget(physicalTarget, engine).protected === true
    && classifyTarget(logicalTarget, engine).matchedId === classifyTarget(physicalTarget, engine).matchedId,
    '同一位置在两种拼写下判定不同')
  check('engine.dshHome 与其比对的表同属一个身份空间',
    normalizeForCompare(engine.dshHome) === normalizeForCompare(physicalHome), engine.dshHome)
  check('尚不存在的目标按"将来会变成的文件"判定',
    classifyTarget(join(logicalHome, 'sessions', '--proj--', 'new.txt'), engine).protected === true,
    '不存在的目标未按物理路径判定')
  check('脚本正文里的受保护路径同样被解析',
    detectEmittedScript({
      target: join(logicalWorkspace, 'fix.bat'),
      content: `ren "${join(logicalHome, 'sessions', '--proj--')}" "--proj2--"`,
      engine,
    }).isEmitScript === true,
    '脚本文本未走同一解析')

  // 取证面：注册路径的**末尾**就是链接时，必须报成 reparse point（这是审计查出的真实缺口：
  // Windows 的 junction 不会被 lstat 报成符号链接，只靠 link 标志会当成普通目录）。
  const linkWorkspace = join(linkRoot, 'wslink')
  if (!linkThatResolves(physicalWorkspace, linkWorkspace)) {
    notes.push('工作区根那一项需要第二个链接：本环境建不出来，已跳过')
    say('  ➖ 跳过：以链接为工作区根（本环境建不出第二个链接）')
  } else {
    const registryHome = join(realRoot, 'reg-home')
    mkdirSync(join(registryHome, 'storages'), { recursive: true })
    mkdirSync(join(registryHome, 'sessions'), { recursive: true })
    const table = {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['ws-link'], archivedSessionIds: [] },
      tables: { workspaces: { 'ws-link': { path: linkWorkspace, title: 'probe', sessionIds: [], createdAt: 0, updatedAt: 0 } } },
    }
    writeFileSync(join(registryHome, 'storages', 'workspace.json'), JSON.stringify(table), 'utf8')
    const report = guardInspect({ dshHome: registryHome, scope: ['workspaces'], includeHeaders: false })
    const row = report.workspaces[0]
    check('以链接为工作区根时被识别为 reparse point 并报 error',
      row !== undefined && (row.kind === 'junction' || row.kind === 'symlink') && row.realPathMatches === false
      && report.findings.some((finding) => finding.code === 'reparse-point-in-workspace'),
      `kind=${row?.kind} realPathMatches=${row?.realPathMatches}`)
  }
}

rmSync(linkRoot, { recursive: true, force: true })
rmSync(realRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// 已知且**刻意保留**的设计（不是缺陷，写在这里防止下次被"顺手修掉"）
// ---------------------------------------------------------------------------
say('')
say('已知设计（刻意保留）：')
say('  · CircuitTracker 以路径原文为键（guard.js §7.5）：同一文件的两种拼写算两个计数器，')
say('    效果是熔断更晚触发（fail-open on detection），但每一次写仍然照常被拦/被问，')
say('    不会无备份放行。改成物理键会削弱"用户连续两次改同一文件"的原意，故保留。')
void relative

say('')
if (failures.length === 0) {
  say('✅ 身份空间审计通过：比对路径的地方同属一个身份空间，且只有 paths.js 自行解析符号链接。')
} else {
  say(`❌ 身份空间审计未通过（${failures.length} 项）：`)
  for (const failure of failures) say(`   - ${failure}`)
}
for (const note of notes) say(`ℹ️ ${note}`)
process.exitCode = failures.length === 0 ? 0 : 1
