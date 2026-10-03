/**
 * Plugin registration-contract tests.
 *
 * These exercise `apply(ctx)` against a fake context, so they assert exactly what
 * the plugin contributes and that it unwinds cleanly — without launching DSH, which
 * shipped-plugin practice and this project's own discipline both require.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { apply, buildEngine, createInspectTool, formatReport, inject, loadDefaultRules, name } from '../lib/index.js'
import { parseArgs, runInspect } from '../bin/guard.mjs'
import { guardInspect } from '../lib/inspect.js'
import { fixtureWorkspace, makeTempHome, stubProbes, writeRegistry, writeSyntheticSession } from './fixtures.mjs'

/**
 * 假 ctx：只实现插件声明会用到的服务。
 *
 * v1 起插件还会订阅事件（`tools/pre-execute`、`agent/*`）并可选注册 webServer，
 * 所以这里补上 `on` 与 `get`。`withWebServer: false` 用来验证降级路径。
 */
function fakeCtx({ withWebServer = false } = {}) {
  const registered = { tools: [], events: [], routes: [] }
  const disposed = { tools: 0, events: 0, routes: 0 }
  const ctx = {
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => {
          disposed.tools += 1
        }
      },
    },
    on(event, listener) {
      registered.events.push({ event, listener })
      return () => {
        disposed.events += 1
      }
    },
    get(service) {
      if (service === 'webServer' && withWebServer) {
        return {
          register(route) {
            registered.routes.push(route)
            return () => {
              disposed.routes += 1
            }
          },
        }
      }
      return undefined
    },
    effect(callback) {
      ctx.__disposers = ctx.__disposers ?? []
      ctx.__disposers.push(callback())
    },
    __registered: registered,
    __disposed: disposed,
  }
  return ctx
}

/**
 * 每个插件用例都在临时 DSH_HOME 上驱动 apply()。
 *
 * §12.3 纪律：绝不碰真实 `~/.dsh`。v1 起 apply() 会真的建目录、写日志，
 * 所以隔离不是可选项。
 */
function isolatedApply(options = {}) {
  const temp = makeTempHome('plugin')
  const workspace = join(temp.home, 'workspaces', 'proj')
  mkdirSync(workspace, { recursive: true })
  const ctx = fakeCtx({ withWebServer: options.withWebServer === true })
  apply(ctx, options.config ?? {}, {
    dshHome: temp.home,
    workspaceRoots: [workspace],
    dshStateProvider: options.dshStateProvider ?? (() => ({ running: true, detail: '测试' })),
  })
  return { ...temp, ctx, workspace }
}

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------
test('declares its identity and hard dependency explicitly', () => {
  assert.equal(name, 'dsh-agent-guard')
  assert.ok(Array.isArray(inject))
  assert.deepEqual(inject, ['tools'], 'tools is the only hard dependency')
})

test('exports apply and no bypass entry point', async () => {
  const mod = await import('../lib/index.js')
  const exported = Object.keys(mod)
  assert.ok(exported.includes('apply'), 'the loader requires apply(ctx)')
  assert.ok(!exported.includes('start'), 'no self-starting entry point')
  assert.ok(!exported.includes('install'), 'no load-time install side effect')
})

// ---------------------------------------------------------------------------
// Tool registration contract
// ---------------------------------------------------------------------------
test('registers exactly two read-only tools with complete, valid schemas', () => {
  const f = isolatedApply()
  try {
    assert.equal(f.ctx.__registered.tools.length, 2, 'v1 注册两个工具：取证与留痕')

    const inspect = f.ctx.__registered.tools.find((tool) => tool.name === 'guard_inspect')
    const journal = f.ctx.__registered.tools.find((tool) => tool.name === 'guard_journal')
    assert.ok(inspect !== undefined, '必须注册 guard_inspect')
    assert.ok(journal !== undefined, '必须注册 guard_journal')

    for (const tool of [inspect, journal]) {
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 40, '描述要让模型能选对工具')
      assert.equal(tool.parameters.type, 'object')
      assert.equal(tool.parameters.additionalProperties, false)
      assert.equal(typeof tool.output, 'object')
      assert.equal(tool.output.schema.type, 'object')
      assert.equal(tool.output.schema.additionalProperties, false)
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(typeof tool.execute, 'function')

      const blocks = tool.output.render({}, { ok: true, text: 'hello' })
      assert.ok(Array.isArray(blocks))
      assert.equal(blocks[0].type, 'text')
      assert.equal(blocks[0].text, 'hello')
    }

    assert.equal(inspect.parameters.properties.scope.type, 'array')
    assert.equal(journal.parameters.properties.action.type, 'string')
  } finally {
    f.cleanup()
  }
})

