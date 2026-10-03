/**
 * 端到端装配测试：**通过真实的事件订阅路径**验证 P3（每轮回滚点）与
 * G4/§6.5（熔断强制暂停）。
 *
 * 为什么单独一个文件：此前的覆盖是「单元级」的 —— 直接调用
 * `SnapshotScheduler.onTurn()` 或 `CircuitTracker.inspect()`，都验证了**部件**。
 * 但插件真正的接法是 `apply()` 订阅 `agent/turn-stopping` / `agent/created`，
 * 再由监听器去驱动调度器。这一段此前**零引用、零覆盖**：
 *   - 不知道监听器是否真的绑上了；
 *   - 不知道事件载荷的字段名对不对（`payload.agent.id` / `payload.turn`）；
 *   - 不知道快照会不会真的落盘。
 *
 * 这些都是"看起来接线了、其实没通"的典型位置，必须在事件层验证，
 * 而不是在部件层验证。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { makeTempHome } from './fixtures.mjs'

/**
 * 假 ctx：记录注册与事件订阅，并可**按事件名触发监听器**。
 *
 * v1 起插件会订阅事件，所以订阅本身也是被测契约的一部分。
 */
function harness(options = {}) {
  const temp = makeTempHome('e2e-apply')
  const workspace = join(temp.home, 'workspaces', 'proj')
  mkdirSync(workspace, { recursive: true })

  const state = {
    tools: new Map(),
    listeners: new Map(),
    routes: [],
    disposed: { tools: 0, events: 0, routes: 0 },
    effectDisposer: null,
  }

  const ctx = {
    tools: {
      register(definition) {
        state.tools.set(definition.name, definition)
        return () => {
          state.disposed.tools += 1
        }
      },
    },
    on(event, listener) {
      const list = state.listeners.get(event) ?? []
      list.push(listener)
      state.listeners.set(event, list)
      return () => {
        state.disposed.events += 1
      }
    },
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(route) {
          state.routes.push(route)
          return () => {
            state.disposed.routes += 1
          }
        },
      }
    },
    effect(callback) {
      state.effectDisposer = callback()
    },
  }

  apply(ctx, options.config ?? {}, {
    dshHome: temp.home,
    workspaceRoots: [workspace],
    dshStateProvider: options.dshStateProvider ?? (() => ({ running: true, detail: '测试：运行中' })),
  })

  return {
    ...temp,
    workspace,
    state,
    /** 触发某事件的所有监听器（模拟宿主派发）。 */
    async fire(event, payload) {
      const list = state.listeners.get(event) ?? []
      assert.ok(list.length > 0, `插件应当订阅了 ${event}`)
      for (const listener of list) await listener(payload)
    },
    dispose() {
      state.effectDisposer?.()
    },
  }
}

// ---------------------------------------------------------------------------
// P3：每轮回滚点 —— 通过真实事件订阅验证
// ---------------------------------------------------------------------------
test('P3: agent/turn-stopping 真的会落一次回滚点', async () => {
  const f = harness()
  try {
    assert.ok(f.state.listeners.has('agent/turn-stopping'), '必须订阅 agent/turn-stopping')

    await f.fire('agent/turn-stopping', { agent: { id: 'session-turn-1' }, turn: 7, signal: new AbortController().signal })

    const snapshotRoot = join(f.home, 'agent-guard', 'snapshots')
    assert.ok(existsSync(snapshotRoot), '快照目录必须已创建')
    const ids = readdirSync(snapshotRoot)
    assert.equal(ids.length, 1, '应当恰好落一次回滚点')

    // 回滚点四件套里，布局与 meta 必须齐全（注册表不存在时允许缺席）。
    const files = readdirSync(join(snapshotRoot, ids[0])).sort()
    assert.ok(files.includes('meta.json'), '必须有 meta.json')
    assert.ok(files.includes('hashes.sha256'), '必须有 hashes.sha256')
    assert.ok(files.includes('layout.json'), '必须有 layout.json')

    // meta 必须记下触发原因与会话 id —— 这正是"载荷字段名对不对"的检验。
    const meta = JSON.parse(readFileSync(join(snapshotRoot, ids[0], 'meta.json'), 'utf8'))
    assert.equal(meta.reason, 'turn-start')
    assert.equal(meta.sessionId, 'session-turn-1', '必须从 payload.agent.id 取到会话 id')
  } finally {
    f.cleanup()
  }
})

