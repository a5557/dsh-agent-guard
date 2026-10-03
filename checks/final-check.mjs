// 最终综合验证：真实驱动两个工具，并确认真实 DSH_HOME 未被写入。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { makeTempHome, fixtureWorkspace } from '../test/fixtures.mjs'

/** 递归列出「路径:大小」，用于前后比对。 */
function treeFingerprint(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          out.push(`${full}:${statSync(full).size}`)
        } catch {
          out.push(`${full}:unreadable`)
        }
      }
    }
  }
  walk(root)
  return out.sort()
}

// ---------- 1) 隔离环境里真实驱动两个工具 ----------
const temp = makeTempHome('final')
const workspace = fixtureWorkspace(temp.home, 'proj')
const tools = {}
const events = []
const routes = []
apply({
  tools: { register: (def) => { tools[def.name] = def; return () => {} } },
  on: (event) => { events.push(event); return () => {} },
  get: (service) => (service === 'webServer'
    ? { register: (route) => { routes.push(route); return () => {} } }
    : undefined),
  effect: () => () => {},
}, { goalClass: 'maintenance' }, {
  dshHome: temp.home,
  workspaceRoots: [workspace],
  dshStateProvider: () => ({ running: true, detail: '综合验证：视为运行中' }),
})

console.log('注册的工具 :', Object.keys(tools).join(', '))
console.log('订阅的事件 :', events.join(', '))
console.log('注册的路由 :', routes.map((route) => `${route.kind}:${route.path}`).join(', '))

// guard_journal：状态
const status = await tools.guard_journal.execute({ action: 'status' })
console.log('\n[guard_journal status] ok=%s', status.ok)
console.log(status.text.split('\n').slice(0, 6).map((line) => `  ${line}`).join('\n'))

// guard_inspect：真实取证（隔离环境）
const inspect = await tools.guard_inspect.execute({})
console.log('\n[guard_inspect] ok=%s', inspect.ok)
console.log(inspect.text.split('\n').slice(0, 5).map((line) => `  ${line}`).join('\n'))

// 面板 API 路由：只读动作
const apiRoute = routes.find((route) => route.path === '/agent-guard/api')
const calls = []
apiRoute.handler(
  { url: '/agent-guard/api?action=state' },
  {
    writeHead: (status) => calls.push(`status=${status}`),
    end: (body) => {
      const parsed = JSON.parse(body)
      calls.push(`enabled=${parsed.enabled} durable=${parsed.durable}`)
    },
  },
)
// 面板必须拒绝任何写动作
apiRoute.handler(
  { url: '/agent-guard/api?action=delete-everything' },
  { writeHead: (status) => calls.push(`write-action-status=${status}`), end: () => {} },
)
console.log('\n[面板 API]', calls.join(' | '))

// ---------- 2) 真实 DSH_HOME 只读性验证 ----------
const realHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
if (existsSync(realHome)) {
  const before = treeFingerprint(join(realHome, 'storages'))
  const beforeSessions = treeFingerprint(join(realHome, 'sessions')).length
  // 用真实 home 走一次 CLI 取证路径（只读）。
  const { guardInspect } = await import('../lib/inspect.js')
  const report = guardInspect({ dshHome: realHome, maxSessions: 30, probes: { listProcesses: () => [], listPorts: () => new Set(), now: () => new Date(0) } })
  const after = treeFingerprint(join(realHome, 'storages'))
  const afterSessions = treeFingerprint(join(realHome, 'sessions')).length
  console.log('\n[真实 DSH_HOME 只读性]')
  console.log('  storages 指纹一致 :', JSON.stringify(before) === JSON.stringify(after) ? '✅' : '❌')
  console.log('  sessions 文件数一致:', beforeSessions === afterSessions ? `✅ (${beforeSessions})` : `❌ ${beforeSessions} → ${afterSessions}`)
  console.log('  取证结论 : 工作区 %d 个，磁盘会话 %d 个，解出 %d 个身份头',
    report.workspaces.length, report.sessions.total, report.sessions.decoded)
  console.log('  注入的内部记录 :', report.sessions.subagentRecords, '条（被标注为非对话）')
  console.log('  被标为「未登记对话」的 :', report.sessions.byWorkspace.reduce((sum, row) => sum + row.unregisteredConversations, 0), '条')
  console.log('  agent-guard 目录是否被误建在真实 home :',
    existsSync(join(realHome, 'agent-guard')) ? '⚠ 存在（需确认是否由本次引入）' : '✅ 不存在，本次未在真实 home 写任何东西')
} else {
  console.log('\n[真实 DSH_HOME] 未找到，跳过。')
}

temp.cleanup()
console.log('\n完成。')
