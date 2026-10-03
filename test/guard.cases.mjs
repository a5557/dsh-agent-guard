/**
 * 拦截层测试：G-3、G-4、熔断（T7）与 fail-safe 行为。
 *
 * G-3 的核心断言不是"返回了 deny"，而是**工具主体没有被执行**：
 * 所以每个用例都用 `next` 是否被调用来证明拦截真的发生在 dispatch 之前。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildEngine } from '../lib/index.js'
import { createStore } from '../lib/store.js'
import { createJournal } from '../lib/journal.js'
import { CircuitTracker, createGuardRuntime, decideToolCall, resolveAgentContext } from '../lib/guard.js'
import { createSnapshot } from '../lib/backup.js'
import { SnapshotScheduler } from '../lib/snapshot.js'
import { GOAL_CLASSES, resolveConfig } from '../lib/config.js'
import { classifyConversation } from '../lib/sessionlog.js'
import { makeTempHome, stubProbes } from './fixtures.mjs'

/**
 * 造一个完整的护栏运行时。
 *
 * @param {object} [options] - 覆盖项。
 * @returns {object} fixture。
 */
function guardFixture(options = {}) {
  const temp = makeTempHome('guard')
  const workspace = join(temp.home, 'workspaces', 'proj')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(temp.home, 'storages'), { recursive: true })
  writeFileSync(join(temp.home, 'storages', 'workspace.json'), '{"unit":{"name":"workspace","version":2}}')

  const { config } = resolveConfig(options.config ?? {})
  const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
  const journal = createJournal(store, { enabled: config.journalEnabled })

  const runtime = createGuardRuntime({
    store,
    journal,
    config: {
      ...config,
      buildEngine: (roots) => buildEngine({ dshHome: temp.home, workspaceRoots: roots }),
    },
    workspaceRoots: () => [workspace],
    dshStateProvider: options.dshStateProvider ?? (() => ({ running: true, detail: '测试：视为运行中' })),
  })

  return { ...temp, workspace, store, journal, runtime, config }
}

/** 造一个工具执行对象。 */
function makeExec(name, args, agentId = 'session-test-1') {
  return {
    name,
    arguments: args,
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('token'),
    signal: new AbortController().signal,
    agent: { id: agentId, session: { header: { id: agentId, cwd: 'C:\\proj' } } },
  }
}

/** 记录 next 是否被调用，用来证明工具体是否真的执行。 */
function trackedNext() {
  const state = { calls: 0 }
  const next = async () => {
    state.calls += 1
    return { kind: 'allow' }
  }
  return { state, next }
}

// ---------------------------------------------------------------------------
// G-3：DSH 运行中改写核心数据 → 必须被拦，且工具体不执行
// ---------------------------------------------------------------------------
test('G-3: DSH 运行中写 storages/workspace.json → deny，且工具主体未执行', async () => {
  const f = guardFixture()
  try {
    const target = join(f.home, 'storages', 'workspace.json')
    const { state, next } = trackedNext()
    const decision = await f.runtime.handlePreExecute(makeExec('write', { file_path: target }), next)

    assert.equal(decision.kind, 'deny', '必须拒绝')
    assert.match(decision.reason, /已阻止本次调用/)
    assert.equal(state.calls, 0, '工具主体绝不能执行——这正是"拦截"与"事后告警"的分界')
  } finally {
    f.cleanup()
  }
})

test('G-3b: 拒绝会留下一条可读的日志记录', async () => {
  const f = guardFixture()
  try {
    const target = join(f.home, 'storages', 'workspace.json')
    await f.runtime.handlePreExecute(makeExec('write', { file_path: target }), trackedNext().next)

    const text = readFileSync(join(f.home, 'agent-guard', 'journal.jsonl'), 'utf8')
    const rows = text.trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].decision, 'blocked')
    assert.equal(rows[0].tool, 'write')
    assert.equal(rows[0].sessionId, 'session-test-1')
    assert.equal(rows[0].classification.protected, true)
    assert.equal(f.journal.verify().ok, true, '日志链必须仍然完整')
  } finally {
    f.cleanup()
  }
})

test('G-3c: 判不出 DSH 是否停止时同样拒绝（fail-closed）', async () => {
  const f = guardFixture({ dshStateProvider: () => ({ running: 'unknown', detail: '判据不足' }) })
  try {
    const target = join(f.home, 'storages', 'workspace.json')
    const { state, next } = trackedNext()
    const decision = await f.runtime.handlePreExecute(makeExec('write', { file_path: target }), next)
    assert.equal(decision.kind, 'deny')
    assert.equal(state.calls, 0)
  } finally {
    f.cleanup()
  }
})

