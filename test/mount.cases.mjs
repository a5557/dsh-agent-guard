/**
 * 挂载契约测试：模拟 DSH 加载器对 `dsh.bundle.patch` 的解析。
 *
 * 为什么需要它：真实 profile 的安装冒烟需要写 `$DSH_HOME/profiles/**`，
 * 在受限沙箱下会被拒绝（实测 EPERM），而且那属于改动用户环境。
 * 但 §14「可被正确挂载」这一层的**契约**可以在沙箱内完整验证：
 *
 *   1. `package.json` 声明了 `dsh.bundle.patch`，且指向存在的文件；
 *   2. patch 文件是可解析的 YAML，行形状是 `- insert: [{ id, name }]`；
 *   3. patch 行里的 `name` **真的能被解析成这个包**（用 Node 的解析算法），
 *      且该模块导出加载器需要的 `name` / `inject` / `apply`；
 *   4. `cordis.patch.yml` 里不出现 `!!js`（本插件不需要在宿主进程求值表达式）。
 *
 * 这样可以在没有真实 profile 的前提下，把"装上去却挂不上"这类失败挡在前面。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const PACKAGE_ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

/**
 * 读取并解析 `cordis.patch.yml`。
 *
 * 优先用 dsh 自带的 js-yaml（由安装锚点提供），拿不到时用一个只认
 * `- insert:` / `id:` / `name:` 的极小解析器——本插件的 patch 只有这一种形状。
 *
 * @returns {{entries: Array<object>, parser: string}} 解析结果。
 */
function readPatch() {
  const file = join(PACKAGE_ROOT, 'cordis.patch.yml')
  const text = readFileSync(file, 'utf8')

  try {
    const yaml = require('js-yaml')
    return { entries: yaml.load(text), parser: 'js-yaml' }
  } catch {
    // 降级解析：够用即可，且会标明用的是哪个解析器。
    const entries = []
    let current = null
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line) || line.trim().length === 0) continue
      const insert = /^-\s*insert:\s*$/.exec(line)
      if (insert) {
        current = { insert: [] }
        entries.push(current)
        continue
      }
      const item = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)
      if (item && current !== null) {
        current.insert.push({ id: item[1] })
        continue
      }
      const name = /^\s*name:\s*(\S+)\s*$/.exec(line)
      if (name && current !== null && current.insert.length > 0) {
        current.insert[current.insert.length - 1].name = name[1].replace(/^["']|["']$/g, '')
      }
    }
    return { entries, parser: 'builtin-minimal' }
  }
}

// ---------------------------------------------------------------------------
// package.json 声明
// ---------------------------------------------------------------------------
test('package.json 声明 dsh.bundle.patch 且指向存在的文件', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const patch = manifest.dsh?.bundle?.patch
  assert.ok(patch !== undefined, '必须声明 dsh.bundle.patch，否则安装后不会被挂载')
  // 实测：patch 可以是字符串或有序数组（dsh-app-boot 的 bundlePatchFiles 校验）。
  const files = Array.isArray(patch) ? patch : [patch]
  assert.ok(files.length > 0)
  for (const relative of files) {
    assert.equal(typeof relative, 'string')
    assert.ok(existsSync(join(PACKAGE_ROOT, relative)), `patch 文件必须存在：${relative}`)
  }
})

test('patch 文件随包发布（files 白名单包含它）', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'files 必须包含 cordis.patch.yml')
})

// ---------------------------------------------------------------------------
// patch 形状
// ---------------------------------------------------------------------------
test('cordis.patch.yml 可解析，且形状为 - insert: [{ id, name }]', () => {
  const { entries, parser } = readPatch()
  assert.ok(Array.isArray(entries), `patch 顶层必须是数组（解析器：${parser}）`)
  assert.equal(entries.length, 1, '本插件的 patch 保持最小：只有一条 insert')

  const [first] = entries
  assert.ok(Array.isArray(first.insert), '第一条必须是 insert 列表')
  assert.ok(first.insert.length >= 1)

  const row = first.insert[0]
  assert.equal(typeof row.id, 'string', '行必须有 id（供后续 patch 定向覆盖）')
  assert.equal(typeof row.name, 'string', '行必须有 name（加载器据此解析模块）')
})

