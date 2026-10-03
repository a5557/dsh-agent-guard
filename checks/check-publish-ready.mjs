// 发布就绪自检：把"发布前该核对什么"变成一条命令，而不是一份要记的清单。
//
// 判据分三类，刻意不混：
//   pass    —— 本机能验证且已满足
//   fail    —— 本机能验证且不满足（阻塞发布）
//   manual  —— 只有作者能做，或只有真实注册表能回答（不假装通过）
//
// 对 npm 只做**只读**查询，而且不经过 npm 自身：本文件沙箱里 `npm` 是 .cmd shim，
// `spawnSync` 必然 EPERM。可用的两条路是「进程内 import」与「直接 spawn node + 把 stdio
// 接到文件描述符」，本脚本只用这两条，因此在本机与 CI 行为一致。绝不登录、绝不发布。
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const results = []
const add = (id, title, status, evidence) => results.push({ id, title, status, evidence })

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * 直接 spawn node，把 stdio 接到文件（管道在本沙箱下 EPERM）。
 *
 * @param {string[]} args - node 参数。
 * @returns {{ok: boolean, out: string}} 退出状态与输出。
 */
function runNode(args) {
  const report = join(ROOT, '.publish-check.tmp')
  const fd = openSync(report, 'w')
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: ['ignore', fd, fd], timeout: 300_000 })
  closeSync(fd)
  let out = ''
  try {
    out = readFileSync(report, 'utf8')
  } catch {
    out = ''
  }
  try {
    const { rmSync } = createRequire(import.meta.url)('node:fs')
    rmSync(report, { force: true })
  } catch { /* 临时文件清不掉不影响判定 */ }
  return { ok: result.status === 0, out }
}

/** 读取 npm 的 userconfig（只读 authToken/registry，绝不写）。 */
function readNpmConfig() {
  const candidates = [join(homedir(), '.npmrc'), join(ROOT, '.npmrc')]
  let authToken = null
  let registry = 'https://registry.npmjs.org/'
  for (const file of candidates) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const auth = /^\s*\/\/[^:]+:\/\/[^/]+\/:_authToken\s*=\s*(\S+)/.exec(line)
      if (auth !== null) authToken = auth[1]
      const reg = /^\s*registry\s*=\s*(\S+)/.exec(line)
      if (reg !== null && registry === 'https://registry.npmjs.org/') registry = reg[1]
    }
  }
  return { authToken, registry }
}

/** 查询注册表上的包（只读 GET）。 */
async function queryRegistry(name) {
  const { authToken, registry } = readNpmConfig()
  const headers = { accept: 'application/vnd.npm.install-v1+json' }
  if (authToken !== null) headers.authorization = `Bearer ${authToken}`
  try {
    const response = await fetch(`${registry.replace(/\/$/, '')}/${encodeURIComponent(name)}`, { headers })
    if (response.status === 404) return { ok: true, taken: false }
    if (!response.ok) return { ok: false, taken: null, detail: `HTTP ${response.status}` }
    const body = await response.json()
    return { ok: true, taken: true, version: body?.['dist-tags']?.latest ?? null }
  } catch (error) {
    return { ok: false, taken: null, detail: error?.cause?.code ?? error?.message ?? String(error) }
  }
}

// ---------------------------------------------------------------------------
// 1) 本地闸门：lint（进程内语法检查）与测试（直接 spawn node）
// ---------------------------------------------------------------------------
{
  const shipped = readdirSync(join(ROOT, 'lib')).filter((name) => name.endsWith('.js')).map((name) => join('lib', name))
    .concat(['bin/guard.mjs'])
  let syntaxBad = null
  for (const file of shipped) {
    const checked = runNode(['--check', file])
    if (!checked.ok) {
      syntaxBad = `${file}: ${checked.out.split('\n').find((line) => line.trim().length > 0) ?? 'syntax error'}`
      break
    }
  }
  const test = runNode(['test/run.mjs'])
  const verdict = /(\d+) passed, (\d+) failed \((\d+) cases\)/.exec(test.out)
  const testOk = test.ok && verdict !== null && verdict[2] === '0'
  add('P1', '本地闸门（语法检查 + 测试）', syntaxBad === null && testOk ? 'pass' : 'fail',
    syntaxBad !== null
      ? `语法检查失败：${syntaxBad}`
      : `语法检查 ${shipped.length} 个文件；测试=${verdict === null ? '无法解析判定行' : `${verdict[1]} passed / ${verdict[2]} failed（${verdict[3]} 用例）`}`)
}

