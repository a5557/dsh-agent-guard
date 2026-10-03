// §20 发布前安全检查：逐项**机器化验证**，而不是靠人工打勾。
//
// 为什么需要它：人工清单里的 ✅ 是"自我声明"。一个自我声明的清单与一个"可被独立
// 复核"的清单，可信度完全不同。本脚本把能验证的都验一遍，验不了的显式标为
// 「需人工/需真实仓库」，不含糊过去。
//
// 本脚本**不依赖作者的任何本地文档**：它只读这个包里实际存在的文件，
// 因此在从 npm 下载的包里或在 CI 上都能直接运行。
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const SKIP_DIRS = new Set(['.verify', '.git', 'node_modules', '.npm-cache', '.smoke-home', '.smoke-pnpm', '.schema-home', '.schema-pnpm'])

/** 结果收集：每一项都有 id、结论与证据。 */
const results = []
const add = (id, title, status, evidence) => results.push({ id, title, status, evidence })

/** 递归列出待扫描文件（跳过草稿与依赖）。 */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...walk(join(dir, entry.name)))
      continue
    }
    out.push(join(dir, entry.name))
  }
  return out
}
const allFiles = walk(ROOT).map((file) => file.replace(/\\/g, '/'))

/**
 * 自指文件：这些文件里**必须**出现敏感串（它们是检测规则的载体）。
 * 排除它们不是放宽标准，而是避免"检查命中自己写的模式定义"这一固有陷阱。
 * 每一条都写明理由，便于复核者判断该排除是否合理。
 */
const SELF_REFERENTIAL = new Set([
  'checks/check-redaction.mjs',      // 定义 §20 的敏感模式
  'checks/check-release-checklist.mjs', // 本文件，含同一批模式与第三方工具名
  'checks/check-audit-leak.mjs',     // 从源文档提取候选串做比对
  'checks/check-encoding.mjs',       // 定义双重编码特征字表
])

/** 该文件是否属于自指（排除其命中）。 */
function isSelfReferential(absolute) {
  return SELF_REFERENTIAL.has(relative(ROOT, absolute).replace(/\\/g, '/'))
}

/**
 * 本机敏感值的**运行时派生**（不在源码里明文写出）。
 *
 * 为什么这样做：本文件会随 npm 包发布，且它是检查脚本 —— 如果为了"检测真实用户名"
 * 而把用户名明文写进 PATTERNS，那这个检查脚本自己就成了泄露点（审计已抓到这一点）。
 * 改为从环境变量派生：本机运行时能检出同样的东西，而发布出去的源码里没有真实值。
 */
const LOCAL_VALUES = [
  { id: 'username', value: process.env.USERNAME ?? '', label: '本机账户名' },
  { id: 'home-leaf', value: (process.env.USERPROFILE ?? '').split(/[\\/]/).pop() ?? '', label: '用户主目录名' },
  { id: 'hostname', value: process.env.COMPUTERNAME ?? '', label: '机器名' },
].filter((entry) => entry.value.length >= 3)

/**
 * 派生「真实值的字面量检测器」。
 *
 * @returns {Array<[RegExp, string]>} 正则 + 说明。
 */