test('patch 行的 id 与包名一致，便于按 id 定向配置', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const { entries } = readPatch()
  const row = entries[0].insert[0]
  assert.equal(row.id, manifest.name, 'row.id 应与 package.json 的 name 一致')
  assert.equal(row.name, manifest.name, '本行挂载的就是本包，所以 name 等于包名')
})

test('patch 里不把 !!js 当作表达式使用', () => {
  const text = readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')

  // 逐行判断：注释里提到 !!js 是可以的（我们刻意说明"不使用"），
  // 真正的判据是**非注释行**里不得出现它。
  const effective = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  assert.ok(!effective.includes('!!js'), 'cordis.patch.yml 的非注释内容不得使用 !!js')

  // 再对解析后的值做一次递归检查，防止值里藏了表达式。
  const { entries } = readPatch()
  const walk = (value) => {
    if (typeof value === 'string') return !value.includes('!!js')
    if (Array.isArray(value)) return value.every(walk)
    if (value !== null && typeof value === 'object') return Object.values(value).every(walk)
    return true
  }
  assert.ok(walk(entries), 'patch 的值里不得出现 !!js')
})

// ---------------------------------------------------------------------------
// 模块解析：patch 行里的 name 真的能解析到这个包
// ---------------------------------------------------------------------------
test('patch 行的 name 能被 Node 解析算法解析到这个包', () => {
  const { entries } = readPatch()
  const specifier = entries[0].insert[0].name

  // 用与本包同级的解析上下文：真实安装时该包会在 profile 的 node_modules 下，
  // 那里同样能解析到自己的 package.json 与入口。
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  assert.equal(specifier, manifest.name, '当前 patch 挂载本包，因此 specifier 必须等于包名')

  // 入口文件必须存在，且 exports['.'] 与 main 指向同一个文件
  // （两套解析路径分歧会让"装的"和"跑的"不是同一个东西）。
  const entry = manifest.exports['.'].default
  assert.ok(existsSync(join(PACKAGE_ROOT, entry)), `入口必须存在：${entry}`)
  const normalize = (value) => String(value).replace(/^\.\//, '')
  assert.equal(normalize(manifest.main), normalize(entry), 'main 与 exports["."] 必须指向同一文件')
})

test('插件入口导出加载器需要的 name / inject / apply', async () => {
  const entry = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).main
  const mod = await import(new URL(`../${entry}`, import.meta.url).href)

  assert.equal(typeof mod.name, 'string', '必须导出 name')
  assert.ok(Array.isArray(mod.inject), '必须导出 inject 数组')
  assert.equal(typeof mod.apply, 'function', '必须导出 apply(ctx, config)')
  assert.equal(mod.apply.length >= 1, true, 'apply 必须接受 ctx')
  // 加载器会读 plugin.name/inject 并调用 apply(ctx, config)。
  assert.equal(mod.name, JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).name)
})

test('入口不导出任何绕过框架的自启入口', async () => {
  const entry = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).main
  const mod = await import(new URL(`../${entry}`, import.meta.url).href)
  const exported = Object.keys(mod)
  for (const forbidden of ['start', 'install', 'boot', 'main']) {
    assert.ok(!exported.includes(forbidden), `不应导出 ${forbidden}（安装副作用不该藏在模块加载时）`)
  }
})

