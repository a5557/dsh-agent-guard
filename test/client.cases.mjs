/**
 * 客户端 bundle 测试。
 *
 * 目的是**真的执行** `lib/client.js` —— 而不是只检查它长什么样。
 * 做法：用 `node:vm` 提供一个最小的浏览器环境（`window.__ModuleLoader__` 与假 `react`），
 * 捕获 bundle 注册的 slot，然后断言注册形态与官方的配对约定一致。
 *
 * 这样可以在没有浏览器、没有构建器的前提下验证：
 * - bundle 形态是否被 `__ModuleLoader__.load` 接受；
 * - 是否注册了 `main`（key）与 `sidebar.panellist`（同值 id）；
 * - 是否注册了 `settings.section`；
 * - UI 里是否**没有**任何修改数据的入口。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const CLIENT_FILE = join(import.meta.dirname, '..', 'lib', 'client.js')

/**
 * 在受控沙箱里执行 bundle，返回它注册的内容。
 *
 * @returns {{id: string|null, exports: object, slots: Array<object>, fetchCalls: string[]}}
 *   执行结果。
 */
function runBundle() {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  const registered = { id: null, exports: null, slots: [], fetchCalls: [] }

  // 极简 React 替身：只提供这个 bundle 用到的 API。
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }

  const window = {
    __ModuleLoader__: {
      load(spec) {
        registered.id = spec.id
        registered.exports = spec.factory((specifier) => {
          if (specifier === 'react') return React
          throw new Error(`unexpected require: ${specifier}`)
        })
      },
    },
    fetch: (url) => {
      registered.fetchCalls.push(url)
      return Promise.resolve({ json: () => Promise.resolve({}) })
    },
  }

  const sandbox = {
    window,
    fetch: window.fetch,
    console: { warn: () => {}, error: () => {} },
  }
  sandbox.globalThis = sandbox

  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

  // 驱动插件体：提供一个只记录注册的 slots 服务。
  const ctx = {
    slots: {
      inject(name, callback) {
        // 官方形态：inject 在合适的时机调用回调完成注册。
        callback()
      },
      register(registration, component) {
        registered.slots.push({ registration, component })
      },
    },
  }
  registered.exports.apply(ctx)
  return { ...registered, React }
}

// ---------------------------------------------------------------------------
// bundle 形态
// ---------------------------------------------------------------------------
test('客户端 bundle 走 __ModuleLoader__.load 且 id 与包名一致', () => {
  const result = runBundle()
  assert.equal(result.id, 'dsh-agent-guard', 'bundle id 必须是包名')
  assert.equal(typeof result.exports.apply, 'function', '必须导出 apply(ctx)')
  assert.ok(Array.isArray(result.exports.inject), '必须导出 inject 数组')
  // vm 里创建的数组来自另一个 realm，deepStrictEqual 会因原型不同而失败，
  // 所以比较值本身。
  assert.equal(JSON.stringify([...result.exports.inject]), JSON.stringify(['slots']), '只需要 slots 服务')
})

test('bundle 文件不含 import/export 语句（浏览器按脚本执行）', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  assert.ok(!/^\s*import\s/m.test(source), '不得含 import 语句')
  assert.ok(!/^\s*export\s/m.test(source), '不得含 export 语句')
})

test('package.json 的 dsh.client 与 exports["./client"] 成对存在', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web', 'dsh.client.platform 必须是 web')
  // 实测：声明了 dsh.client 却没有 exports["./client"] 会在加载期抛错。
  const clientExport = manifest.exports['./client']
  assert.ok(clientExport !== undefined, '必须提供 exports["./client"]，否则加载期抛错')
  assert.equal(clientExport.default, './lib/client.js')
  // dsh.client.inject 是**包名**列表（用于编排其他插件的 bundle），不是服务名。
  // 本插件只用平台种子词 react 与 shell 提供的 ctx.slots，因此不注入任何包。
  assert.equal(manifest.dsh.client.inject, undefined, '不依赖其他插件的 bundle，不应声明 inject')
  // bundle 必须真的随包发布。
  assert.ok(manifest.files.includes('lib/'), 'files 白名单必须包含 lib/（含 client.js）')
})

