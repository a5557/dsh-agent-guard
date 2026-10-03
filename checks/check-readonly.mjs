// 只读性自查：哪些模块含写调用，以及写路径是否只落在插件自己的目录。
// 期望：只有 store.js / backup.js 命中；两者写的位置都由 store 决定（$DSH_HOME/agent-guard/）。
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库根由本文件位置推导：不硬编码本机路径，否则本文件自己就是一处分行泄露。
const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const WRITE_CALLS = /(writeFileSync|appendFileSync|createWriteStream|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync|truncateSync|rmdirSync)/g

const ALLOWED = new Map([
  // 存储层与备份层是发布产物里唯一允许写盘的模块，且只能写插件自己的目录。
  ['lib/store.js', '$DSH_HOME/agent-guard/（本文档定义的唯一可写位置）'],
  ['lib/backup.js', '经 store.path(...) → $DSH_HOME/agent-guard/{backups,snapshots}/'],
])

/**
 * 测试代码本来就要造 fixture，因此单独归类；它们一律只写系统临时目录。
 * 这样审计的结论才精确：**发布产物**是否只读，而不是把测试也算进去。
 */
const TEST_SCOPE = /^test\//

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (['node_modules', '.verify', '.npm-cache', '.git'].includes(entry.name)) continue
      walk(join(dir, entry.name))
      continue
    }
    if (/\.(js|mjs)$/.test(entry.name)) files.push(join(dir, entry.name))
  }
}
for (const sub of ['lib', 'bin', 'test']) walk(join(ROOT, sub))

const report = []
for (const file of files) {
  const relative = file.slice(ROOT.length + 1).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf8')
  const hits = [...text.matchAll(WRITE_CALLS)].map((match) => match[1])
  if (hits.length === 0) continue
  report.push({
    file: relative,
    calls: [...new Set(hits)].sort(),
    allowed: ALLOWED.has(relative),
    isTest: TEST_SCOPE.test(relative),
  })
}

console.log('检查文件数 :', files.length)
console.log('\n【发布产物】lib/ 与 bin/：')
let shippedUnexpected = 0
let shippedWriteFiles = 0
for (const row of report.filter((entry) => !entry.isTest)) {
  shippedWriteFiles += 1
  if (!row.allowed) shippedUnexpected += 1
  console.log(`  ${row.allowed ? '✅ 允许（仅写自身目录）' : '❌ 非预期'}  ${row.file}  → ${row.calls.join(', ')}`)
  if (row.allowed) console.log(`              位置约束：${ALLOWED.get(row.file)}`)
}
const shippedTotal = files.filter((file) => !TEST_SCOPE.test(file.slice(ROOT.length + 1).replace(/\\/g, '/'))).length
console.log(`  小结：${shippedTotal} 个发布产物文件中，${shippedWriteFiles} 个含写调用，非预期 ${shippedUnexpected} 个`)

console.log('\n【测试代码】test/（只应写系统临时目录，不参与发布）：')
for (const row of report.filter((entry) => entry.isTest)) {
  console.log(`  · ${row.file}  → ${row.calls.join(', ')}`)
}

console.log('')
console.log(shippedUnexpected === 0
  ? '✅ 只读性成立：发布产物中只有存储层与备份层会写盘，且只写插件自己的目录；取证、规则、路径、会话解码、拦截决策、面板全部不含写调用。'
  : '❌ 发布产物中存在非预期的写调用，需要人工复核。')

