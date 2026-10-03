// 检查审计报告本身是否泄露了真实名——审计文档不该成为新的泄露点。
//
// 设计要点：本文件**不硬编码任何真实名**。
// 早先的版本把真实名直接列成常量，结果这些常量本身成了仓库里的泄露点
// （脱敏扫描会命中本文件）。现在改为从 `DESIGN.md` 动态提取"可能敏感的候选"，
// 再检查审计报告是否复述了它们——规则与数据分离，规则不携带秘密。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const SOURCE = join(ROOT, 'DESIGN.md')
const REPORT = join(ROOT, '.verify', 'design-redaction-audit.md')

/**
 * 从源文档里抽取"确实像本机信息"的候选串。只用于比对，不打印。
 *
 * 刻意**只取路径类与会话 id**，不取孤立的小写长词：
 * 早先的版本用 `\b[a-z][a-z0-9]{6,}\b` 会把 `workspace`、`home` 这类通用词也算成敏感，
 * 于是报告里合法的占位符（`<workspace>`）被误报成"复述了敏感串"。
 * 一个报假阳性的检查会被忽略，所以规则必须精确。
 *
 * @param {string} text - 源文档内容。
 * @returns {Set<string>} 候选串集合（小写化）。
 */
function candidates(text) {
  const out = new Set()
  // 1) 盘符绝对路径片段（真正的本机路径）
  for (const match of text.matchAll(/[A-Za-z]:\\[^\s`"',，。；)）\]]+/g)) out.add(match[0].toLowerCase())
  // 2) 会话 id
  for (const match of text.matchAll(/\bsession-[0-9a-f-]{8,}\b/gi)) out.add(match[0].toLowerCase())
  return out
}

if (!existsSync(SOURCE)) {
  console.log('找不到 DESIGN.md，跳过。')
  process.exit(0)
}
if (!existsSync(REPORT)) {
  console.log('审计报告尚未生成（先运行 .verify/audit-design-redaction.mjs），跳过。')
  process.exit(0)
}

const pool = candidates(readFileSync(SOURCE, 'utf8'))
const reportLower = readFileSync(REPORT, 'utf8').toLowerCase()

// 报告里出现的候选串 —— 即"复述了源文档内容"的地方。
const repeated = [...pool].filter((needle) => needle.length >= 6 && reportLower.includes(needle))

console.log('源文档候选串数量 :', pool.size)
console.log('报告复述的候选串 :', repeated.length)

if (repeated.length === 0) {
  console.log('✅ 审计报告未复述源文档中的敏感串（只给位置与类别）')
  process.exitCode = 0
} else {
  // 不回显命中内容，只报长度与不可反推的短摘要，避免本脚本自己成为泄露点。
  console.log('❌ 审计报告复述了敏感串，需要脱敏：')
  for (const needle of repeated.slice(0, 12)) {
    const digest = createHash('sha256').update(needle).digest('hex').slice(0, 8)
    console.log(`   · 长度 ${needle.length}，摘要 ${digest}`)
  }
  process.exitCode = 1
}
