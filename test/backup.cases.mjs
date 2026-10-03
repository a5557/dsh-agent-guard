/**
 * 备份、回滚点与保留策略测试（`DESIGN.md` §8）。
 *
 * 最关键的两条：
 * - 备份超出预算 / 失败 → **拒绝写入**，绝不无备份放行；
 * - 保留策略**只删本插件自己的快照**，不认识的东西一律不碰。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
import { backupFileBeforeWrite, createSnapshot, listSnapshots, pruneSnapshots, rollbackInstructions, stamp } from '../lib/backup.js'
import { makeTempHome } from './fixtures.mjs'

/** 造一个 store + 一个受保护目标文件。 */
function fixture(label) {
  const temp = makeTempHome(label)
  const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
  const target = join(temp.home, 'storages', 'workspace.json')
  mkdirSync(join(temp.home, 'storages'), { recursive: true })
  writeFileSync(target, '{"unit":{"name":"workspace","version":2}}')
  return { ...temp, store, target }
}

// ---------------------------------------------------------------------------
// 写前备份
// ---------------------------------------------------------------------------
test('写前备份复制目标文件并留下 meta，不改动原文件', () => {
  const f = fixture('bk')
  try {
    const before = readFileSync(f.target, 'utf8')
    const result = backupFileBeforeWrite({ store: f.store, target: f.target, reason: 'test' })
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'copied')
    assert.ok(result.path !== null && existsSync(result.path), '备份文件必须存在')
    assert.equal(readFileSync(f.target, 'utf8'), before, '原文件必须原样不动')
    assert.equal(readFileSync(result.path, 'utf8'), before, '备份内容必须一致')
    assert.ok(result.digest !== null && result.digest.length === 64)
  } finally {
    f.cleanup()
  }
})

test('目标不存在时不算失败：如实标注为 absent', () => {
  const f = fixture('absent')
  try {
    const result = backupFileBeforeWrite({ store: f.store, target: join(f.home, 'storages', 'nope.json') })
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'absent')
    assert.equal(result.path, null)
  } finally {
    f.cleanup()
  }
})

test('超过上限时返回 too-large，调用方据此拒绝写入', () => {
  const f = fixture('large')
  try {
    const result = backupFileBeforeWrite({ store: f.store, target: f.target, maxBytes: 4 })
    assert.equal(result.ok, false, '超预算必须失败')
    assert.equal(result.kind, 'too-large')
    assert.ok(result.bytes > 4)
  } finally {
    f.cleanup()
  }
})

test('复制失败时返回失败而不是静默通过', () => {
  const temp = makeTempHome('copyfail')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const target = join(temp.home, 'x.json')
    writeFileSync(target, 'data')
    const result = backupFileBeforeWrite({
      store,
      target,
      io: {
        copyFile: () => {
          const error = new Error('disk full')
          error.code = 'ENOSPC'
          throw error
        },
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'failed')
    assert.match(result.error, /ENOSPC/)
  } finally {
    temp.cleanup()
  }
})

test('仅内存模式无法备份：返回 memory-only 并失败', () => {
  const result = backupFileBeforeWrite({
    store: { durable: false, path: () => null },
    target: 'C:\\whatever',
  })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'memory-only')
})