// ---------------------------------------------------------------------------
// 2) 版本与变更记录一致
// ---------------------------------------------------------------------------
{
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const hasEntry = changelog.includes(`[${manifest.version}]`)
  add('P2', 'CHANGELOG 含当前版本条目', hasEntry ? 'pass' : 'fail',
    hasEntry ? `已找到 [${manifest.version}]` : `CHANGELOG 里没有 [${manifest.version}]`)
}

// ---------------------------------------------------------------------------
// 3) 公开身份
// ---------------------------------------------------------------------------
{
  const repo = String(manifest.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
  const bugs = String(manifest.bugs?.url ?? '')
  const urlsOk = repo.startsWith('https://') && bugs.startsWith(`${repo}/issues`)
  add('P3', 'repository / bugs 指向同一仓库', urlsOk ? 'pass' : 'fail', urlsOk ? repo : `repository=${repo} bugs=${bugs}`)

  add('P4', 'author / homepage', manifest.author === undefined ? 'manual' : 'pass',
    manifest.author === undefined
      ? 'author 未填：填它需要真人身份，不能代填（商店卡片会显示作者，建议发布前补上）'
      : `author=${typeof manifest.author === 'string' ? manifest.author : manifest.author.name}；homepage=${manifest.homepage ?? '（未填）'}`)
}

// ---------------------------------------------------------------------------
// 4) 包内容：按 files 白名单在进程内复算（真 tarball 由 CI 的 pack job 断言）
// ---------------------------------------------------------------------------
{
  const listed = Array.isArray(manifest.files) ? manifest.files : []
  const expand = (entry) => {
    const full = join(ROOT, entry)
    if (!existsSync(full)) return []
    if (statSync(full).isFile()) return [entry]
    const out = []
    const walk = (dir, prefix) => {
      for (const dirent of readdirSync(dir, { withFileTypes: true })) {
        if (dirent.name === 'node_modules' || dirent.name.startsWith('.')) continue
        const child = join(dir, dirent.name)
        const rel = `${prefix}${dirent.name}`
        if (dirent.isDirectory()) walk(child, `${rel}/`)
        else out.push(rel)
      }
    }
    walk(full, entry.endsWith('/') ? entry : `${entry}/`)
    return out
  }
  const names = new Set(listed.flatMap(expand).map((name) => name.split(sep).join('/')))
  for (const always of ['package.json', 'README.md', 'LICENSE']) names.add(always)

  const problems = []
  for (const [pattern, why] of [
    [/^node_modules\//, 'node_modules 绝不能进包'],
    [/^test\//, '测试不属于发布产物'],
    [/^\.verify\//, '.verify 草稿绝不能进包'],
    [/^DESIGN\.md$/, 'DESIGN.md 是作者内部版'],
    [/^RELEASE\.md$/, 'RELEASE.md 是作者内部版'],
    [/\.log$|\.bak$|\.tmp$/, '日志/备份/临时文件'],
  ]) {
    for (const name of names) if (pattern.test(name)) problems.push(`${name}：${why}`)
  }
  for (const required of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'rules/default.json', 'README.md', 'LICENSE']) {
    if (!names.has(required)) problems.push(`缺少必需文件：${required}`)
  }
  add('P5', '包内容最小化（files 白名单复算）', problems.length === 0 ? 'pass' : 'fail',
    problems.length === 0
      ? `${names.size} 个文件；无 node_modules / 测试 / 内部文档；真 tarball 由 CI 的 pack job 断言`
      : problems.join('；'))
}

// ---------------------------------------------------------------------------
// 5) 零运行时依赖
// ---------------------------------------------------------------------------
{
  const deps = Object.keys(manifest.dependencies ?? {})
  const optional = Object.keys(manifest.optionalDependencies ?? {})
  add('P6', '零运行时依赖', deps.length + optional.length === 0 ? 'pass' : 'fail',
    deps.length + optional.length === 0 ? 'dependencies 与 optionalDependencies 均为空' : [...deps, ...optional].join(', '))
}

// ---------------------------------------------------------------------------
// 6) 安装契约
// ---------------------------------------------------------------------------
{
  const declares = manifest.dsh?.bundle?.patch !== undefined
  const patch = join(ROOT, 'cordis.patch.yml')
  const ok = declares && existsSync(patch) && statSync(patch).size > 0
  add('P7', 'dsh.bundle.patch 声明且文件非空', ok ? 'pass' : 'fail',
    ok ? `patch=${manifest.dsh.bundle.patch}（${statSync(patch).size} 字节）` : '声明或文件缺失/为空')
}

// ---------------------------------------------------------------------------
// 7) npm：登录状态与名字可用性（只读查询，走配置里的 registry 与 token）
// ---------------------------------------------------------------------------
{
  const { authToken, registry } = readNpmConfig()
  add('P8', 'npm 登录（发布者本人）', authToken === null ? 'manual' : 'pass',
    authToken === null
      ? `未在本机 npm 配置里找到 authToken（registry=${registry}）；发布需要作者本人 npm login，本脚本不代登录`
      : `已在本机 npm 配置中找到凭据（registry=${registry}）`)

  const lookup = await queryRegistry(manifest.name)
  if (!lookup.ok) {
    add('P9', 'npm 包名可用性', 'manual', `查询注册表失败（${lookup.detail}）：无法确认名字是否可用`)
  } else {
    add('P9', 'npm 包名可用性', lookup.taken ? 'fail' : 'pass',
      lookup.taken
        ? `${manifest.name} 已存在于注册表（最新 ${lookup.version}）：确认是自己拥有的包再发布`
        : `${manifest.name} 在注册表上未被占用`)
  }
}

// ---------------------------------------------------------------------------
// 8) 公开面卫生
// ---------------------------------------------------------------------------
{
  const shipped = readdirSync(join(ROOT, 'lib')).filter((name) => name.endsWith('.js'))
    .map((name) => join(ROOT, 'lib', name))
    .concat([join(ROOT, 'README.md'), join(ROOT, 'README.zh.md'), join(ROOT, 'CHANGELOG.md'), join(ROOT, 'SECURITY.md')])
  const localPath = /[A-Za-z]:[\\/](Users|dshplay|DSHapp|tools)[\\/]/i
  const hits = shipped.filter((file) => localPath.test(readFileSync(file, 'utf8')))
  add('P10', '发布产物无本机绝对路径', hits.length === 0 ? 'pass' : 'fail',
    hits.length === 0 ? `检查 ${shipped.length} 个文件` : hits.join(', '))
}

// ---------------------------------------------------------------------------
const width = Math.max(...results.map((result) => result.title.length))
console.log('# 发布就绪自检（只读：不登录、不发布）\n')
for (const result of results) {
  const mark = result.status === 'pass' ? '✅' : result.status === 'fail' ? '❌' : '⏳'
  console.log(`${mark} [${result.id}] ${result.title.padEnd(width)}  ${result.evidence}`)
}
const failed = results.filter((result) => result.status === 'fail').length
const manual = results.filter((result) => result.status === 'manual').length
console.log(`\n通过 ${results.length - failed - manual} 项 ｜ 未通过 ${failed} 项 ｜ 需作者本人 ${manual} 项`)
console.log(failed === 0
  ? '✅ 机器可验证的发布闸门全部通过；剩余项需要作者本人操作（登录/身份字段）。'
  : '❌ 存在未通过项：请先修复再发布。')
process.exitCode = failed === 0 ? 0 : 1
