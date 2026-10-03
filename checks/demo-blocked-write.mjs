// A reproducible, self-contained demo of the guard actually blocking writes.
//
// This is REAL output: every decision below comes from the shipped decision path
// (`GuardRuntime.handlePreExecute`, the same one `tools/pre-execute` calls), and each case
// proves the tool body did not run. The only synthetic part is the DSH_HOME it points at —
// your real `~/.dsh` is never touched.
//
// Usage:  node checks/demo-blocked-write.mjs       (or: npm run demo)
// Purpose: this is the evidence behind the README's "Screenshots" section — it makes the
// interception reproducible without needing a live install, and nothing in its output is
// private (every path is a temporary-directory fixture). Use a terminal >= 100 columns wide.
//
// Note on the journal rows below: for `emit-script` the `命中受保护` column reflects the
// TARGET (the .bat itself, which is not a protected path) — the gate came from the protected
// path referenced INSIDE the script. That column is per-target by design, not a contradiction.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const { buildEngine, createComponents } = await import(`file:///${join(ROOT, 'lib', 'index.js').replace(/\\/g, '/')}`)
const { createGuardRuntime } = await import(`file:///${join(ROOT, 'lib', 'guard.js').replace(/\\/g, '/')}`)
const { createStore } = await import(`file:///${join(ROOT, 'lib', 'store.js').replace(/\\/g, '/')}`)
const { createJournal } = await import(`file:///${join(ROOT, 'lib', 'journal.js').replace(/\\/g, '/')}`)
const { resolveConfig } = await import(`file:///${join(ROOT, 'lib', 'config.js').replace(/\\/g, '/')}`)

const root = mkdtempSync(join(tmpdir(), 'guard-demo-'))
const home = join(root, 'dsh-home')
const project = join(root, 'my-project')
const link = join(root, 'dsh-home-link')
for (const dir of ['sessions', 'storages', 'profiles']) mkdirSync(join(home, dir), { recursive: true })
writeFileSync(join(home, 'storages', 'workspace.json'), '{"unit":{"name":"workspace","version":2}}')
mkdirSync(project, { recursive: true })
symlinkSync(home, link, 'junction')
symlinkSync(home, join(project, 'dsh'), 'junction')

const { config } = resolveConfig({})
const store = createStore({ dshHome: home, allowTmpFallback: false })
const journal = createJournal(store, { enabled: config.journalEnabled })
const runtime = createGuardRuntime({
  store,
  journal,
  config: { ...config, buildEngine: (roots) => buildEngine({ dshHome: home, workspaceRoots: roots }) },
  workspaceRoots: () => [project],
  dshStateProvider: () => ({ running: true, detail: 'DSH 正在运行' }),
})

const rule = '─'.repeat(96)
console.log('dsh-agent-guard — 真实拦截演示（DSH_HOME 为临时目录，未触碰你的真实 ~/.dsh）')
console.log(rule)

let index = 0
const attempt = async (title, args, tool = 'write') => {
  index += 1
  let bodyRan = 0
  const decision = await runtime.handlePreExecute(
    {
      name: tool,
      arguments: args,
      callId: `call-${index}`,
      signal: new AbortController().signal,
      agent: { id: 'session-demo', session: { header: { id: 'session-demo', cwd: project } } },
    },
    async () => { bodyRan += 1; return { kind: 'allow' } },
  )
  console.log(`\n[${index}] ${title}`)
  console.log(`    目标      ${args.file_path}`)
  console.log(`    判定      ${decision.kind.toUpperCase()}`)
  console.log(`    工具主体  ${bodyRan === 0 ? '未执行 —— 拦截发生在执行之前' : '已执行'}`)
  if (decision.reason !== undefined) console.log(`    理由      ${String(decision.reason).replace(/\n/g, '\n              ')}`)
  if (decision.displayReason !== undefined) console.log(`    审批文案  ${decision.displayReason['zh-CN']}`)
  if (args.command !== undefined) console.log(`    命令摘要  ${String(decision.reason).includes('dsh-agent-guard') ? '（原文不入库，仅存摘要）' : ''}`)
}

await attempt('直接写 DSH 注册表（DSH 运行中）', {
  file_path: join(home, 'storages', 'workspace.json'),
  content: '{"unit":{"name":"workspace","version":2}}',
})
await attempt('经一个指向 DSH_HOME 的联接写同一文件（第二个名字）', {
  file_path: join(link, 'storages', 'workspace.json'),
  content: '{"unit":{"name":"workspace","version":2}}',
})
await attempt('经项目内 dsh/ 联接重写注册表（事故的形态）', {
  file_path: join(project, 'dsh', 'storages', 'workspace.json'),
  content: '{"unit":{"name":"workspace","version":2}}',
})
await attempt('删除会话存储目录（命令文本形态）', {
  command: `Remove-Item -Recurse -Force "${join(home, 'sessions', '--D-proj--')}"`,
}, 'pwsh')

const script = ['@echo off', `ren "${join(home, 'sessions', '--D-proj-a--')}" "--D-proj-b--"`, 'pause'].join('\r\n')
await attempt('生成一个引用受保护路径的 .bat（事故载荷 R4）', {
  file_path: join(project, 'fix-sessions.bat'),
  content: script,
})

console.log(`\n${rule}\n日志（journal.jsonl，只追加 + 哈希链）`)
const rows = readFileSync(join(home, 'agent-guard', 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
for (const row of rows) {
  // 命令原文绝不入库，只有摘要；这里也只打印摘要的前 12 位。
  const digest = typeof row.commandDigest === 'string' ? row.commandDigest.slice(0, 12) : '—'
  console.log(`  ${row.tool.padEnd(7)} | ${String(row.action).padEnd(11)} | ${String(row.decision).padEnd(6)} | ${String(row.code).padEnd(24)} | 命中受保护=${String(row.classification?.protected === true).padEnd(5)} | 命令摘要=${digest}`)
}
console.log(`  哈希链完整：${journal.verify().ok}（被改写或抽掉任意一条都可被发现）`)

console.log(`\n${rule}\n结论：上面每一次"未执行"都是真的——拦截点在 tools/pre-execute，deny 在工具主体 dispatch 之前短路。`)
console.log('这只覆盖本会话内 agent 的工具调用；pwsh/bash 里的改名删除、后台任务、宿主终端、')
console.log('客户端 API 与用户手工双击脚本不在覆盖范围内（README 有逐条说明）。')

rmSync(root, { recursive: true, force: true })
