/**
 * dsh-agent-guard — 客户端半边（手写的 __ModuleLoader__ bundle）。
 *
 * ## 为什么手写、零构建
 *
 * 官方 client bundle 是打包器（tsdown）产物，形如
 * `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`，
 * 其中的 `react` 通过 `require("react")` 从客户端模块表取得。
 * 本包刻意保持**零构建步骤**（无 devDependencies、无 CI 构建），
 * 因此这里按**同一契约**手写：用 `React.createElement` 代替 JSX。
 *
 * 文件里没有 `import`/`export` 语句，所以 `node --check` 对它也会通过；
 * 真正执行它的是浏览器，`require` 由模块表提供。
 *
 * ## 契约要点（实测见 VERIFY.md Q3）
 *
 * - `package.json` 的 `dsh.client` 只声明 `{ platform, inject }`；
 *   bundle 路径来自 `exports["./client"]`，缺了会在加载期抛错。
 * - 客户端插件体导出 `apply(ctx)` 与 `inject`。
 * - keyed 的 `main` 用 `key`，list 的 `sidebar.panellist` 用**同值** `id`，
 *   两者配对才构成「点图标 → 开面板」。
 * - 数据走**同源 HTTP**（`/agent-guard/api`，宿主半的 webServer 提供），
 *   因此客户端不需要任何额外服务和依赖。
 *
 * ## 红线
 *
 * 两处 UI 都**不提供任何修改 DSH 数据的操作**：没有"修复"、没有"回滚"按钮、
 * 没有"一键迁移"。回滚说明只能通过 `guard_journal` 工具取得，且内容是给人读的步骤。
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-guard',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const NS = 'agent-guard'
    const BASE = '/agent-guard'
    const DOT = { ok: '#2ea043', warn: '#d29922', bad: '#f85149', idle: '#8b949e' }

    /** 内联盾牌图标：不引用任何外部资源。 */
    function createIcon(React) {
      return function GuardIcon() {
        return React.createElement(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
          React.createElement('path', {
            d: 'M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinejoin: 'round',
          }),
          React.createElement('path', {
            d: 'M9 12.2l2.1 2.1L15.2 10',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )
      }
    }

    /** 卡片容器。 */
    function createCard(React) {
      const h = React.createElement
      return (title, children) => h(
        'div',
        { style: { border: '1px solid var(--dsw-alias-border-l1, #2a2f3a)', borderRadius: 10, padding: 12, margin: '12px 0' } },
        h('div', { style: { fontSize: 12, opacity: 0.7, fontWeight: 600, marginBottom: 8 } }, title),
        children,
      )
    }

    /** 面板主体：只读地拉取状态、回滚点与最近记录。 */
    function createPanel(React) {
      const h = React.createElement
      const card = createCard(React)
      return function GuardPanel() {
        const [state, setState] = React.useState(null)
        const [recent, setRecent] = React.useState([])
        const [error, setError] = React.useState(null)
        const [busy, setBusy] = React.useState(false)

        function load() {
          setBusy(true)
          setError(null)
          fetch(BASE + '/api?action=state')
            .then((response) => response.json())
            .then(setState)
            .catch((cause) => setError('读取状态失败：' + cause))
            .then(() => setBusy(false))
          fetch(BASE + '/api?action=recent')
            .then((response) => response.json())
            .then((body) => setRecent(Array.isArray(body.rows) ? body.rows : []))
            .catch(() => { /* 记录读不到不影响状态展示 */ })
        }

        React.useEffect(() => { load() }, [])

        const rows = []
        function row(tone, label, value) {
          rows.push(h('div', {
            key: label + rows.length,
            style: { display: 'flex', gap: 8, padding: '3px 0', alignItems: 'flex-start' },
          },
          h('span', { style: { width: 8, height: 8, borderRadius: '50%', marginTop: 7, flex: '0 0 auto', background: DOT[tone] || DOT.idle } }),
          h('span', { style: { minWidth: '7.5em', opacity: 0.65 } }, label),
          h('span', null, String(value))))
        }

        if (state !== null) {
          row(state.enabled ? 'ok' : 'warn', '护栏', state.enabled ? '已启用' : '已停用（配置 enabled: false）')
          row(state.durable ? 'ok' : 'bad', '数据目录', state.durable ? state.dir : '仅内存（记录会丢失）')
          row(state.journal.chainOk ? 'ok' : 'bad', '日志链', state.journal.chainDetail)
          row('idle', '日志条数', state.journal.records + '（队列 ' + state.journal.queued + '）')
          row(state.backupEnabled ? 'ok' : 'warn', '写前备份', state.backupEnabled ? '开启' : '关闭（受保护写入会被拒绝）')
          row(state.snapshotEnabled ? 'ok' : 'warn', '每轮快照', state.snapshotEnabled ? '开启（最小间隔 ' + state.scheduler.minIntervalMs + 'ms）' : '关闭')
          row('idle', '影响预算', state.goalClass)
          row('idle', '熔断阈值', '同一路径连续 ' + state.circuitThreshold + ' 次写且状态变化')
          if (state.warning) row('warn', '告警', state.warning)
        }

        const snapshotList = state === null ? null : (state.snapshots.length === 0
          ? h('div', { style: { opacity: 0.6 } }, '暂无回滚点。')
          : h('ul', { style: { margin: '4px 0', paddingLeft: 18 } },
              state.snapshots.slice(0, 10).map((snapshot) => h('li', {
                key: snapshot.id,
                style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 },
              }, snapshot.id + '  ' + Math.round(snapshot.bytes / 1024) + ' KiB'))))

        const recentList = recent.length === 0
          ? h('div', { style: { opacity: 0.6 } }, '暂无记录。')
          : h('ul', { style: { margin: '4px 0', paddingLeft: 18 } },
              recent.map((entry, index) => h('li', {
                key: String(entry.seq == null ? index : entry.seq),
                style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 },
              }, String(entry.ts || '').replace('T', ' ').slice(0, 19) + ' | ' + (entry.tool || '?') + ' | ' + (entry.action || '?') + ' | ' + (entry.decision || '?'))))

        return h('div', { style: { padding: 20, fontSize: 14, lineHeight: 1.6 } },
          h('div', { style: { fontSize: 18, fontWeight: 600 } }, 'dsh-agent-guard 护栏'),
          h('div', { style: { opacity: 0.65, fontSize: 12, marginBottom: 12 } },
            '只读视图。本面板不提供任何修改 DSH 数据的功能；没有回滚按钮——回滚是人工动作。'),
          h('button', {
            onClick: load,
            disabled: busy,
            style: {
              font: 'inherit', padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
              border: '1px solid var(--dsw-alias-border-l1, #3a3f4b)', background: 'transparent', color: 'inherit',
            },
          }, busy ? '读取中…' : '刷新（只读）'),
          error !== null ? h('div', { style: { color: DOT.bad, fontSize: 12, marginTop: 8 } }, error) : null,
          state === null && error === null ? h('div', { style: { opacity: 0.6, marginTop: 8 } }, '正在读取…') : null,
          state !== null ? card('护栏状态', h('div', null, rows)) : null,
          state !== null ? card('回滚点', snapshotList) : null,
          card('最近受保护操作（不含命令原文）', recentList))
      }
    }

    /** 设置页：状态 + 「如何停用」的说明。配置本身由 profile 的 patch 管理。 */
    function createSettings(React) {
      const h = React.createElement
      return function GuardSettings() {
        const [state, setState] = React.useState(null)
        React.useEffect(() => {
          fetch(BASE + '/api?action=state')
            .then((response) => response.json())
            .then(setState)
            .catch(() => { /* 状态读不到时只显示说明 */ })
        }, [])

        return h('div', { style: { padding: 20, fontSize: 14, lineHeight: 1.7 } },
          h('div', { style: { fontSize: 16, fontWeight: 600, marginBottom: 4 } }, '环境护栏（dsh-agent-guard）'),
          h('div', { style: { opacity: 0.65, fontSize: 12, marginBottom: 12 } },
            '本插件把「先取证、再动手」和「影响预算」变成流程；它不替代 DSH 的权限系统，也不提供任何一键修改数据的功能。'),
          state === null
            ? h('div', { style: { opacity: 0.6 } }, '正在读取状态…')
            : h('div', null,
                h('div', null, '状态：' + (state.enabled ? '已启用' : '已停用')),
                h('div', null, '数据目录：' + (state.durable ? state.dir : '仅内存（记录会丢失）')),
                h('div', null, '日志链：' + state.journal.chainDetail),
                h('div', null, '影响预算：' + state.goalClass)),
          h('div', { style: { marginTop: 16, opacity: 0.85 } },
            h('div', { style: { fontWeight: 600 } }, '一键停用'),
            h('div', { style: { fontSize: 12 } },
              '在 profile 的 cordis.patch.yml 里把该行的 config.enabled 设为 false，护栏即完全不介入；'
              + '只读取证工具仍可用。注意：关掉备份不会放宽受保护写入——没有备份时一律拒绝。')))
      }
    }

    /** 需要的客户端服务：只有 slot 注册表。数据走同源 HTTP，不需要 remote。 */
    const inject = ['slots']

    /**
     * 客户端插件体：注册侧边栏图标、主面板与设置页。
     *
     * @param {object} ctx - 客户端根上下文。
     * @returns {void}
     */
    function apply(ctx) {
      const React = require('react')
      const Icon = createIcon(React)
      const Panel = createPanel(React)
      const Settings = createSettings(React)

      // keyed 主面板：key 必须与下面 panellist 的 id 一致。
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: NS }, Panel))

      // 侧边栏图标位：官方目前没有占用者，正是给第三方插件的席位。
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: NS,
        order: 40,
        label: () => '护栏',
      }, Icon))

      // 设置页。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 60,
        label: () => '环境护栏',
      }, Settings))
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    return module.exports
  },
})
