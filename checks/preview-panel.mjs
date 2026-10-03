// Local preview of the plugin's REAL panel markup, for taking the README screenshot without
// installing the plugin into a working profile.
//
// What is real: the HTML, CSS and render logic come from lib/panel.js (panelHtml()); the state
// JSON comes from describeState() over a real createComponents() instance.
// What is NOT real: the DSH_HOME is a temporary fixture (created and deleted by this script),
// and the rollback-point / recent-operation rows are shaped like real journal rows.
// So a screenshot of this is honest as a UI preview, but it must NOT be captioned as a live
// session. It shows no private path: the fixture lives in the OS temp directory.
//
// Usage:  node checks/preview-panel.mjs        (or: npm run preview)
//         then open the printed URL and screenshot the page.
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createComponents, describeState } from '../lib/index.js'
import { panelHtml } from '../lib/panel.js'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
void ROOT

const home = mkdtempSync(join(tmpdir(), 'guard-preview-'))
for (const dir of ['sessions', 'storages', 'profiles']) mkdirSync(join(home, dir), { recursive: true, mode: 0o700 })
const components = createComponents({
  dshHome: home,
  workspaceRoots: [],
  dshStateProvider: () => ({ running: true, detail: '预览：按「运行中」渲染' }),
})
const state = describeState(components)

// Fixtures, labelled so a reader of the screenshot cannot mistake them for real records.
const view = {
  ...state,
  snapshots: [
    { id: '20261003-181500', bytes: 188416 },
    { id: '20261003-174500', bytes: 187904 },
    { id: '20261003-171500', bytes: 187904 },
  ],
}
const recent = [
  { ts: '2026-10-03T18:20:11.000Z', tool: 'write', action: 'write', decision: 'blocked', targets: 1, reason: '目标属于 DSH 核心数据，且无法确认 DSH 已完全停止：拒绝写入（fail-closed）' },
  { ts: '2026-10-03T18:19:02.000Z', tool: 'write', action: 'emit-script', decision: 'asked', targets: 1, reason: '正在生成一个引用受保护路径的可执行脚本：需要确认，并附人工回滚说明（root cause R4）' },
  { ts: '2026-10-03T18:17:40.000Z', tool: 'edit', action: 'write', decision: 'allowed-with-backup', targets: 1, reason: '写入受保护路径（已确认 DSH 停止）：先备份，再放行' },
]

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/' || url.pathname === '/agent-guard') {
    // The banner is injected by this preview only, never by the plugin.
    const banner = '<div style="font:13px/1.6 system-ui;padding:8px 12px;background:#fff4d6;'
      + 'border-bottom:1px solid #e6c96b">预览：界面与渲染逻辑来自插件本体（lib/panel.js），'
      + '数据为临时目录夹具 —— 截图请勿标注为真实会话。</div>'
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(panelHtml().replace('<body>', `<body>${banner}`))
    return
  }
  if (url.pathname === '/agent-guard/api') {
    const action = url.searchParams.get('action') ?? 'state'
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(action === 'recent' ? { rows: recent } : view))
    return
  }
  response.writeHead(404).end('not found')
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const { port } = server.address()
console.log('dsh-agent-guard 面板预览已启动')
console.log(`  → http://127.0.0.1:${port}/  （在这个页面截图；Ctrl+C 结束，临时目录会自动清理）`)
console.log(`  数据目录（夹具）：${home}`)

const shutdown = () => {
  rmSync(home, { recursive: true, force: true })
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