// ---------------------------------------------------------------------------
// slot 注册形态（官方配对约定）
// ---------------------------------------------------------------------------
test('注册 main（keyed）与 sidebar.panellist（同值 id），构成「点图标开面板」', () => {
  const result = runBundle()
  const main = result.slots.find((entry) => entry.registration.name === 'main')
  const panel = result.slots.find((entry) => entry.registration.name === 'sidebar.panellist')

  assert.ok(main !== undefined, '必须注册 main')
  assert.ok(panel !== undefined, '必须注册 sidebar.panellist')
  assert.equal(typeof main.registration.key, 'string')
  assert.equal(main.registration.key, panel.registration.id, 'main.key 必须等于 panellist.id，否则点图标打不开面板')
  assert.equal(typeof panel.registration.order, 'number')
  assert.equal(typeof panel.registration.label, 'function', 'label 必须是函数（官方形态）')
})

test('注册 settings.section 设置页', () => {
  const result = runBundle()
  const settings = result.slots.find((entry) => entry.registration.name === 'settings.section')
  assert.ok(settings !== undefined, '必须注册设置页')
  assert.equal(typeof settings.registration.id, 'string')
  assert.equal(typeof settings.registration.order, 'number')
})

test('每个注册都带可渲染的组件', () => {
  const result = runBundle()
  assert.equal(result.slots.length, 3, '当前注册三个席位：main / panellist / settings.section')
  for (const entry of result.slots) {
    assert.equal(typeof entry.component, 'function', `${entry.registration.name} 必须带组件`)
  }
})

// ---------------------------------------------------------------------------
// 组件能真的渲染（用 React 替身调用）
// ---------------------------------------------------------------------------
test('面板与设置页组件可渲染，且渲染结果里没有修改数据的入口', () => {
  const result = runBundle()
  for (const entry of result.slots) {
    // 用替身 React 直接调用组件函数（useState/useEffect 已被替换成无副作用版本）。
    const tree = entry.component()
    assert.ok(tree !== null && typeof tree === 'object', `${entry.registration.name} 必须返回元素`)

    const text = JSON.stringify(tree)
    // 禁止的是「一键修改数据」。注意「一键停用护栏」是 §10.1 的**要求**，
    // 所以这里必须精确到"修改数据"的措辞，而不是模糊地禁掉「一键」二字。
    const forbidden = ['删除会话', '自动修复', '自动迁移', '一键修复', '一键迁移', '回滚到该快照']
    for (const phrase of forbidden) {
      assert.ok(!text.includes(phrase), `${entry.registration.name} 不得出现「${phrase}」入口`)
    }
  }
})

test('面板文案明确声明只读与「没有回滚按钮」', () => {
  const result = runBundle()
  const panel = result.slots.find((entry) => entry.registration.name === 'main')
  const text = JSON.stringify(panel.component())
  assert.ok(text.includes('只读'), '面板必须声明只读')
  assert.ok(text.includes('没有回滚按钮'), '面板必须明确说明没有回滚按钮')
})

test('设置页给出「一键停用」的准确做法，并说明关掉备份不放宽拒绝', () => {
  const result = runBundle()
  const settings = result.slots.find((entry) => entry.registration.name === 'settings.section')
  const text = JSON.stringify(settings.component())
  assert.ok(text.includes('cordis.patch.yml'), '必须指出配置写在哪里')
  assert.ok(text.includes('enabled'), '必须给出开关名')
  assert.ok(text.includes('关掉备份不会放宽'), '必须说明关掉备份不放宽拒绝策略')
})

test('图标是内联 SVG，不引用任何外部资源', () => {
  const result = runBundle()
  const icon = result.slots.find((entry) => entry.registration.name === 'sidebar.panellist')
  const tree = icon.component()
  assert.equal(tree.type, 'svg')
  const text = JSON.stringify(tree)
  assert.ok(!/https?:/.test(text), '图标不得引用外部资源')
})