test('备份目录名不含真实文件名（只用哈希前缀）', () => {
  const f = fixture('noname')
  try {
    const result = backupFileBeforeWrite({ store: f.store, target: f.target })
    const relative = result.path.replace(f.store.path('backups'), '')
    assert.ok(!relative.includes('workspace.json'), '备份文件名不应暴露原文件名')
    assert.match(relative.replace(/\\/g, '/'), /^\/\d{8}-\d{6}\/[0-9a-f]{16}\.bak$/)
  } finally {
    f.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 回滚点
// ---------------------------------------------------------------------------
test('快照包含 meta / 注册表副本 / 布局清单 / hashes 四件套', () => {
  const f = fixture('snap')
  try {
    // 造一个会话目录，让布局清单有内容。
    mkdirSync(join(f.home, 'sessions', '--D-x--', 'session-a'), { recursive: true })
    writeFileSync(join(f.home, 'sessions', '--D-x--', 'session-a', 'session.v4.jsonl.zstd'), 'not-really-zstd')

    const result = createSnapshot({ store: f.store, dshHome: f.home, reason: 'test' })
    assert.equal(result.ok, true)
    assert.ok(result.id !== null)

    const dir = f.store.path('snapshots', result.id)
    const files = readdirSync(dir).sort()
    assert.deepEqual(files, ['hashes.sha256', 'layout.json', 'meta.json', 'workspace.json'])

    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    assert.equal(meta.reason, 'test')
    assert.match(meta.note, /不提供自动回滚命令/)

    const layout = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8'))
    assert.equal(layout.spaces.length, 1)
    assert.equal(layout.spaces[0].sessions, 1)

    // hashes.sha256 必须覆盖除它自己以外的每一个产物（它无法自证）。
    const hashes = readFileSync(join(dir, 'hashes.sha256'), 'utf8').trim().split('\n')
    const manifestNames = hashes.map((line) => line.trim().split(/\s+/)[1]).sort()
    const artifactNames = files.filter((name) => name !== 'hashes.sha256').sort()
    assert.deepEqual(manifestNames, artifactNames, '清单必须逐一覆盖全部产物')
    for (const line of hashes) {
      assert.match(line, /^[0-9a-f]{64}\s{2}\S+$/, `清单每行必须是「sha256 + 两个空格 + 文件名」，实际：${line}`)
    }
  } finally {
    f.cleanup()
  }
})

test('快照只读采集：注册表原文件不被改动', () => {
  const f = fixture('readonly-snap')
  try {
    const before = readFileSync(f.target, 'utf8')
    createSnapshot({ store: f.store, dshHome: f.home, reason: 'test' })
    assert.equal(readFileSync(f.target, 'utf8'), before)
  } finally {
    f.cleanup()
  }
})

test('注册表不存在时快照仍然成功，并如实标注', () => {
  const temp = makeTempHome('nosnap-registry')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const result = createSnapshot({ store, dshHome: temp.home, reason: 'test' })
    assert.equal(result.ok, true)
    const files = readdirSync(store.path('snapshots', result.id)).sort()
    assert.deepEqual(files, ['hashes.sha256', 'layout.json', 'meta.json'], '没有注册表就不该有 workspace.json')
  } finally {
    temp.cleanup()
  }
})

test('仅内存模式无法生成快照', () => {
  const result = createSnapshot({
    store: { durable: false, path: () => null },
    dshHome: 'C:\\x',
    reason: 'test',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'memory-only-mode')
})

test('listSnapshots 按新到旧列出，且只认自己的时间戳目录', () => {
  const temp = makeTempHome('list')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    mkdirSync(store.path('snapshots', '20260101-000000'), { recursive: true })
    mkdirSync(store.path('snapshots', '20260102-000000'), { recursive: true })
    mkdirSync(store.path('snapshots', 'someone-elses-dir'), { recursive: true })

    const list = listSnapshots(store)
    assert.deepEqual(list.map((entry) => entry.id), ['20260102-000000', '20260101-000000'])
  } finally {
    temp.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 保留策略
// ---------------------------------------------------------------------------
test('保留策略只删自己的时间戳目录，不认识的目录一律保留', () => {
  const temp = makeTempHome('prune')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const stamps = ['20260101-000000', '20260101-010000', '20260102-000000', '20260201-000000', '20260301-000000']
    for (const name of stamps) mkdirSync(store.path('snapshots', name), { recursive: true })
    mkdirSync(store.path('snapshots', 'keep-me'), { recursive: true })
    writeFileSync(store.path('snapshots', 'loose-file.txt'), 'x')

    const result = pruneSnapshots({
      store,
      keepRecent: 2,
      keepHourly: 1,
      keepDaily: 1,
      now: new Date(2026, 2, 15),
    })

    assert.equal(result.unknown.length, 2, '不认识的条目必须被报告且不删')
    assert.ok(result.removed.length > 0, '应当删掉一些旧快照')
    assert.ok(existsSync(store.path('snapshots', 'keep-me')), '不认识的目录必须保留')
    assert.ok(existsSync(store.path('snapshots', 'loose-file.txt')), '不认识的松散文件必须保留')
    assert.ok(existsSync(store.path('snapshots', '20260301-000000')), '最近的必须保留')
  } finally {
    temp.cleanup()
  }
})

test('dryRun 只计算不删除', () => {
  const temp = makeTempHome('dryrun')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    for (const name of ['20260101-000000', '20260102-000000', '20260103-000000']) {
      mkdirSync(store.path('snapshots', name), { recursive: true })
    }
    const result = pruneSnapshots({ store, keepRecent: 1, keepHourly: 0, keepDaily: 0, now: new Date(2026, 0, 4), dryRun: true })
    assert.equal(result.removed.length, 2)
    for (const name of ['20260101-000000', '20260102-000000', '20260103-000000']) {
      assert.ok(existsSync(store.path('snapshots', name)), 'dryRun 不得删除任何东西')
    }
  } finally {
    temp.cleanup()
  }
})

test('保留策略在删除失败时不报错，只是留着', () => {
  const temp = makeTempHome('prunefail')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    mkdirSync(store.path('snapshots', '20260101-000000'), { recursive: true })
    mkdirSync(store.path('snapshots', '20260102-000000'), { recursive: true })
    const result = pruneSnapshots({
      store,
      keepRecent: 1,
      keepHourly: 0,
      keepDaily: 0,
      now: new Date(2026, 0, 3),
      io: {
        readdir: readdirSync,
        rm: () => {
          throw new Error('locked')
        },
      },
    })
    assert.equal(result.removed.length, 0)
    assert.equal(result.kept.length, 2)
  } finally {
    temp.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 人工回滚说明
// ---------------------------------------------------------------------------
test('回滚说明只给人工步骤，且绝不包含自动改写命令', () => {
  const f = fixture('rollback')
  try {
    const snapshot = createSnapshot({ store: f.store, dshHome: f.home, reason: 'test' })
    const result = rollbackInstructions({ store: f.store, id: snapshot.id, dshHome: f.home })
    assert.equal(result.ok, true)
    assert.match(result.text, /人工回滚说明/)
    assert.match(result.text, /不提供自动回滚命令/)
    assert.match(result.text, /先停止 DSH/)
    // 不得出现可直接执行的一键改写命令。
    assert.ok(!/Copy-Item\s+-Force/.test(result.text), '不得给出可直接执行的一键覆盖命令')
    assert.ok(!/robocopy/i.test(result.text))
  } finally {
    f.cleanup()
  }
})

test('找不到快照时回滚说明给出可照做的下一步', () => {
  const temp = makeTempHome('norollback')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const result = rollbackInstructions({ store, id: '29990101-000000', dshHome: temp.home })
    assert.equal(result.ok, false)
    assert.match(result.text, /找不到快照/)
  } finally {
    temp.cleanup()
  }
})

test('stamp 生成可被保留策略识别的目录名', () => {
  const name = stamp(new Date(2026, 9, 1, 21, 42, 21))
  assert.equal(name, '20261001-214221')
  assert.match(name, /^\d{8}-\d{6}$/)
})
