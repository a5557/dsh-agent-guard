/**
 * 用户可见面的断言测试。
 *
 * 覆盖审计（`checks/check-coverage.mjs`）暴露出三个只有**间接**覆盖的面：
 *
 * 1. `createJournalTool` 的三个 action 的输出文本 —— 这是**模型唯一能读到的**护栏状态，
 *    此前没有任何断言，函数改了文案也没人知道；
 * 2. `probeDshState` / `toEngineDshState` 的多判据与 fail-closed 映射 —— 只被默认路径带到过，
 *    判据本身（进程/端口/不确定）没有单独验证；
 * 3. `formatGuardStatus` / `formatHistory` 的输出形状。
 *
 * 这三处都是"坏了不会报错、但用户会看到错的东西"的位置，必须在文本层断言。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { createComponents, createJournalTool, describeState, formatGuardStatus, formatHistory, readRecent } from '../lib/index.js'
import { probeDshState, probeFileLock, toEngineDshState } from '../lib/hostcheck.js'
import { makeTempHome } from './fixtures.mjs'

/** 造一套真实组件（临时 home，零污染）。 */
function fixture(label = 'visible') {
  const temp = makeTempHome(label)
  const workspace = join(temp.home, 'workspaces', 'proj')
  mkdirSync(workspace, { recursive: true })
  const components = createComponents({
    dshHome: temp.home,
    workspaceRoots: [workspace],
    dshStateProvider: () => ({ running: true, detail: '测试：运行中' }),
  })
  return { ...temp, workspace, components }
}

// ---------------------------------------------------------------------------
// guard_journal：三个 action 的输出文本
// ---------------------------------------------------------------------------
test('guard_journal 工具暴露 status / recent / rollback 三个只读动作', () => {
  const f = fixture('journal-tool')
  try {
    const tool = createJournalTool({
      describe: () => describeState(f.components),
      recent: (limit) => readRecent(f.components.journal, limit),
      rollback: () => ({ ok: true, text: '人工回滚说明' }),
    })
    assert.equal(tool.name, 'guard_journal')
    assert.equal(tool.parameters.properties.action.type, 'string')
    assert.deepEqual(tool.parameters.properties.action.enum, ['status', 'recent', 'rollback'])
    // 面板与工具同源：绝不允许出现"删/改/修"这类动作。
    for (const forbidden of ['delete', 'remove', 'fix', 'repair']) {
      assert.ok(!tool.parameters.properties.action.enum.includes(forbidden), `不得暴露 ${forbidden} 动作`)
    }
  } finally {
    f.cleanup()
  }
})

test('status 文本必须让人读到关键事实（启用状态/存储模式/链状态/回滚点数）', async () => {
  const f = fixture('journal-status')
  try {
    const tool = createJournalTool({
      describe: () => describeState(f.components),
      recent: () => [],
      rollback: () => ({ ok: true, text: '' }),
    })
    const result = await tool.execute({ action: 'status' })
    assert.equal(result.ok, true)
    for (const needle of ['护栏状态', '已启用', '数据目录', '日志', '链状态', '回滚点', '影响预算', '熔断阈值']) {
      assert.ok(result.text.includes(needle), `status 文本必须包含「${needle}」，实际：\n${result.text}`)
    }
    // 链完整性必须显式可读，而不是只在 JSON 里。
    assert.ok(result.text.includes('完整'), '必须显式说明哈希链状态')
  } finally {
    f.cleanup()
  }
})

test('status 在降级或链异常时必须**说出来**，不能静默', async () => {
  const f = fixture('journal-degraded')
  try {
    const state = describeState(f.components)
    // 人为构造一个降级 + 链异常的状态描述。
    const degraded = {
      ...state,
      dir: null,
      warning: '所有候选目录都不可写：进入仅内存模式，记录会丢失',
      journal: { ...state.journal, chainOk: false, chainDetail: '哈希链在第 2 条断开' },
    }
    const text = formatGuardStatus(degraded)
    assert.ok(text.includes('仅内存'), '存储降级必须出现在文本里')
    assert.ok(text.includes('记录会丢失'), '降级后果必须说清')
    assert.ok(text.includes('哈希链在第 2 条断开'), '链异常必须原样报出')
    assert.ok(text.includes('⚠'), '降级与异常必须有醒目标记')
  } finally {
    f.cleanup()
  }
})

test('recent 在无记录时给出明确说明，而不是空白', async () => {
  const f = fixture('journal-empty')
  try {
    const tool = createJournalTool({
      describe: () => describeState(f.components),
      recent: () => [],
      rollback: () => ({ ok: true, text: '' }),
    })
    const result = await tool.execute({ action: 'recent' })
    assert.equal(result.ok, true)
    assert.ok(result.text.trim().length > 0, '不得返回空字符串')
    assert.match(result.text, /暂无/)
  } finally {
    f.cleanup()
  }
})