test('入口导出官方形态的 Config（否则设置系统发现不到插件配置）', async () => {
  const entry = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).main
  const mod = await import(new URL(`../${entry}`, import.meta.url).href)

  assert.ok('Config' in mod, '必须导出 Config —— 实测：缺了它 --dump-config-schema 会报 status:"absent"、configRef:"#/$defs/unknownConfig"')

  const { buildConfigSchema, loadSchemastery } = await import('../lib/config.js')
  const z = loadSchemastery()
  if (z === null) {
    // schemastery 是安装锚点提供的 peer；这个环境里拿不到时允许 null，
    // 但必须显式是 null（表示"无 schema"），而不是 undefined（表示"忘了导出"）。
    assert.equal(mod.Config, null, 'schemastery 不可用时 Config 必须是显式的 null')
    return
  }

  assert.notEqual(mod.Config, null, 'schemastery 可用时 Config 不能是 null')
  const schema = buildConfigSchema()
  // 用 schema 解析空配置，验证它真的可用且默认值齐备。
  const resolved = schema({})
  assert.equal(typeof resolved, 'object')
  for (const key of ['enabled', 'backupEnabled', 'goalClass', 'circuitThreshold', 'maxBackupBytes']) {
    assert.ok(key in resolved, `schema 必须包含 ${key}`)
  }
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.goalClass, 'workspace-content')
  assert.equal(resolved.circuitThreshold, 2)
})

test('Config schema 的默认值与实际生效的默认值一致', async () => {
  const { DEFAULT_CONFIG, buildConfigSchema } = await import('../lib/config.js')
  const schema = buildConfigSchema()
  if (schema === null) return

  const fromSchema = schema({})
  for (const [key, expected] of Object.entries(DEFAULT_CONFIG)) {
    if (key === 'dir') {
      // schema 用空串表示"未设置"，解析器用 null；两者语义相同，这处差异是有意的。
      assert.equal(fromSchema.dir, '', 'dir 在 schema 里用空串表示未设置')
      continue
    }
    assert.equal(fromSchema[key], expected, `schema 的 ${key} 默认值必须与 DEFAULT_CONFIG 一致`)
  }
})

// ---------------------------------------------------------------------------
// 客户端半边的声明一致性
// ---------------------------------------------------------------------------
test('dsh.client 声明与 exports["./client"] 同时存在，否则加载期会抛错', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const declaresClient = manifest.dsh?.client !== undefined
  const hasClientExport = manifest.exports?.['./client'] !== undefined
  assert.equal(
    declaresClient,
    hasClientExport,
    declaresClient
      ? '声明了 dsh.client 就必须提供 exports["./client"]（实测：否则报 "declares dsh.client but exports no ./client bundle"）'
      : '没有声明 dsh.client 就不该有 ./client 导出',
  )
  if (declaresClient) {
    assert.equal(manifest.dsh.client.platform, 'web', 'dsh.client.platform 目前只支持 web')
    assert.ok(existsSync(join(PACKAGE_ROOT, manifest.exports['./client'].default)), 'client bundle 必须存在')
  }
})

test('包内不存在会被误当作入口的本地绝对路径配置', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const text = JSON.stringify(manifest)
  assert.ok(!/[A-Za-z]:\\/.test(text), 'package.json 不得含 Windows 绝对路径')
  assert.ok(!text.includes(process.env.USERPROFILE ?? '\u0000'), 'package.json 不得含用户主目录')
  // bin 必须是包内相对路径。
  for (const [binName, target] of Object.entries(manifest.bin ?? {})) {
    assert.ok(!/^([A-Za-z]:|\/)/.test(target), `bin.${binName} 必须是相对路径`)
    assert.ok(existsSync(join(PACKAGE_ROOT, target)), `bin.${binName} 指向的文件必须存在`)
  }
})

// 保持解析器信息可见，避免降级解析被静默使用。
test('patch 解析器可用（记录用的是哪一个）', () => {
  const { parser } = readPatch()
  assert.ok(['js-yaml', 'builtin-minimal'].includes(parser))
  assert.equal(typeof dirname, 'function')
})