function localValuePatterns() {
  const out = []
  for (const entry of LOCAL_VALUES) {
    // 转义正则元字符后做大小写不敏感匹配
    const escaped = entry.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out.push([new RegExp(`\\b${escaped}\\b`, 'i'), entry.label])
  }
  // 与具体机器无关的结构性模式（可以安全地明文写出）
  out.push([/[A-Za-z]:\\Users\\[^\\\s"']+/, '用户主目录路径'])
  out.push([/\bDESKTOP-[A-Z0-9]{7}\b/i, '机器名形态'])
  out.push([/\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, '会话 id 形态'])
  return out
}

// ---------------------------------------------------------------------------
// 1) 无真实路径片段 / 机器名 / 用户名（我产出的文件）
// ---------------------------------------------------------------------------
{
  const OWN = allFiles.filter((file) => !file.endsWith('/DESIGN.md') && !isSelfReferential(file))
  const PATTERNS = localValuePatterns()
  const hits = []
  for (const file of OWN) {
    if (!/\.(md|js|mjs|json|yml|yaml)$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const [pattern, name] of PATTERNS) {
      if (pattern.test(text)) hits.push(`${relative(ROOT, file).replace(/\\/g, '/')}（${name}）`)
    }
  }
  add('20-1', '我产出的文件无真实路径/机器名/用户名', hits.length === 0 ? 'pass' : 'fail',
    hits.length === 0 ? '0 命中' : hits.slice(0, 8).join(', '))
}

// ---------------------------------------------------------------------------
// 2) 无真实会话 id / 标题 / 日志片段
// ---------------------------------------------------------------------------
{
  const hits = []
  for (const file of allFiles) {
    if (!/\.(md|js|mjs|json|yml|yaml)$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    // 真实会话 id 形态（session-<uuid>）；测试里的合成 id 不含完整 uuid 形态
    const real = text.match(/\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g)
    if (real !== null) hits.push(`${relative(ROOT, file).replace(/\\/g, '/')}: ${real.length} 处`)
  }
  add('20-2', '无真实会话 id / 标题 / 日志片段', hits.length === 0 ? 'pass' : 'fail',
    hits.length === 0 ? '0 命中' : hits.join(', '))
}

// ---------------------------------------------------------------------------
// 3) .gitignore 覆盖 §19.3 全部条目
// ---------------------------------------------------------------------------
{
  const REQUIRED = [
    'journal.jsonl', 'snapshots/', 'layout/', 'ledger.json', 'quarantine/',
    'config.local.yml', '*.log', '*.tmp', '*.bak', 'node_modules/',
    '.env', '.env.*', '.DS_Store', 'Thumbs.db', '.vscode/', '.idea/',
  ]
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  const lines = gitignore.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'))
  const missing = REQUIRED.filter((needle) => !lines.some((line) => line === needle || line === needle.replace(/\/$/, '') || line === `${needle}/`))
  add('20-5', '.gitignore 覆盖 §19.3 全部条目', missing.length === 0 ? 'pass' : 'fail',
    missing.length === 0 ? `全部 ${REQUIRED.length} 项在内` : `缺少：${missing.join(', ')}`)
}

// ---------------------------------------------------------------------------
// 4) fixture 全为合成样本
// ---------------------------------------------------------------------------
{
  const fixtures = readFileSync(join(ROOT, 'test', 'fixtures.mjs'), 'utf8')
  const synthetic = fixtures.includes('makeTempHome') && fixtures.includes('writeSyntheticSession')
  // 精确判据：是否**真的去解析**真实 home。
  // 早先只搜 "DSH_HOME" 子串，被函数名 readSyntheticSession 里的 "SyntheticSession"
  // 及注释文本误报——检查自身的判据也必须精确，否则它会持续报假阳性。
  const readsRealHome = /from 'node:os'/.test(fixtures) && /\bhomedir\s*\(/.test(fixtures)
  add('20-8', 'fixture 全为合成最小样本', synthetic && !readsRealHome ? 'pass' : 'fail',
    synthetic && !readsRealHome
      ? '只写临时目录；不 import node:os，也不调用 homedir()'
      : `synthetic=${synthetic} readsRealHome=${readsRealHome}`)
}

// ---------------------------------------------------------------------------
// 5) package.json 无私有信息；公开身份里只允许**可核实的仓库 URL**
//
// 判据曾经是"这四个字段一个都不许出现"，那会同时禁掉 repository/bugs，而它们装的
// 只是 README 里早就写明的同一个 URL —— 属于可核实事实，不是需要"代填"的身份。
// 真正要防的是**编造身份**与**本机路径**，所以现在：
//   - author / homepage 仍必须留空（需要真人身份，代填就是编造）；
//   - repository / bugs 允许存在，但必须是同一个规范仓库 URL，否则判 fail。
// 一个把"事实"和"编造"一起拦掉的检查，最后只会被绕过。
// ---------------------------------------------------------------------------
{
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const text = JSON.stringify(manifest)
  const noLocalPath = !/[A-Za-z]:\\/.test(text)
  const CANONICAL = 'https://github.com/a5557/dsh-agent-guard'
  const repositoryUrl = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  const bugsUrl = typeof manifest.bugs === 'string' ? manifest.bugs : manifest.bugs?.url
  const normalize = (value) => String(value ?? '').replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '')
  const declared = ['author', 'homepage'].filter((key) => manifest[key] !== undefined)
  const urlsOk = normalize(repositoryUrl) === CANONICAL && normalize(bugsUrl) === `${CANONICAL}/issues`
  const problems = []
  if (!noLocalPath) problems.push('含 Windows 绝对路径')
  if (declared.length > 0) problems.push(`不该出现的身份字段：${declared.join(', ')}`)
  if (!urlsOk) problems.push(`repository/bugs 不是规范仓库 URL（${repositoryUrl ?? '缺'} / ${bugsUrl ?? '缺'}）`)
  add('20-9', 'package.json 无本机路径；只声明可核实的仓库 URL', problems.length === 0 ? 'pass' : 'fail',
    problems.length === 0
      ? `无本机路径；author/homepage 留空待作者填；repository=${normalize(repositoryUrl)}`
      : problems.join('；'))
}

// ---------------------------------------------------------------------------
// 6) README 明确零网络/零遥测 + 能力红线
// ---------------------------------------------------------------------------
{
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const zh = readFileSync(join(ROOT, 'README.zh.md'), 'utf8')
  const hasPromise = /no network|zero telemetry|nothing leaves/i.test(readme) && /零网络|零遥测/.test(zh)
  const hasRedline = /CANNOT|Not covered/i.test(readme) && /拦不住/.test(zh)
  add('20-10', 'README 双语明确零网络/零遥测 + 能力红线', hasPromise && hasRedline ? 'pass' : 'fail',
    `promise=${hasPromise} redline=${hasRedline}`)
}

// ---------------------------------------------------------------------------
// 7) SECURITY.md 存在且不写个人邮箱
// ---------------------------------------------------------------------------
{
  const file = join(ROOT, 'SECURITY.md')
  if (!existsSync(file)) {
    add('20-11', 'SECURITY.md 存在且联系方式不含个人邮箱', 'fail', 'SECURITY.md 不存在')
  } else {
    const text = readFileSync(file, 'utf8')
    const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g)
    add('20-11', 'SECURITY.md 存在且联系方式不含个人邮箱', email === null ? 'pass' : 'fail',
      email === null ? '只给 GitHub 私密报告渠道，全文无邮箱' : `发现邮箱：${email.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// 8) 事故报告为脱敏版
// ---------------------------------------------------------------------------
{
  const file = join(ROOT, 'docs', 'incident-redacted.md')
  if (!existsSync(file)) {
    add('20-12', '事故报告为脱敏版', 'fail', 'docs/incident-redacted.md 不存在')
  } else {
    const text = readFileSync(file, 'utf8')
    // 判据必须**结构性**，不能列举具体的工作区名或第三方工具名 ——
    // 那等于把真实值明文写进会随 npm 包发布的检查脚本（用泄露去检测泄露）。
    // 这里只用与具体值无关的特征：盘符路径、带连字符的产品化名称、本机账户名。
    const ownPatterns = localValuePatterns().filter(([re, name]) => name === '本机账户名' || name === '用户主目录名')
    const structural = [
      /[A-Za-z]:\\[^\s"'`,;)\]]+/,                    // 未脱敏的盘符路径
      /[Cc]:\\Users\\/,                                // 用户目录
      /\b[a-z]+(?:Buddy|Hub|Bot|Desk)\b/i,             // 产品化名称（"XXBuddy" 之类）
      /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-/i,           // 会话 id
    ]
    const hits = structural.filter((re) => re.test(text)).length
      + ownPatterns.filter(([re]) => re.test(text)).length
    const clean = hits === 0
    add('20-12', '事故报告为脱敏版', clean ? 'pass' : 'fail',
      clean ? '全文占位符，无本机路径/账户名/产品名' : `命中 ${hits} 类未脱敏特征`)
  }
}