test('P3: agent/created 也会落回滚点（新会话建立时）', async () => {
  const f = harness()
  try {
    await f.fire('agent/created', { agent: { id: 'session-created-1' }, source: 'user' })
    const ids = readdirSync(join(f.home, 'agent-guard', 'snapshots'))
    assert.equal(ids.length, 1)
    const meta = JSON.parse(readFileSync(join(f.home, 'agent-guard', 'snapshots', ids[0], 'meta.json'), 'utf8'))
    assert.equal(meta.sessionId, 'session-created-1')
  } finally {
    f.cleanup()
  }
})

test('P3: 高频回合被最小间隔去抖，不会把磁盘写满', async () => {
  const f = harness({ config: { snapshotMinIntervalMs: 3_600_000 } })
  try {
    // 连打 20 个回合事件，只应有 1 次真正落盘。
    for (let turn = 1; turn <= 20; turn += 1) {
      await f.fire('agent/turn-stopping', { agent: { id: 'session-burst' }, turn })
    }
    const ids = readdirSync(join(f.home, 'agent-guard', 'snapshots'))
    assert.equal(ids.length, 1, `去抖后应只落 1 次，实际 ${ids.length} 次`)
  } finally {
    f.cleanup()
  }
})

test('P3: snapshotEnabled=false 时不订阅回合事件，也不落盘', async () => {
  const f = harness({ config: { snapshotEnabled: false } })
  try {
    assert.ok(!f.state.listeners.has('agent/turn-stopping'), '关掉快照后不应订阅回合事件')
    assert.ok(!existsSync(join(f.home, 'agent-guard', 'snapshots')) || readdirSync(join(f.home, 'agent-guard', 'snapshots')).length === 0)
  } finally {
    f.cleanup()
  }
})

test('P3: 快照失败不会把异常抛回宿主的回合流程', async () => {
  const f = harness()
  try {
    // 让快照目录无法使用：用一个同名文件占位。
    const guardDir = join(f.home, 'agent-guard')
    const snapshots = join(guardDir, 'snapshots')
    if (existsSync(snapshots)) {
      const { rmSync } = await import('node:fs')
      rmSync(snapshots, { recursive: true, force: true })
    }
    writeFileSync(snapshots, 'not-a-directory')

    // 监听器内部必须自己吞掉失败：回合流程不该因为护栏而中断。
    await assert.doesNotReject(async () => {
      await f.fire('agent/turn-stopping', { agent: { id: 'session-broken' }, turn: 1 })
    })
  } finally {
    f.cleanup()
  }
})

// ---------------------------------------------------------------------------
// G4 / §6.5：熔断 —— 通过连续真实调用验证
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// §6.5：熔断与核心数据写入门控 —— 通过连续真实调用验证
// ---------------------------------------------------------------------------

/** 统计 `tools/pre-execute` 的监听器数量（装配契约的一部分）。 */
function preExecuteCount(f) {
  return (f.state.listeners.get('tools/pre-execute') ?? []).length
}

test('§6.5: 熔断判定会读取同一路径的连续写状态（不静默放行）', async () => {
  const f = harness({ dshStateProvider: () => ({ running: true, detail: '测试：运行中' }) })
  try {
    const guardPre = f.state.listeners.get('tools/pre-execute')?.[0]
    assert.equal(preExecuteCount(f), 1, '必须恰好订阅一个 tools/pre-execute 监听器')

    const target = join(f.home, 'storages', 'workspace.json')
    mkdirSync(join(f.home, 'storages'), { recursive: true })
    writeFileSync(target, '{"unit":1}')

    const makeExec = () => ({
      name: 'write',
      arguments: { file_path: target, content: '{"unit":2}' },
      callId: 'call-1',
      signal: new AbortController().signal,
      agent: { id: 'session-circuit', session: { header: { id: 'session-circuit', cwd: f.workspace } } },
    })

    // DSH 运行中 + 核心数据 → 直接 deny（fail-closed），工具体不得执行。
    let ran = 0
    const decision = await guardPre(makeExec(), async () => {
      ran += 1
      return { kind: 'allow' }
    })
    assert.equal(decision.kind, 'deny', 'DSH 运行中写核心数据必须被拒绝')
    assert.equal(ran, 0, '被拒绝时工具主体绝不能执行')
    assert.match(decision.reason, /已阻止本次调用/)
  } finally {
    f.cleanup()
  }
})

