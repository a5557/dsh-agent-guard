/**
 * 存储层与日志层测试。
 *
 * 覆盖设计文档里两条最容易被实现成"静默失败"的要求：
 * - §5：日志写入失败必须重试并降级为内存队列 + 告警，**不能静默丢弃**；
 * - §10.2：日志带哈希链，删改**可被发现**。
 *
 * 全部在临时目录里进行，绝不碰真实 `$DSH_HOME`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { createStore, GuardStore, probeWritable, resolveGuardDir } from '../lib/store.js'
import { commandDigest, createJournal, hashRecord, recoverChain, verifyChain } from '../lib/journal.js'
import { makeTempHome } from './fixtures.mjs'

// ---------------------------------------------------------------------------
// 候选目录与可写性探测
// ---------------------------------------------------------------------------
test('probeWritable 会真的建删一次探针文件，而不是只看目录存在', () => {
  const temp = makeTempHome('probe')
  try {
    const target = join(temp.home, 'probe-target')
    const ok = probeWritable(target)
    assert.equal(ok.ok, true)
    assert.equal(readdirSync(target).includes('.write-probe'), false, '探针文件必须被清掉')
  } finally {
    temp.cleanup()
  }
})

test('probeWritable 在写入被拒时返回错误而不是抛出', () => {
  const temp = makeTempHome('probe-deny')
  try {
    const target = join(temp.home, 'denied-dir')
    const result = probeWritable(target, {
      mkdir: (path) => mkdirSync(path, { recursive: true }),
      writeFile: () => {
        const error = new Error('synthetic refusal')
        error.code = 'EPERM'
        throw error
      },
      rm: () => {},
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /EPERM/)
  } finally {
    temp.cleanup()
  }
})

test('probeWritable 在 mkdir 不生效时也报告失败，而不是等到首次写入才暴露', () => {
  const result = probeWritable('C:\\not-created', {
    mkdir: () => {},
    writeFile: () => {},
    rm: () => {},
    exists: () => false,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'mkdir-did-not-create-directory')
})

test('resolveGuardDir 优先 $DSH_HOME/agent-guard，并记录每一次尝试', () => {
  const temp = makeTempHome('resolve')
  try {
    const resolved = resolveGuardDir({ dshHome: temp.home, allowTmpFallback: false })
    assert.equal(resolved.mode, 'primary')
    assert.equal(resolved.dir, join(temp.home, 'agent-guard'))
    assert.equal(resolved.warning, null)
    assert.equal(resolved.attempts.length, 1)
    assert.equal(resolved.attempts[0].ok, true)
  } finally {
    temp.cleanup()
  }
})

test('主目录不可写时降级到临时目录，并给出显式告警', () => {
  const temp = makeTempHome('degrade')
  try {
    const failing = {
      // mkdir 必须真的生效（转发给真实实现）：否则临时目录不会被建出来，
      // 探针会以 ENOENT 失败，测试就测不到"沙箱拒绝"这条路径。
      mkdir: (path) => {
        const { mkdirSync } = process.getBuiltinModule('node:fs')
        mkdirSync(path, { recursive: true })
      },
      writeFile: (path) => {
        // 只拒绝主目录下的探针，放行临时目录，模拟沙箱差异。
        // 注意：临时目录本身也在系统 Temp 下，所以必须用精确前缀判断，
        // 用 includes 会把两个候选都放行。
        const isPrimary = path.startsWith(join(temp.home, 'agent-guard'))
        if (isPrimary) {
          const error = new Error('denied')
          error.code = 'EPERM'
          throw error
        }
        const { writeFileSync } = process.getBuiltinModule('node:fs')
        writeFileSync(path, 'ok')
      },
      rm: (path) => {
        try {
          const { rmSync } = process.getBuiltinModule('node:fs')
          rmSync(path, { force: true })
        } catch {
          // 忽略
        }
      },
    }
    const resolved = resolveGuardDir({ dshHome: temp.home, io: failing })
    assert.equal(resolved.mode, 'tmp')
    assert.ok(resolved.warning !== null)
    assert.match(resolved.warning, /降级到临时目录/)
    assert.equal(resolved.attempts.length, 2)
    assert.equal(resolved.attempts[0].ok, false)
    assert.equal(resolved.attempts[1].ok, true)
  } finally {
    temp.cleanup()
  }
})

test('全部候选都不可写时进入仅内存模式，并明确说明记录会丢失', () => {
  const failing = {
    mkdir: () => {},
    writeFile: () => {
      const error = new Error('denied')
      error.code = 'EPERM'
      throw error
    },
    rm: () => {},
  }
  const resolved = resolveGuardDir({ dshHome: 'C:\\nope', io: failing })
  assert.equal(resolved.mode, 'memory')
  assert.equal(resolved.dir, null)
  assert.match(resolved.warning, /仅内存/)
  assert.match(resolved.warning, /丢失/)

  const store = new GuardStore({ ...resolved, io: failing })
  assert.equal(store.durable, false)
})

// ---------------------------------------------------------------------------
// store：追加、原子替换、队列降级
// ---------------------------------------------------------------------------
test('store 在可写目录上追加日志并建好子目录', () => {
  const temp = makeTempHome('store')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const result = store.appendLine('journal.jsonl', '{"a":1}')
    assert.equal(result.ok, true)
    const entries = readdirSync(join(temp.home, 'agent-guard'))
    for (const expected of ['backups', 'layout', 'snapshots', 'journal.jsonl']) {
      assert.ok(entries.includes(expected), `数据目录应包含 ${expected}，实际 ${entries.join(', ')}`)
    }
    assert.equal(readFileSync(join(temp.home, 'agent-guard', 'journal.jsonl'), 'utf8'), '{"a":1}\n')
  } finally {
    temp.cleanup()
  }
})

test('追加连续失败时转入内存队列，且明确报告这不是丢弃', () => {
  const temp = makeTempHome('queue')
  try {
    const store = new GuardStore({
      dir: temp.home,
      mode: 'configured',
      io: {
        mkdir: () => {},
        appendFile: () => {
          const error = new Error('denied')
          error.code = 'EPERM'
          throw error
        },
      },
    })
    const result = store.appendLine('journal.jsonl', 'line-1')
    assert.equal(result.ok, false)
    assert.equal(result.queued, true)
    assert.match(result.error, /EPERM/)
    assert.equal(store.queue.length, 1)
    assert.match(store.warning, /不是丢弃/)
    assert.equal(store.describe().queued, 1)
  } finally {
    temp.cleanup()
  }
})

test('队列有上限：超出后丢弃最旧的并计数（不静默无限增长）', () => {
  const temp = makeTempHome('bounded')
  try {
    const store = new GuardStore({
      dir: temp.home,
      mode: 'configured',
      io: {
        mkdir: () => {},
        appendFile: () => {
          throw new Error('denied')
        },
      },
    })
    for (let i = 0; i < 10_050; i += 1) store.appendLine('journal.jsonl', `line-${i}`)
    assert.equal(store.queue.length, 10_000)
    assert.ok(store.dropped >= 50, `应记录丢弃数量，实际 ${store.dropped}`)
  } finally {
    temp.cleanup()
  }
})

test('恢复可写后，队列先按顺序补写，再写新行（保持时间顺序）', () => {
  const temp = makeTempHome('flush')
  try {
    let fail = true
    const written = []
    const store = new GuardStore({
      dir: temp.home,
      mode: 'configured',
      io: {
        mkdir: () => {},
        appendFile: (path, data) => {
          if (fail) throw new Error('denied')
          written.push(data)
          const { appendFileSync } = process.getBuiltinModule('node:fs')
          appendFileSync(path, data)
        },
      },
    })
    store.appendLine('journal.jsonl', 'one')
    store.appendLine('journal.jsonl', 'two')
    assert.equal(store.queue.length, 2)

    fail = false
    // 下一次成功追加必须先补写积压，再写当前行。
    store.appendLine('journal.jsonl', 'three')
    assert.equal(store.queue.length, 0)
    assert.equal(written.length, 2)
    assert.equal(written[0], 'one\ntwo\n', '积压必须整体先落盘')
    assert.equal(written[1], 'three\n', '新行必须排在积压之后')

    const { readFileSync } = process.getBuiltinModule('node:fs')
    assert.equal(readFileSync(join(temp.home, 'journal.jsonl'), 'utf8'), 'one\ntwo\nthree\n')
  } finally {
    temp.cleanup()
  }
})

test('writeFileAtomic 先写临时文件再改名，失败时返回错误而不抛出', () => {
  const temp = makeTempHome('atomic')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const ok = store.writeFileAtomic('layout/x.json', '{"ok":true}')
    assert.equal(ok.ok, true)
    assert.equal(readFileSync(join(temp.home, 'agent-guard', 'layout', 'x.json'), 'utf8'), '{"ok":true}')
    assert.equal(readdirSync(join(temp.home, 'agent-guard', 'layout')).includes('x.json.tmp'), false)

    const failing = new GuardStore({
      dir: temp.home,
      mode: 'configured',
      io: { mkdir: () => {}, writeFile: () => { throw new Error('nope') } },
    })
    const bad = failing.writeFileAtomic('layout/y.json', 'x')
    assert.equal(bad.ok, false)
    assert.ok(bad.error !== null)
  } finally {
    temp.cleanup()
  }
})

// ---------------------------------------------------------------------------
// journal：哈希链
// ---------------------------------------------------------------------------
test('hashRecord 对键的顺序不敏感（稳定序列化）', () => {
  const a = hashRecord('prev', { b: 2, a: 1 })
  const b = hashRecord('prev', { a: 1, b: 2 })
  assert.equal(a, b)
})

test('journal 连续追加形成完整哈希链', () => {
  const temp = makeTempHome('journal')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const journal = createJournal(store)
    journal.append({ action: 'write', decision: 'blocked' })
    journal.append({ action: 'write', decision: 'allowed-with-backup' })
    journal.append({ action: 'link', decision: 'require-confirmation' })

    const verdict = journal.verify()
    assert.equal(verdict.ok, true)
    assert.equal(verdict.records, 3)
    assert.match(verdict.detail, /哈希链完整/)
  } finally {
    temp.cleanup()
  }
})

test('改写中间一条记录会被哈希链发现', () => {
  const temp = makeTempHome('tamper')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const journal = createJournal(store)
    journal.append({ action: 'write', note: 'first' })
    journal.append({ action: 'write', note: 'second' })
    journal.append({ action: 'write', note: 'third' })

    const file = join(temp.home, 'agent-guard', 'journal.jsonl')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    // 把第二条的 note 改掉，但保留它的 hash —— 这正是"删改"的形态。
    const second = JSON.parse(lines[1])
    second.note = 'tampered'
    lines[1] = JSON.stringify(second)
    const { writeFileSync } = process.getBuiltinModule('node:fs')
    writeFileSync(file, `${lines.join('\n')}\n`)

    const verdict = verifyChain(readFileSync(file, 'utf8'))
    assert.equal(verdict.ok, false, '篡改必须被发现')
    assert.equal(verdict.firstMismatchAt, 2)
    assert.match(verdict.detail, /第 2 条断开/)
  } finally {
    temp.cleanup()
  }
})

test('抽掉中间一条记录同样会被发现', () => {
  const temp = makeTempHome('drop')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const journal = createJournal(store)
    journal.append({ action: 'a' })
    journal.append({ action: 'b' })
    journal.append({ action: 'c' })

    const file = join(temp.home, 'agent-guard', 'journal.jsonl')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    const { writeFileSync } = process.getBuiltinModule('node:fs')
    writeFileSync(file, `${[lines[0], lines[2]].join('\n')}\n`)

    const verdict = verifyChain(readFileSync(file, 'utf8'))
    assert.equal(verdict.ok, false)
    assert.equal(verdict.firstMismatchAt, 2)
  } finally {
    temp.cleanup()
  }
})

test('recoverChain 会报告无法解析的行，而不是当作没有内容', () => {
  const text = '{"seq":1,"prevHash":"x","hash":"y"}\nnot-json\n'
  const recovered = recoverChain(text)
  assert.equal(recovered.records, 1)
  assert.equal(recovered.unparsable, 1, '解析失败必须被计数')
})

test('新 journal 会沿用已有日志的链尾（进程重启后不断链）', () => {
  const temp = makeTempHome('resume')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const first = createJournal(store)
    first.append({ action: 'a' })
    first.append({ action: 'b' })
    const tail = first.prevHash

    const second = createJournal(createStore({ dshHome: temp.home, allowTmpFallback: false }))
    assert.equal(second.prevHash, tail, '重启后必须接上链尾')
    second.append({ action: 'c' })

    const verdict = second.verify()
    assert.equal(verdict.ok, true)
    assert.equal(verdict.records, 3)
  } finally {
    temp.cleanup()
  }
})

test('reserve/settle 会落下 pending 与 settled 两条并保持链完整', () => {
  const temp = makeTempHome('settle')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const journal = createJournal(store)
    const reserved = journal.reserve({ action: 'write', tool: 'write' })
    journal.settle(reserved, { action: 'write', result: 'allowed' })

    const text = readFileSync(join(temp.home, 'agent-guard', 'journal.jsonl'), 'utf8')
    const rows = text.trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(rows[0].phase, 'pending')
    assert.equal(rows[1].phase, 'settled')
    assert.equal(rows[1].forSeq, rows[0].seq)
    assert.equal(journal.verify().ok, true)
  } finally {
    temp.cleanup()
  }
})

test('journal 只记录命令摘要，不落命令原文', () => {
  const temp = makeTempHome('privacy')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const journal = createJournal(store)
    const secret = 'echo SUPER-SECRET-TOKEN'
    journal.append({ action: 'exec-script', commandDigest: commandDigest(secret), tool: 'pwsh' })

    const text = readFileSync(join(temp.home, 'agent-guard', 'journal.jsonl'), 'utf8')
    assert.ok(!text.includes('SUPER-SECRET-TOKEN'), '命令原文绝不能进日志')
    assert.equal(JSON.parse(text.trim()).commandDigest, commandDigest(secret))
  } finally {
    temp.cleanup()
  }
})

test('enabled=false 时不写任何记录', () => {
  const temp = makeTempHome('disabled')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const journal = createJournal(store, { enabled: false })
    const result = journal.append({ action: 'write' })
    assert.equal(result.ok, true)
    assert.equal(store.sizeOf('journal.jsonl'), 0)
    assert.equal(journal.describe().enabled, false)
  } finally {
    temp.cleanup()
  }
})

test('describe 暴露降级状态，供面板与取证报告使用', () => {
  const temp = makeTempHome('describe')
  try {
    const store = createStore({ dshHome: temp.home, allowTmpFallback: false })
    const journal = createJournal(store)
    const described = journal.describe()
    assert.equal(described.durable, true)
    assert.equal(described.queued, 0)
    assert.equal(described.chainBrokenAt, null)
  } finally {
    temp.cleanup()
  }
})
