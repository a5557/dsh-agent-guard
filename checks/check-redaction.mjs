// §20 发布前安全检查：对将要入库的源文件做脱敏扫描。
// 只扫描源码与文档（跳过 .verify 草稿），报告命中项而不打印上下文，避免二次泄露。
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库根由本文件位置推导，不硬编码本机路径（否则本文件自己就是一处分行泄露）。
const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const SKIP_DIRS = new Set(['.verify', '.git', 'node_modules', '.npm-cache'])

/**
 * 本机敏感值的**运行时派生**（不在源码里明文写出）。
 *
 * 为什么必须这样：本文件会随 npm 包发布。如果为了"检测真实用户名/工作区名"
 * 而把它们明文写进 PATTERNS，那这个检查脚本自己就成了公开面上的泄露点 ——
 * 项目审计正是这样抓到它的（第 1 层命中）。改为从环境变量派生：
 * 本机运行时照样能检出，而发布出去的源码里没有真实值。
 *
 * 代价（如实记录）：在**别的机器**上运行时，这些派生模式匹配的是那台机器的值，
 * 而不是本机的 —— 对本项目是合适的（"不应泄露本机信息"本就是逐机性质），
 * 但读者需要知道这个语义。
 */
const LOCAL_VALUES = [
  { value: process.env.USERNAME ?? '', label: '本机账户名' },
  { value: (process.env.USERPROFILE ?? '').split(/[\\/]/).pop() ?? '', label: '用户主目录名' },
  { value: process.env.COMPUTERNAME ?? '', label: '机器名' },
].filter((entry) => entry.value.length >= 3)

/** 把本机值转成字面量检测器。 */
function localValuePatterns() {
  return LOCAL_VALUES.map((entry) => {
    const escaped = entry.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return { name: entry.label, re: new RegExp(`\\b${escaped}\\b`, 'i') }
  })
}

/**
 * 结构性敏感模式：与具体机器无关，可以安全地明文写出。
 *
 * 这里**不再**列出具体的第三方工具名或具体工作区名 —— 那属于「用泄露去检测泄露」。
 * 需要点名某个具体产品时，应由使用者在本地配置，而不是写进发布的源码。
 */
const PATTERNS = [
  ...localValuePatterns(),
  { name: '用户主目录路径', re: /[Cc]:\\Users\\[^\\\s"']+/ },
  { name: '机器名形态（hostname 风格）', re: /\bDESKTOP-[A-Z0-9]{7}\b/i },
  { name: '会话 id 形态', re: /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: '凭据内容', re: /(sk-[A-Za-z0-9]{16,}|api[_-]?key\s*[:=]\s*["'][^"']+)/i },
  { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

/**
 * 自指文件：这些文件里**必须**出现敏感串，因为它们是检测规则的载体。
 *
 * 排除它们不是放宽标准，而是避免"检查命中自己写的模式定义"这一固有陷阱——
 * 每加一个含模式定义的检查脚本，都要在这里登记并写明理由。
 */
const SELF_REFERENTIAL = new Set([
  'checks/check-redaction.mjs', // 本文件：定义 §20 的敏感模式
  'checks/check-release-checklist.mjs', // 同一批模式 + 第三方工具名
  'checks/check-audit-leak.mjs', // 从源文档提取候选串做比对
  'checks/check-encoding.mjs', // 定义双重编码特征字表
])

/** 该文件是否属于自指（命中不参与判定）。 */
function isSelfReferential(absolute) {
  return SELF_REFERENTIAL.has(relative(ROOT, absolute).replace(/\\/g, '/'))
}

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(join(dir, entry.name))
      continue
    }
    if (!/\.(md|js|mjs|json|yml|yaml|txt)$/i.test(entry.name)) continue
    const full = join(dir, entry.name).replace(/\\/g, '/')
    if (isSelfReferential(full)) continue
    files.push(full)
  }
}
walk(ROOT)

const hits = []
for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    for (const pattern of PATTERNS) {
      if (!pattern.re.test(line)) continue
      // 允许显式声明的占位符白名单：设计与文档里合法的通用词。
      if (/占位符|placeholder|<workspace>|<home>|<host>|脱敏|redact/i.test(line)) continue
      hits.push({ file: relative(ROOT, file), line: index + 1, pattern: pattern.name })
    }
  }
}

console.log('扫描文件数 :', files.length)
console.log('跳过目录   :', [...SKIP_DIRS].join(', '))
console.log('命中总数   :', hits.length)
if (hits.length > 0) {
  console.log('\n命中明细（只报位置与模式，不回显内容）：')
  for (const hit of hits.slice(0, 60)) {
    console.log(`  ${hit.file}:${hit.line}  ← ${hit.pattern}`)
  }
  if (hits.length > 60) console.log(`  … 另有 ${hits.length - 60} 条`)
}