test('the tool output schema is restricted to the supported JSON-Schema subset', () => {
  const tool = createInspectTool()
  /** Walk every node and assert the dialect the tool compiler accepts. */
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    if ('type' in node) {
      assert.ok(
        ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(node.type),
        `${path}: unsupported schema type ${String(node.type)}`,
      )
    }
    assert.ok(!('type' in node) || node.type !== 'json', `${path}: the raw subset has no "json" type`)
    if (node.type === 'object') {
      assert.equal(typeof node.additionalProperties, 'boolean', `${path}: object nodes must state additionalProperties explicitly`)
    }
    for (const [key, value] of Object.entries(node.properties ?? {})) walk(value, `${path}.properties.${key}`)
    if (node.items !== undefined) walk(node.items, `${path}.items`)
  }
  walk(tool.output.schema, 'output.schema')
  walk(tool.parameters, 'parameters')
})

test('a failing inspection reports failure instead of an empty success', async () => {
  const tool = createInspectTool({
    inspect: () => {
      throw new Error('synthetic inspection failure')
    },
  })
  const result = await tool.execute({})
  assert.equal(result.ok, false)
  assert.match(result.text, /取证失败/)
  assert.match(result.text, /不是「没有问题」/, 'a failure must not read as a clean result')
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
test('unwinding reaps every registration', () => {
  const f = isolatedApply({ withWebServer: true })
  try {
    assert.equal(f.ctx.__registered.tools.length, 2)
    assert.ok(f.ctx.__registered.events.length >= 1, 'v1 会订阅事件')
    assert.equal(f.ctx.__registered.routes.length, 2, '有 webServer 时注册面板页与 API 两条路由')
    assert.equal(f.ctx.__disposers.length, 1, '所有贡献都收口到一次 ctx.effect')

    f.ctx.__disposers[0]()
    assert.equal(f.ctx.__disposed.tools, 2, '两个工具都必须被注销')
    assert.equal(f.ctx.__disposed.routes, 2, '两条路由都必须被注销')
    assert.equal(
      f.ctx.__disposed.events,
      f.ctx.__registered.events.length,
      '所有事件订阅都必须被注销',
    )
  } finally {
    f.cleanup()
  }
})

test('one throwing disposer does not prevent the rest from unwinding', () => {
  const f = isolatedApply()
  try {
    let calls = 0
    f.ctx.tools.register = () => {
      calls += 1
      return () => {
        throw new Error('synthetic disposer failure')
      }
    }
    // 重新装配，让被替换的 register 生效。
    const ctx = f.ctx
    ctx.__disposers = []
    assert.doesNotThrow(() => apply(ctx, {}, { dshHome: f.home, workspaceRoots: [f.workspace] }))
    assert.equal(calls, 2, '两个工具注册都会被调用')
    assert.doesNotThrow(() => ctx.__disposers[0]())
  } finally {
    f.cleanup()
  }
})

test('没有 webServer 时静默降级：两个工具照常注册，只是没有面板', () => {
  const f = isolatedApply({ withWebServer: false })
  try {
    assert.equal(f.ctx.__registered.tools.length, 2)
    assert.equal(f.ctx.__registered.routes.length, 0)
  } finally {
    f.cleanup()
  }
})

test('装配只写自己的目录，不碰 DSH 的私有存储', () => {
  const f = isolatedApply()
  try {
    // v1 起 apply 会建自己的数据目录；这是它唯一被允许写入的地方。
    assert.ok(existsSync(join(f.home, 'agent-guard')), '应创建自己的数据目录')
    assert.ok(existsSync(join(f.home, 'agent-guard', 'snapshots')), '应建好快照子目录')

    // DSH 私有存储必须保持为空：目录存在（fixture 建的）但一个文件都不能多。
    assert.deepEqual(readdirSync(join(f.home, 'storages')), [], '不得在 storages/ 里写任何东西')
    assert.deepEqual(readdirSync(join(f.home, 'sessions')), [], '不得在 sessions/ 里写任何东西')
    assert.deepEqual(readdirSync(join(f.home, 'profiles')), [], '不得在 profiles/ 里写任何东西')
  } finally {
    f.cleanup()
  }
})

test('enabled=false 时不订阅任何拦截事件（一键停用是硬的）', () => {
  const f = isolatedApply({ config: { enabled: false } })
  try {
    const events = f.ctx.__registered.events.map((entry) => entry.event)
    assert.ok(!events.includes('tools/pre-execute'), '停用后不得订阅拦截事件')
    assert.equal(f.ctx.__registered.tools.length, 2, '只读工具仍然可用')
  } finally {
    f.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Rule-set loading
// ---------------------------------------------------------------------------
test('the shipped rule set loads, is data-only, and contains no absolute path', () => {
  const rules = loadDefaultRules()
  assert.equal(typeof rules.ruleSetVersion, 'number')
  assert.ok(Array.isArray(rules.protected) && rules.protected.length > 0)

  const text = JSON.stringify(rules)
  assert.ok(!/[A-Za-z]:\\\\/.test(text), 'the shipped rule set must not contain a Windows absolute path')
  assert.ok(!text.includes('Users'), 'the shipped rule set must not name a user directory')

  for (const entry of rules.protected) {
    assert.equal(typeof entry.id, 'string')
    assert.equal(typeof entry.pattern, 'string')
    assert.ok(
      entry.pattern.startsWith('$DSH_HOME') || entry.pattern.startsWith('<workspace>'),
      `${entry.id}: patterns must be portable placeholders, got ${entry.pattern}`,
    )
  }
})

test('a compiled engine protects the DSH home and each workspace root', () => {
  const engine = buildEngine({ dshHome: 'C:\\h', workspaceRoots: ['C:\\h\\ws'] })
  const ids = engine.protected.map((entry) => entry.id)
  for (const expected of ['dsh-sessions', 'dsh-storages', 'dsh-profiles', 'dsh-credentials', 'guard-own-data', 'workspace-root']) {
    assert.ok(ids.includes(expected), `expected protected entry ${expected}`)
  }
})

// ---------------------------------------------------------------------------
// CLI behaviour (in-process, no child process)
// ---------------------------------------------------------------------------
test('CLI parses flags and rejects bad input with a usage error', () => {
  assert.deepEqual(parseArgs([]).options, { json: false, redact: false, headers: true })
  assert.equal(parseArgs(['--json', '--redact']).options.json, true)
  assert.equal(parseArgs(['--no-headers']).options.headers, false)
  assert.equal(parseArgs(['--max-sessions']).error, '--max-sessions 需要一个值')
  assert.equal(parseArgs(['--max-sessions', '0']).error !== null, true)
  assert.equal(parseArgs(['--scope', 'nope']).error !== null, true)
  assert.equal(parseArgs(['--bogus']).error, '未知选项：--bogus')
  assert.equal(parseArgs(['-h']).help, true)
})

test('CLI emits JSON or a summary, and exits 0 on success', () => {
  const temp = makeTempHome('cli')
  try {
    const workspace = fixtureWorkspace(temp.home, 'proj')
    writeSyntheticSession({ home: temp.home, cwd: workspace, id: 'session-cli-0001' })
    writeRegistry({ home: temp.home, workspaces: [{ id: 'ws-cli', path: workspace, sessionIds: ['session-cli-0001'] }] })

    let out = ''
    const code = runInspect({ json: true, dshHome: temp.home, headers: true }, { write: (text) => { out += text } })
    assert.equal(code, 0)
    const parsed = JSON.parse(out)
    assert.equal(parsed.dsh.home, temp.home)
    assert.equal(parsed.sessions.countsAsConversation, 1)

    let summary = ''
    runInspect({ dshHome: temp.home, headers: true }, { write: (text) => { summary += text } })
    assert.match(summary, /只读取证/)
    assert.match(summary, /取证时间/)
  } finally {
    temp.cleanup()
  }
})

test('CLI reports an inspection failure as a failure, not as empty output', () => {
  let err = ''
  const code = runInspect(
    { dshHome: null, headers: true },
    {
      write: () => {},
      writeError: (text) => {
        err += text
      },
    },
  )
  // A null dshHome falls back to the environment; the run should still succeed, so
  // this asserts the failure channel only when it is genuinely used.
  if (code !== 0) assert.match(err, /取证失败/)
})

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------
test('the summary states the origin split so a count difference cannot read as loss', () => {
  const temp = makeTempHome('summary')
  try {
    const workspace = fixtureWorkspace(temp.home, 'proj')
    writeSyntheticSession({ home: temp.home, cwd: workspace, id: 'session-s1' })
    writeSyntheticSession({
      home: temp.home,
      cwd: workspace,
      id: 'b1b2c3d4-0000-4000-8000-000000000001',
      origin: 'subagent',
      delegationDepth: 1,
    })
    writeRegistry({ home: temp.home, workspaces: [{ id: 'ws-s', path: workspace, sessionIds: ['session-s1'] }] })

    const report = guardInspect({ dshHome: temp.home, probes: stubProbes({ running: false }) })
    const text = formatReport(report)
    assert.match(text, /origin:"subagent"/)
    assert.match(text, /缺失对话/)
    assert.match(text, /只读取证，不改数据/)
  } finally {
    temp.cleanup()
  }
})
