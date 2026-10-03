// 隔离性验证：跑完整测试套件期间，真实 $DSH_HOME 不得被**测试**改动。
//
// ## 为什么判据要这么设计
//
// 真实 `$DSH_HOME` 里**正在运行着 DSH 本身**，它无时无刻不在写自己的东西
// （投影缓存 `storages/session_projcache/**`、正在记录的会话文件…）。
// 一个把"应用自身活动"也算成污染的检查，会持续报假阳性——那比没有检查更糟，
// 因为人会开始忽略它。第一版就犯了这个错：把同一个文件的大小变化
// （127728 → 127974 字节）拆成"新增 1 + 消失 1"，于是判定隔离失败。
//
// 现在的判据分两层：
//
// **实质判据（决定成败）** —— 必须**全部**成立才通过：
//   1. 真实 home 下**没有**出现 `agent-guard` 目录（本插件唯一会写的位置）；
//   2. 全库扫描**没有任何**路径含 `agent-guard` 的文件（新增或已存在）；
//   3. 顶层目录集合没有新增/删除（`sessions` / `storages` / `profiles` … 结构不变）；
//   4. `profiles/` 子树零改动（插件的装配不会碰用户 profile）。
//
// **参考读数（不影响成败）** —— 如实打印但不据此判定：
//   投影缓存等应用自身活动造成的数量变化。
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const REAL_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')

/**
 * 递归收集「相对路径 → 大小」。
 *
 * @param {string} root - 起始目录。
 * @returns {Map<string, number>} 路径到字节数。
 */
function sizes(root) {
  const out = new Map()
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        out.set(`${rel}/`, -1)
        walk(full, rel)
        continue
      }
      try {
        out.set(rel, statSync(full).size)
      } catch {
        out.set(rel, -2)
      }
    }
  }
  walk(root, '')
  return out
}

/** 在两个快照之间比较，返回分类结果。 */
function compare(before, after) {
  const created = [...after.keys()].filter((key) => !before.has(key))
  const deleted = [...before.keys()].filter((key) => !after.has(key))
  const changed = [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key))
  return { created, deleted, changed }
}

if (!existsSync(REAL_HOME)) {
  console.log('未找到真实 DSH_HOME，跳过。')
  process.exit(0)
}

console.log('真实 DSH_HOME :', REAL_HOME)
console.log('测试前 agent-guard 是否存在 :', existsSync(join(REAL_HOME, 'agent-guard')))

const before = sizes(REAL_HOME)
const profilesBefore = sizes(join(REAL_HOME, 'profiles'))

// 跑完整测试套件。
//
// 刻意用 `stdio: 'ignore'`：受限沙箱下子进程的管道式 stdio 会被拒绝（EPERM），
// 那会把「沙箱限制」误报成「测试失败」。测试退出码由 `npm test` 单独验证。
let exitCode = 0
try {
  execFileSync(process.execPath, ['test/run.mjs'], { cwd: ROOT, stdio: 'ignore' })
} catch (error) {
  exitCode = error.status ?? 1
}

const after = sizes(REAL_HOME)
const profilesAfter = sizes(join(REAL_HOME, 'profiles'))

const full = compare(before, after)
const profilesDiff = compare(profilesBefore, profilesAfter)

// --- 实质判据 ---
const guardDirCreated = existsSync(join(REAL_HOME, 'agent-guard'))
const anyGuardPath = [...after.keys()].filter((key) => key.toLowerCase().includes('agent-guard'))

const topBefore = new Set([...before.keys()].filter((key) => !key.includes('/')).map((key) => key.replace(/\/$/, '')))
const topAfter = new Set([...after.keys()].filter((key) => !key.includes('/')).map((key) => key.replace(/\/$/, '')))
const topCreated = [...topAfter].filter((name) => !topBefore.has(name))
const topDeleted = [...topBefore].filter((name) => !topAfter.has(name))

const checks = [
  { name: '真实 home 下未创建 agent-guard/', ok: !guardDirCreated, detail: String(guardDirCreated) },
  { name: '无任何路径含 agent-guard', ok: anyGuardPath.length === 0, detail: anyGuardPath.slice(0, 5).join(', ') },
  { name: '顶层结构无新增目录/文件', ok: topCreated.length === 0, detail: topCreated.join(', ') },
  { name: '顶层结构无删除', ok: topDeleted.length === 0, detail: topDeleted.join(', ') },
  { name: 'profiles/ 子树零改动', ok: profilesDiff.created.length === 0 && profilesDiff.deleted.length === 0 && profilesDiff.changed.length === 0, detail: `${profilesDiff.created.length}/${profilesDiff.deleted.length}/${profilesDiff.changed.length}` },
]

console.log('测试退出码 :', exitCode)
console.log('\n[实质判据]')
let allOk = true
for (const check of checks) {
  if (!check.ok) allOk = false
  console.log(`  ${check.ok ? '✅' : '❌'} ${check.name}${check.ok ? '' : ` — ${check.detail}`}`)
}

console.log('\n[参考读数]（真实 home 里 DSH 自身也在写，故不据此判定成败）')
console.log('  全库新增条目 :', full.created.length)
console.log('  全库消失条目 :', full.deleted.length)
console.log('  全库大小变化 :', full.changed.length)
for (const key of full.created.slice(0, 6)) console.log('    +', key)
for (const key of full.deleted.slice(0, 6)) console.log('    -', key)
for (const key of full.changed.slice(0, 6)) console.log('    ~', key, `${before.get(key)} → ${after.get(key)}`)

console.log('\n结论 :', allOk
  ? '✅ 隔离成立：测试套件未在真实 DSH_HOME 创建任何本插件相关路径，'
    + 'profiles/ 与顶层结构零改动。'
    + (full.created.length + full.deleted.length + full.changed.length > 0
      ? `（另有 ${full.created.length + full.deleted.length + full.changed.length} 处条目变化，`
        + '来自正在运行的 DSH 自身 —— 例如投影缓存 storages/session_projcache/**。）'
      : '')
  : '❌ 实质判据未通过，隔离纪律被破坏。')

process.exitCode = allOk ? 0 : 1