test('rollback 缺 snapshot 参数时给出可照做的下一步，而不是崩', async () => {
  const f = fixture('journal-rollback')
  try {
    const tool = createJournalTool({
      describe: () => describeState(f.components),
      recent: () => [],
      rollback: () => ({ ok: true, text: '' }),
    })
    const result = await tool.execute({ action: 'rollback' })
    assert.equal(result.ok, false)
    assert.match(result.text, /需要 snapshot/)
    assert.match(result.text, /action=status/, '必须告诉用户怎么查可用快照')
  } finally {
    f.cleanup()
  }
})

test('formatHistory 渲染时间/工具/动作/决策，且不泄露命令原文', () => {
  const rows = [
    {
      seq: 2,
      ts: '2026-10-01T13:42:21.916Z',
      tool: 'write',
      action: 'write',
      decision: 'blocked',
      reason: '目标属于 DSH 核心数据',
      targets: ['C:/x/storages/workspace.json'],
      commandDigest: 'abc123def456',
    },
  ]
  const text = formatHistory(rows)
  assert.ok(text.includes('write'), '必须显示工具名')
  assert.ok(text.includes('blocked'), '必须显示决策')
  assert.ok(text.includes('目标 1 个'), '只报目标数量，不回显路径')
  assert.ok(!text.includes('C:/x/storages'), '不得回显目标路径')
  assert.ok(!text.includes('abc123def456'), '摘要无需展示')
})

// ---------------------------------------------------------------------------
// 宿主状态探测：多判据与 fail-closed 映射
// ---------------------------------------------------------------------------
test('probeDshState 在两项判据都命中时报「运行中」', () => {
  const state = probeDshState({
    probes: {
      listProcesses: () => [{ pid: 42, name: 'DeepSeek Harness.exe' }],
      listPorts: () => new Set([19387]),
    },
  })
  assert.equal(state.running, true)
  assert.equal(state.inconclusive, false)
  const names = state.criteria.map((entry) => entry.name)
  assert.deepEqual(names.sort(), ['port', 'process'], '两项判据都必须参与')
})

test('probeDshState 在两项判据都否定时报「未运行」', () => {
  const state = probeDshState({
    probes: {
      listProcesses: () => [{ pid: 1, name: 'explorer.exe' }],
      listPorts: () => new Set([80]),
    },
  })
  assert.equal(state.running, false)
  assert.equal(state.inconclusive, false)
})

test('probeDshState 在判据全部不可用时报「不确定」，而不是「未运行」', () => {
  const boom = () => {
    throw new Error('synthetic probe failure')
  }
  const state = probeDshState({ probes: { listProcesses: boom, listPorts: boom } })
  assert.equal(state.running, 'unknown', '判不出来必须是 unknown，不是 false')
  assert.equal(state.inconclusive, true)
  for (const criterion of state.criteria) {
    assert.equal(criterion.concluded, false)
    assert.ok(criterion.detail.length > 0, '不可用也要给出可读原因')
  }
})

test('只有一项判据可用且否定时仍是「未运行」（不因另一项坏了就一律 unknown）', () => {
  const state = probeDshState({
    probes: {
      listProcesses: () => {
        throw new Error('boom')
      },
      listPorts: () => new Set([80]),
    },
  })
  assert.equal(state.running, false)
  assert.equal(state.inconclusive, false)
})

test('toEngineDshState 把 unknown 映射为「未停止」（fail-closed，§6.3）', () => {
  assert.equal(toEngineDshState({ running: true, criteria: [], inconclusive: false }).running, true)
  assert.equal(toEngineDshState({ running: false, criteria: [], inconclusive: false }).running, false)
  const unknown = toEngineDshState({ running: 'unknown', criteria: [], inconclusive: true })
  assert.equal(unknown.running, true, 'unknown 必须按「未停止」处理')
  assert.match(unknown.detail, /fail-closed|未停止/)
})

test('probeFileLock 对不存在的文件报「未占用」，对非法输入报「不确定」', () => {
  const missing = probeFileLock('Z:\\definitely\\not\\here.txt')
  assert.equal(missing.locked, false, '文件不存在就没有占用可言')
  const relative = probeFileLock('relative/path.txt')
  assert.equal(relative.locked, 'unknown', '非绝对路径判不了占用，必须报 unknown')
})

// ---------------------------------------------------------------------------
// describeState：面板与工具共用同一份状态，字段名必须稳定
// ---------------------------------------------------------------------------
test('describeState 暴露面板与工具共同依赖的字段', () => {
  const f = fixture('state-shape')
  try {
    const state = describeState(f.components)
    for (const key of ['enabled', 'dir', 'durable', 'warning', 'storageMode', 'journal', 'snapshots', 'goalClass', 'backupEnabled', 'snapshotEnabled', 'circuitThreshold', 'scheduler', 'dshHome']) {
      assert.ok(key in state, `状态必须含 ${key}`)
    }
    for (const key of ['records', 'queued', 'dropped', 'appendFailures', 'chainOk', 'chainDetail']) {
      assert.ok(key in state.journal, `journal 状态必须含 ${key}`)
    }
    assert.ok(Array.isArray(state.snapshots))
    assert.equal(typeof state.journal.chainOk, 'boolean')
  } finally {
    f.cleanup()
  }
})
