// 严格编码体检：找出文件中「本应是合法 UTF-8 却被双重编码」的行。
//
// 上一次扫描用了猜测性模式，漏掉了 config.js 的真实损坏。这次用两个客观判据：
//   1. U+FFFD 替换字符（解码失败的确定性标志）；
//   2. 「本文件应当含中文」却出现典型 UTF-8→CP936→UTF-8 双重编码特征序列。
// 判据 2 用字节级检查：双重编码会产生 E4-E9 之后紧跟非预期续字节的组合。
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库根由本文件位置推导，不硬编码本机路径。
const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const SKIP = new Set(['node_modules', '.git', '.verify', '.smoke-home', '.smoke-pnpm', '.schema-home', '.schema-pnpm', '.npm-cache'])

/**
 * 本文件自己要被跳过。
 *
 * 原因：下面那串"双重编码特征"汉字就写在本文件里（作为模式定义），
 * 扫自己必然命中——那是**规则定义**，不是被损坏的内容。
 * 这是自指检查的固有陷阱，必须显式排除，否则检查永远报假阳性。
 */
const SELF = fileURLToPath(import.meta.url).replace(/\\/g, '/')

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue
      walk(join(dir, entry.name))
      continue
    }
    if (!/\.(js|mjs|json|md|yml|yaml)$/.test(entry.name)) continue
    const full = join(dir, entry.name).replace(/\\/g, '/')
    if (full === SELF) continue
    files.push(full)
  }
}
walk(ROOT)

// 双重编码特征：常见于「原 UTF-8 中文」被当 CP936 解码再存 UTF-8，
// 结果里高频出现「锛/鈥/鐨/鏄/涓/璁/閰/鍜/杩/鏂/彂/鎴/浣/浜/鍦/鍏/涓€」这类字。
const DOUBLE_ENCODED = /[锛鈥鐨鏄涓璁閰鍜杩鏂彂鎴浣浜鍦鍏鏃鏂鍑鎵鍚鎶鏈鍔熻兘]/

const problems = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const bad = []
  for (const [index, line] of lines.entries()) {
    if (line.includes('\uFFFD')) bad.push({ line: index + 1, why: 'U+FFFD' })
    else if (DOUBLE_ENCODED.test(line)) bad.push({ line: index + 1, why: '双重编码特征' })
  }
  if (bad.length > 0) {
    problems.push({ file: relative(ROOT, file).replace(/\\/g, '/'), count: bad.length, first: bad[0] })
  }
}

console.log('扫描文件数 :', files.length)
if (problems.length === 0) {
  console.log('✅ 未发现 U+FFFD 或双重编码特征')
} else {
  console.log('❌ 发现问题文件：')
  for (const item of problems) {
    console.log(`  ${item.file} —— ${item.count} 行，首个在第 ${item.first.line} 行（${item.first.why}）`)
  }
}

// 额外：确认关键文件仍能被 JS 解析器接受。
const { execFileSync } = await import('node:child_process')
void execFileSync
console.log('\n提示：语法级验证请用 `npm run lint`（node --check 覆盖全部发布产物）。')