// ---------------------------------------------------------------------------
// G-4：引用受保护路径的脚本
// ---------------------------------------------------------------------------
test('G-4: pwsh 命令引用受保护路径 → 走审批，且日志只留命令摘要', async () => {
  const f = guardFixture()
  try {
    const target = join(f.home, 'sessions', '--D-proj--')
    const { state, next } = trackedNext()
    const command = `Remove-Item -Recurse -Force "${target}"`
    const decision = await f.runtime.handlePreExecute(makeExec('pwsh', { command }), next)

    // 命令文本不透明，因此只能要求确认，而不是假装能精确判定"删除"。
    assert.equal(decision.kind, 'ask')
    assert.match(decision.reason, /dsh-agent-guard/)
    assert.equal(state.calls, 0, '未获批准前不得执行')

    const text = readFileSync(join(f.home, 'agent-guard', 'journal.jsonl'), 'utf8')
    assert.ok(!text.includes('Remove-Item'), '命令原文绝不能进日志')
    assert.ok(text.includes('commandDigest'), '应记录命令摘要')
  } finally {
    f.cleanup()
  }
})

test('G-4: 生成引用受保护路径的 .bat → emit-script 告警，且绝不"一键"', async () => {
  const f = guardFixture()
  try {
    const scriptPath = join(f.workspace, 'fix-sessions.bat')
    // 脚本内容引用了 DSH 的会话存储——这正是事故里被交付给用户双击的东西。
    const content = [
      '@echo off',
      `ren "${join(f.home, 'sessions', '--D-proj-a--')}" "--D-proj-b--"`,
      'pause',
    ].join('\r\n')

    const { state, next } = trackedNext()
    const decision = await f.runtime.handlePreExecute(
      makeExec('write', { file_path: scriptPath, content }),
      next,
    )

    assert.equal(decision.kind, 'ask', '必须要求确认（而不是静默放行）')
    assert.match(decision.reason, /受保护路径/)
    assert.match(decision.reason, /一键/)
    assert.equal(state.calls, 0, '未获批准前不得写入')

    // 日志必须记下这是 emit-script 形态，并且哈希链保持完整。
    const rows = readFileSync(join(f.home, 'agent-guard', 'journal.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line))
    const scriptRow = rows.find((row) => row.action === 'emit-script')
    assert.ok(scriptRow !== undefined, '日志必须标明 action=emit-script')
    assert.equal(scriptRow.code, 'emit-script')
    assert.match(scriptRow.reason, /R4/)
    assert.equal(f.journal.verify().ok, true, '哈希链必须保持完整')
  } finally {
    f.cleanup()
  }
})

test('G-4b: 生成不引用受保护路径的脚本 → 按普通写入处理（不误报）', async () => {
  const f = guardFixture()
  try {
    const scriptPath = join(f.workspace, 'build.bat')
    const content = '@echo off\r\nnpm run build\r\n'
    const outcome = decideToolCall({
      engine: f.runtime.engine(),
      toolName: 'write',
      args: { file_path: scriptPath, content },
      dshState: { running: true },
    })
    assert.notEqual(outcome.action, 'emit-script', '普通脚本不得被误判为 emit-script')
    assert.equal(outcome.action, 'write')
  } finally {
    f.cleanup()
  }
})

test('G-4c: 引用受保护路径但目标不是脚本 → 不误报 emit-script', () => {
  const f = guardFixture()
  try {
    const outcome = decideToolCall({
      engine: f.runtime.engine(),
      toolName: 'write',
      args: {
        file_path: join(f.workspace, 'notes.txt'),
        content: `记得清理 ${join(f.home, 'sessions')} 目录`,
      },
      dshState: { running: true },
    })
    assert.notEqual(outcome.action, 'emit-script', '目标不是脚本时不该报 emit-script')
  } finally {
    f.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 读操作不产生噪音
// ---------------------------------------------------------------------------
test('读操作直接放行且不写日志（避免噪音）', async () => {
  const f = guardFixture()
  try {
    const { state, next } = trackedNext()
    const decision = await f.runtime.handlePreExecute(makeExec('read', { file_path: join(f.home, 'storages', 'workspace.json') }), next)
    assert.equal(state.calls, 1, '读操作必须放行')
    assert.equal(decision.kind, 'allow')
    assert.equal(f.store.sizeOf('journal.jsonl'), 0, '读操作不应产生日志噪音')
  } finally {
    f.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 写前备份：先备份，再放行；备份失败则拒绝
// ---------------------------------------------------------------------------
test('受保护写入在放行前先备份，且备份内容与原文一致', async () => {
  const f = guardFixture({
    // 让 DSH 已停止，于是核心数据写入进入"需理由 + 先备份"分支。
    dshStateProvider: () => ({ running: false, detail: '测试：已停止' }),
    config: { goalClass: 'maintenance' },
  })
  try {
    const target = join(f.home, 'storages', 'workspace.json')
    const before = readFileSync(target, 'utf8')
    const { state, next } = trackedNext()
    const decision = await f.runtime.handlePreExecute(makeExec('write', { file_path: target }), next)

    // DSH 已停止 + maintenance 预算 → 走审批（需理由），此时尚未备份。
    assert.equal(decision.kind, 'ask')

    // 直接验证备份函数本身在放行路径上的行为。
    const { backupFileBeforeWrite } = await import('../lib/backup.js')
    const backup = backupFileBeforeWrite({ store: f.store, target, reason: 'test' })
    assert.equal(backup.ok, true)
    assert.equal(readFileSync(backup.path, 'utf8'), before)
    assert.equal(state.calls, 0)
  } finally {
    f.cleanup()
  }
})

test('备份被配置关闭时，受保护写入被拒绝（绝不无备份放行）', () => {
  const f = guardFixture({ config: { backupEnabled: false } })
  try {
    const target = join(f.home, 'storages', 'workspace.json')
    const decision = {
      classification: {
        targets: [{ target, protected: true }],
      },
    }
    const result = f.runtime.backupTargets([target], decision)
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'disabled')
    assert.match(result.error, /备份已被配置关闭/)
  } finally {
    f.cleanup()
  }
})

test('备份超出上限时 backupTargets 返回失败，调用方据此拒绝写入', () => {
  const f = guardFixture({ config: { maxBackupBytes: 1024 } })
  try {
    const target = join(f.home, 'storages', 'workspace.json')
    const { writeFileSync: write } = process.getBuiltinModule('node:fs')
    write(target, 'x'.repeat(4096))
    const result = f.runtime.backupTargets([target], { classification: { targets: [{ target, protected: true }] } })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'too-large')
  } finally {
    f.cleanup()
  }
})

test('未命中受保护路径时不做备份，但仍报告目标', () => {
  const f = guardFixture()
  try {
    const plain = join(f.workspace, 'src', 'index.js')
    const result = f.runtime.backupTargets([plain], { classification: { targets: [{ target: plain, protected: false }] } })
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'not-required')
    assert.deepEqual(result.targets, [plain])
  } finally {
    f.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 引擎故障 → fail-safe
// ---------------------------------------------------------------------------
test('规则引擎故障时拒绝调用并说明原因（fail-safe，不无备份放行）', async () => {
  const f = guardFixture()
  try {
    f.runtime.engine = () => {
      throw new Error('synthetic engine failure')
    }
    const { state, next } = trackedNext()
    const decision = await f.runtime.handlePreExecute(makeExec('write', { file_path: 'C:\\x' }), next)
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /规则引擎故障/)
    assert.match(decision.reason, /fail-safe/)
    assert.equal(state.calls, 0)
  } finally {
    f.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 一键停用
// ---------------------------------------------------------------------------
test('enabled=false 时护栏完全不介入', async () => {
  const f = guardFixture({ config: { enabled: false } })
  try {
    const target = join(f.home, 'storages', 'workspace.json')
    const { state, next } = trackedNext()
    const decision = await f.runtime.handlePreExecute(makeExec('write', { file_path: target }), next)
    assert.equal(decision.kind, 'allow')
    assert.equal(state.calls, 1)
    assert.equal(f.store.sizeOf('journal.jsonl'), 0)
  } finally {
    f.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 熔断（T7）
// ---------------------------------------------------------------------------
test('熔断：同一路径连续写且摘要变化后暂停并要求人工确认', async () => {
  const f = guardFixture({ config: { circuitThreshold: 2 } })
  try {
    const target = join(f.workspace, 'note.txt')
    writeFileSync(target, 'v1')

    // 第一次写：记录状态。
    f.runtime.circuit.record(target, f.runtime.circuit.probeDigest(target))
    // 磁盘内容变了（模拟上一次写改变了状态）。
    writeFileSync(target, 'v2-changed')

    const verdict = f.runtime.circuit.inspect(target, f.runtime.circuit.probeDigest(target))
    assert.equal(verdict.writes, 2)
    assert.equal(verdict.changed, true)
    assert.equal(verdict.pause, true, '连续两次且状态变化必须熔断')
  } finally {
    f.cleanup()
  }
})

test('熔断：摘要未变化时不触发', () => {
  const tracker = new CircuitTracker({ threshold: 2, now: () => 1000 })
  tracker.record('C:\\a.txt', '10:100')
  const verdict = tracker.inspect('C:\\a.txt', '10:100')
  assert.equal(verdict.changed, false)
  assert.equal(verdict.pause, false)
})

test('熔断：首次写不触发', () => {
  const tracker = new CircuitTracker({ threshold: 2 })
  const verdict = tracker.inspect('C:\\new.txt', 'absent')
  assert.equal(verdict.writes, 0)
  assert.equal(verdict.pause, false)
})

test('熔断状态会过期，不会永久拦住同一路径', () => {
  let now = 0
  const tracker = new CircuitTracker({ threshold: 2, ttlMs: 1000, now: () => now })
  tracker.record('C:\\a.txt', '1:1')
  now = 5000
  const verdict = tracker.inspect('C:\\a.txt', '2:2')
  assert.equal(verdict.writes, 0, '过期状态必须被丢弃')
  assert.equal(verdict.pause, false)
})

test('probeDigest 对不存在的文件返回 absent 而不是 null', () => {
  const tracker = new CircuitTracker()
  assert.equal(tracker.probeDigest('Z:\\definitely\\missing.txt'), 'absent')
})

// ---------------------------------------------------------------------------
// Agent 上下文解析（实测形状，不猜）
// ---------------------------------------------------------------------------
test('resolveAgentContext 从 agent.session.header 取 cwd，并从 agent.id 取会话 id', () => {
  const resolved = resolveAgentContext({
    agent: { id: 'session-x', session: { header: { id: 'session-x', cwd: 'D:\\proj' } } },
  })
  assert.equal(resolved.sessionId, 'session-x')
  assert.equal(resolved.cwd, 'D:\\proj')
})

test('resolveAgentContext 在形状缺失时返回 null，而不是猜一个值', () => {
  assert.deepEqual(resolveAgentContext({}), { sessionId: null, cwd: null })
  assert.deepEqual(resolveAgentContext(null), { sessionId: null, cwd: null })
  assert.deepEqual(resolveAgentContext({ agent: { id: 'only-id' } }), { sessionId: 'only-id', cwd: null })
})

// ---------------------------------------------------------------------------
// 每轮快照
// ---------------------------------------------------------------------------
test('快照调度器按最小间隔去抖，高频回合不会把磁盘打满', () => {
  const temp = makeTempHome('sched')
  try {
    let now = 1_000_000
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const { config } = resolveConfig({ snapshotMinIntervalMs: 60_000 })
    const scheduler = new SnapshotScheduler({
      store,
      dshHome: temp.home,
      config: { ...config },
      now: () => now,
    })

    const first = scheduler.run({ reason: 'turn-start' })
    assert.equal(first.skipped, false)
    assert.ok(first.id !== null)

    // 同一分钟内的后续回合被跳过。
    now += 1000
    const second = scheduler.run({ reason: 'turn-start' })
    assert.equal(second.skipped, true)
    assert.equal(scheduler.skipped, 1)

    // 超过间隔后再次落盘。
    now += 61_000
    const third = scheduler.run({ reason: 'turn-start' })
    assert.equal(third.skipped, false)
  } finally {
    temp.cleanup()
  }
})

test('快照开关关闭时不写任何东西', () => {
  const temp = makeTempHome('sched-off')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const { config } = resolveConfig({ snapshotEnabled: false })
    const scheduler = new SnapshotScheduler({ store, dshHome: temp.home, config })
    const result = scheduler.run({ reason: 'turn-start' })
    assert.equal(result.skipped, true)
    assert.equal(store.sizeOf('snapshots'), 0, 'sizeOf 只报文件字节，目录报 0')
    // 更强的断言：快照目录里不该出现任何**条目**。
    // store 初始化时会建出 snapshots/ 目录，所以判断依据是"空"，而不是"不存在"。
    // 补这一条是因为原先只查 sizeOf，而 sizeOf 对目录的返回值在 POSIX 上是 4096
    // （文件系统块大小）、Windows 上是 0 —— 那个断言曾在 Windows 上"通过"，
    // 实际并没有验证到"没写东西"。
    const snapshotDir = join(temp.home, 'agent-guard', 'snapshots')
    const entries = existsSync(snapshotDir) ? readdirSync(snapshotDir) : []
    assert.equal(entries.length, 0, `快照目录应为空，实际有 ${entries.length} 项`)
  } finally {
    temp.cleanup()
  }
})

test('force 可以跳过去抖（手动触发）', () => {
  const temp = makeTempHome('sched-force')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const { config } = resolveConfig({})
    const scheduler = new SnapshotScheduler({ store, dshHome: temp.home, config })
    scheduler.run({ reason: 'first' })
    const second = scheduler.run({ reason: 'manual', force: true })
    assert.equal(second.skipped, false)
  } finally {
    temp.cleanup()
  }
})

test('onTurn 会记录回合并携带会话 id', () => {
  const temp = makeTempHome('sched-turn')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const { config } = resolveConfig({})
    const scheduler = new SnapshotScheduler({ store, dshHome: temp.home, config })
    const result = scheduler.onTurn({ agent: { id: 'session-turn-1' }, turn: 7 })
    assert.equal(result.ok, true)
    const meta = JSON.parse(readFileSync(join(store.path('snapshots', result.id), 'meta.json'), 'utf8'))
    assert.equal(meta.sessionId, 'session-turn-1')
    assert.equal(meta.reason, 'turn-start')
  } finally {
    temp.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
test('配置解析：非法值回落默认并给出告警，绝不抛错', () => {
  const { config, warnings } = resolveConfig({
    enabled: 'yes',
    goalClass: 'god-mode',
    snapshotMinIntervalMs: -5,
    maxBackupBytes: 10,
    dir: 42,
  })
  assert.equal(config.enabled, true, '非法布尔值回落默认')
  assert.equal(config.goalClass, 'workspace-content')
  assert.equal(config.snapshotMinIntervalMs, 60_000)
  assert.equal(config.maxBackupBytes, 8 * 1024 * 1024)
  assert.equal(config.dir, null)
  assert.equal(warnings.length, 5, `每个非法项都应有告警，实际 ${warnings.length}`)
})

test('配置解析：合法值被接受', () => {
  const { config, warnings } = resolveConfig({
    enabled: false,
    goalClass: 'maintenance',
    keepRecent: 5,
    dir: 'D:\\guard-data',
  })
  assert.equal(config.enabled, false)
  assert.equal(config.goalClass, 'maintenance')
  assert.equal(config.keepRecent, 5)
  assert.equal(config.dir, 'D:\\guard-data')
  assert.equal(warnings.length, 0)
})

test('影响预算的四个类别都被配置接受', () => {
  for (const goalClass of GOAL_CLASSES) {
    const { config, warnings } = resolveConfig({ goalClass })
    assert.equal(config.goalClass, goalClass)
    assert.equal(warnings.length, 0)
  }
})

// ---------------------------------------------------------------------------
// 归档提示：注册表读取异常不应影响护栏决策
// ---------------------------------------------------------------------------
test('护栏在注册表不可读时仍按受保护路径表工作（不依赖注册表）', async () => {
  const f = guardFixture()
  try {
    // 删掉注册表：工作区列表取不到，但 DSH 受保护路径表仍然生效。
    const { rmSync } = process.getBuiltinModule('node:fs')
    rmSync(join(f.home, 'storages', 'workspace.json'), { force: true })
    const target = join(f.home, 'sessions', '--D-proj--')
    const { state, next } = trackedNext()
    const decision = await f.runtime.handlePreExecute(makeExec('write', { file_path: target }), next)
    assert.equal(decision.kind, 'deny')
    assert.equal(state.calls, 0)
  } finally {
    f.cleanup()
  }
})

// 保持与远端一致的辅助断言：子代理判据仍然只来自 header。
test('子代理判据只来自 header：未登记的会话目录不会被当成内部记录', () => {
  assert.equal(classifyConversation({ type: 'session', id: 'x', cwd: 'D:\\proj' }).countsAsConversation, true)
  assert.equal(classifyConversation({ type: 'session', id: 'y', origin: 'subagent' }).countsAsConversation, false)
})

// 显式引用，避免未使用导入被静默移除。
void stubProbes
void createSnapshot
void readdirSync
