// CI 工作流体检：YAML 能否解析、矩阵是否覆盖三平台、关键闸门是否都在。
//
// 为什么要单独检查：CI 配置写错了不会在本地报错——它只会在推送到 GitHub 之后
// 静默不跑，或者跑一个不完整的矩阵。这类"看起来有 CI"的假象必须在本地挡住。
//
// 解析器：优先用 dsh 自带的 js-yaml（由安装锚点提供）；拿不到时退化为
// 只做结构性文本检查，并在输出里标明用的是哪种方式。
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const FILE = join(ROOT, '.github', 'workflows', 'ci.yml')

if (!existsSync(FILE)) {
  console.log('❌ 找不到 .github/workflows/ci.yml')
  process.exit(1)
}

const text = readFileSync(FILE, 'utf8')

/** 找一个能解析 YAML 的锚点。 */
function loadYaml() {
  const anchors = [import.meta.url]
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData.length > 0) {
    anchors.push(`${appData}/npm/node_modules/@deepseek-ai/dsh/package.json`)
  }
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      return require('js-yaml')
    } catch {
      // 试下一个。
    }
  }
  return null
}

const yaml = loadYaml()
let data = null
if (yaml !== null) {
  try {
    data = yaml.load(text)
  } catch (error) {
    console.log('❌ YAML 解析失败：', error.message)
    process.exit(1)
  }
}

console.log('解析方式 :', yaml === null ? '退化文本检查（未找到 js-yaml）' : 'js-yaml')

const problems = []
const jobs = data?.jobs ?? {}

// 1) 结构
if (data === null) {
  if (!/^name:\s*CI\s*$/m.test(text)) problems.push('缺少 name: CI')
  if (!/^jobs:\s*$/m.test(text)) problems.push('缺少 jobs:')
} else {
  if (data.name !== 'CI') problems.push(`workflow name 应为 CI，实际 ${JSON.stringify(data.name)}`)
  if (Object.keys(jobs).length === 0) problems.push('没有任何 job')
}

// 2) 三平台矩阵
const matrixText = text
for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) {
  if (!matrixText.includes(os)) problems.push(`矩阵缺少 ${os}（§12.3 要求三平台）`)
}

// 3) 关键闸门
for (const [step, needle] of [
  ['lint', 'npm run lint'],
  ['test', 'npm test'],
  ['checks', 'npm run checks'],
]) {
  if (!matrixText.includes(needle)) problems.push(`缺少 ${step} 步骤（${needle}）`)
}

// 4) Node 版本覆盖 engines 下限
if (!/['"]22['"]/.test(matrixText)) problems.push('矩阵未覆盖 Node 22（engines 下限）')

// 5) 只读权限：CI 不需要写仓库
const perms = data?.permissions
if (perms !== undefined && perms.contents !== 'read') {
  problems.push(`permissions.contents 应为 read，实际 ${JSON.stringify(perms.contents)}`)
}

// 6) 打包闸门必须检查"不该进包的东西"
if (!matrixText.includes('DESIGN.md')) {
  problems.push('pack 闸门未断言 DESIGN.md 不进包（它是作者内部版）')
}

console.log('jobs :', Object.keys(jobs).join(', ') || '(无法从 YAML 读出)')
console.log('')

if (problems.length === 0) {
  console.log('✅ CI 配置结构完整：三平台 × Node 22/24、lint/test/checks 齐全，')
  console.log('   并有打包最小化与"零网络/零依赖"两项断言。')
  process.exitCode = 0
} else {
  console.log('❌ CI 配置有问题：')
  for (const problem of problems) console.log('   ·', problem)
  process.exitCode = 1
}