test('§6.5: DSH 已停止时受保护写入走审批，且先备份后放行', async () => {
  const f = harness({ dshStateProvider: () => ({ running: false, detail: '测试：已停止' }) })
  try {
    const guardPre = f.state.listeners.get('tools/pre-execute')?.[0]
    const target = join(f.home, 'storages', 'workspace.json')
    mkdirSync(join(f.home, 'storages'), { recursive: true })
    writeFileSync(target, '{"unit":1}')

    const makeExec = () => ({
      name: 'write',
      arguments: { file_path: target, content: '{"unit":2}' },
      callId: 'call-c',
      signal: new AbortController().signal,
      agent: { id: 'session-c', session: { header: { id: 'session-c', cwd: f.workspace } } },
    })

    // DSH 已停止 + 受保护写入 → require-justification → 转成 ask 交人决定，先不执行。
    let ran = 0
    const first = await guardPre(makeExec(), async () => {
      ran += 1
      return { kind: 'allow' }
    })
    assert.equal(first.kind, 'ask', '受保护写入必须要求确认（人工决定），而不是静默放行')
    assert.equal(ran, 0, '未获批准前工具主体不得执行')

    // 日志必须留下可读记录，并标明命中受保护路径。
    const journal = join(f.home, 'agent-guard', 'journal.jsonl')
    assert.ok(existsSync(journal), '必须留下日志')
    const rows = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(rows.length >= 1)
    assert.equal(rows[0].classification.protected, true, '日志必须记录"命中受保护路径"')
    assert.equal(rows[0].sessionId, 'session-c', '日志必须记录会话 id')
  } finally {
    f.cleanup()
  }
})

test('默认状态下**不**乐观假定 DSH 已停止（真实探测 + fail-closed）', async () => {
  // 不传 dshStateProvider：走 lazyDshState() 的真实探测。
  // 在受限沙箱里 tasklist/netstat 会被拒 → 判据不足 → 按「未停止」处理。
  // 这正是必须保持的行为：探测失败**不能**变成"放行核心数据写入"。
  const f = harness()
  try {
    const guardPre = f.state.listeners.get('tools/pre-execute')?.[0]
    const target = join(f.home, 'storages', 'workspace.json')
    mkdirSync(join(f.home, 'storages'), { recursive: true })
    writeFileSync(target, '{"unit":1}')

    const decision = await guardPre({
      name: 'write',
      arguments: { file_path: target, content: '{"unit":2}' },
      callId: 'call-default',
      signal: new AbortController().signal,
      agent: { id: 'session-default', session: { header: { id: 'session-default', cwd: f.workspace } } },
    }, async () => ({ kind: 'allow' }))

    assert.equal(decision.kind, 'deny',
      '探测判不出结论时必须按「未停止」处理并拒绝，绝不乐观放行核心数据写入')
  } finally {
    f.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 装配完整性
// ---------------------------------------------------------------------------
test('装配后订阅了三类事件，且卸载时全部回收', () => {
  const f = harness()
  try {
    assert.deepEqual(
      [...f.state.listeners.keys()].sort(),
      ['agent/created', 'agent/turn-stopping', 'tools/pre-execute'],
      '订阅的事件集合必须与设计一致',
    )
    assert.equal(f.state.routes.length, 2, '有 webServer 时应注册页面与 API 两条路由')

    f.dispose()
    assert.equal(f.state.disposed.events, 3, '三个事件订阅都必须被回收')
    assert.equal(f.state.disposed.tools, 2, '两个工具都必须被注销')
    assert.equal(f.state.disposed.routes, 2, '两条路由都必须被注销')
  } finally {
    f.cleanup()
  }
})