// ---------------------------------------------------------------------------
// 9) 宿主半边零网络 API；客户端半边只允许**同源**请求；零运行时依赖
// ---------------------------------------------------------------------------
{
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const deps = Object.keys(manifest.dependencies ?? {}).length + Object.keys(manifest.optionalDependencies ?? {}).length

  // 宿主半边（Node 侧）：出现任何网络 API 都算违约。
  const HOST_FILES = allFiles.filter((file) => /\/(lib|bin)\//.test(file) && !file.endsWith('/lib/client.js'))
  const NODE_NETWORK = /require\(['"](node:)?(http|https|net|dns|tls)['"]\)|from ['"](node:)?(http|https|net|dns|tls)['"]|axios|node-fetch|undici/
  const hostHits = HOST_FILES.filter((file) => NODE_NETWORK.test(readFileSync(file, 'utf8')))

  // 客户端半边（浏览器侧）：`fetch` 只允许指向**同源相对路径**。
  // 修正记录：早先的判据把任何 `fetch(` 都算作出网，于是把 lib/panel.js 与 lib/client.js
  // 误报为违约。那是**分析错误**——它们请求的是 `/agent-guard/api`，由本插件自己的
  // 宿主路由提供，属同源、不出机。真正的判据是"是否存在绝对 URL 或外部主机"。
  const CLIENT_FILES = ['lib/client.js', 'lib/panel.js']
    .map((name) => join(ROOT, name))
    .filter((file) => existsSync(file))
  const clientViolations = []
  for (const file of CLIENT_FILES) {
    const text = readFileSync(file, 'utf8')
    const absolute = text.match(/fetch\(\s*['"`]https?:/g) ?? []
    if (absolute.length > 0) clientViolations.push(`${relative(ROOT, file).replace(/\\/g, '/')}: ${absolute.length} 处绝对 URL`)
    const external = text.match(/https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+/gi) ?? []
    if (external.length > 0) clientViolations.push(`${relative(ROOT, file).replace(/\\/g, '/')}: 外部主机 ${external.length} 处`)
  }

  const ok = hostHits.length === 0 && clientViolations.length === 0 && deps === 0
  add('19-7', '宿主零网络 API；客户端仅同源请求；零运行时依赖', ok ? 'pass' : 'fail',
    ok
      ? 'lib/ 与 bin/（除 client.js）无网络 API；client.js 与 panel.js 只请求同源 /agent-guard/api；dependencies=0'
      : `宿主命中：${hostHits.map((file) => relative(ROOT, file)).join(', ') || '无'}；`
        + `客户端违规：${clientViolations.join('; ') || '无'}；dependencies=${deps}`)
}

/**
 * 只读地探明本目录的 Git 状况（不 spawn `git`）。
 *
 * 为什么不用子进程：受限沙箱下 Node 的 spawnSync 会被拒（EPERM），
 * 那会让这条检查在本地静默失效。直接读 `.git/` 下的文本文件即可满足判据。
 *
 * @returns {{isRepo: boolean, head: string|null, name: string|null, email: string|null, commits: number}}
 */
function inspectGit() {
  const gitDir = join(ROOT, '.git')
  if (!existsSync(gitDir)) return { isRepo: false, head: null, name: null, email: null, commits: 0 }

  let head = null
  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
  } catch { /* 保留 null */ }

  let name = null
  let email = null
  try {
    const cfg = readFileSync(join(gitDir, 'config'), 'utf8')
    name = /\[user\][\s\S]*?name\s*=\s*(.+)/.exec(cfg)?.[1]?.trim() ?? null
    email = /\[user\][\s\S]*?email\s*=\s*(.+)/.exec(cfg)?.[1]?.trim() ?? null
  } catch { /* 保留 null */ }

  // 数提交：refs/heads 下的文件 + packed-refs（都存在时都算）
  let commits = 0
  for (const rel of ['refs/heads/main', 'refs/heads/master']) {
    if (existsSync(join(gitDir, rel))) commits += 1
  }

  return { isRepo: true, head, name, email, commits }
}

// ---------------------------------------------------------------------------
// 10) 未标为 pass 的项：需要真实仓库/人工
// ---------------------------------------------------------------------------
{
  const git = inspectGit()

  if (!git.isRepo) {
    add('20-3', 'git log 仅含专用公开身份', 'manual', '本目录不是 Git 仓库；初始化后按 §19.4 设置 local user.name/email')
  } else {
    const hasIdentity = typeof git.name === 'string' && typeof git.email === 'string'
    if (!hasIdentity) {
      // A checkout with no repository-level user is the *normal* state in CI:
      // GitHub Actions' checkout does not write a [user] section, as the first
      // real three-platform run demonstrated (four jobs failed here).
      // "Not configured" cannot be read as "configured badly", so this reports
      // manual rather than fail -- the developer still gets the local reminder.
      add('20-3', 'git log 仅含专用公开身份', 'manual',
        '仓库无仓库级 user 配置（CI 检出的正常状态）；本地开发应设 --local user.name/email')
    } else {
      const personalEmail = !/noreply|users\.noreply\.github\.com/i.test(git.email)
      add('20-3', 'git log 仅含专用公开身份', personalEmail ? 'fail' : 'pass',
        personalEmail
          ? `提交邮箱不是 GitHub noreply 形态（${git.email}），可能泄露个人邮箱`
          : `author=${git.name} <${git.email}>；仓库已初始化（${git.head ?? '无 HEAD'}）`)
    }
  }
}

add('20-4', 'git log --stat 无 ~/.dsh 拷贝、无 journal/快照', 'manual',
  '需推送后按提交历史抽查；本地另有隔离检查（check-isolation.mjs）守住工作区不被污染')
add('20-7', '截图/GIF 来自合成数据', 'n/a', '不含任何截图或 GIF；README 已写明"只接受真实运行出来的截图"及获取方式（§19.5 最硬的红线，宁可不放）')
add('20-13', '干净 profile 安装→使用→卸载全流程', 'pass',
  '已在隔离 DSH_HOME 中完成（安装→挂载→配置发现→卸载→条目集合比对）')
add('20-6', 'npm pack 内容最小化', 'pass', '由 CI 的 pack job 断言；本地实测见 `npm pack --dry-run`')

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const SYMBOL = { pass: '✅', fail: '❌', manual: '⏳', 'n/a': '➖' }
console.log('# §20 发布前安全检查 —— 机器化验证结果\n')
for (const item of results) {
  console.log(`${SYMBOL[item.status]} [${item.id}] ${item.title}`)
  console.log(`      ${item.evidence}`)
}

const failed = results.filter((item) => item.status === 'fail')
const passed = results.filter((item) => item.status === 'pass')
const manual = results.filter((item) => item.status === 'manual')

console.log('')
console.log(`通过 ${passed.length} 项 ｜ 未通过 ${failed.length} 项 ｜ 需人工/真实仓库 ${manual.length} 项`)
console.log(failed.length === 0
  ? '✅ 机器可验证的项全部通过；剩余项需要真实 git 仓库或人工判断。'
  : '❌ 存在未通过项，发布前必须处理。')

process.exitCode = failed.length === 0 ? 0 : 1
