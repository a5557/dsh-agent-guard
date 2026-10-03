/**
 * 同源只读面板（`DESIGN.md` §9）。
 *
 * ## 为什么用纯 HTML 而不是官方 client bundle
 *
 * 实测（VERIFY.md Q3）：官方 client bundle 必须是打包器产物
 * （`window.__ModuleLoader__.load({ id, factory })`），且 `dsh.client` 需要在 `exports`
 * 里提供 `./client`；缺了会在加载期抛错。官方要求用 tsdown 构建，没有零构建的发布路径。
 *
 * 因此这里走**宿主侧同源 HTTP**：零构建、零依赖、可验证，且不会因为塞进一个可能让产品 UI
 * 崩掉的 bundle 而影响其他插件。代价是它不像原生面板那样嵌在侧边栏里——这个取舍在
 * README 里如实写明，不假装是原生面板。
 *
 * ## 红线
 *
 * 面板**不提供任何修改 DSH 数据的按钮**，只有三个只读视图：状态、最近记录、回滚点。
 * 所有数据都从插件自己的目录读，且渲染时做 HTML 转义。
 */

/** 面板页：零构建、零依赖、无外部资源。 */
export function panelHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-agent-guard 护栏面板</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 20px;
         background: #0f1115; color: #e6e6e6; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 12px; margin: 0 0 8px; opacity: .7; font-weight: 600; }
  .sub { opacity: .65; font-size: 12px; margin-bottom: 16px; }
  .card { border: 1px solid #2a2f3a; border-radius: 10px; padding: 12px; margin: 12px 0; background: #14171e; }
  .row { display: flex; gap: 8px; align-items: flex-start; padding: 3px 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 7px; flex: 0 0 auto; background: #888; }
  .ok { background: #2ea043; } .warn { background: #d29922; } .bad { background: #f85149; }
  .k { opacity: .65; min-width: 7.5em; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .note { color: #d29922; font-size: 12px; }
  .muted { opacity: .6; font-size: 12px; }
  button { font: inherit; padding: 6px 12px; margin: 0 6px 6px 0; border-radius: 8px;
           border: 1px solid #3a3f4b; background: #1a1d24; color: inherit; cursor: pointer; }
  button:hover { border-color: #5b8cff; }
  ul { margin: 4px 0; padding-left: 18px; }
  li { padding: 1px 0; }
</style></head>
<body>
<h1>dsh-agent-guard 护栏面板</h1>
<div class="sub">只读视图。本面板<strong>不提供任何修改 DSH 数据的功能</strong>；没有任何回滚按钮，
回滚是人工动作并需要自行保留退路。</div>
<div id="refresh"></div>
<div class="card"><h2>护栏状态</h2><div id="status" class="muted">尚未读取</div></div>
<div class="card"><h2>回滚点</h2><div id="snapshots" class="muted">尚未读取</div></div>
<div class="card"><h2>最近受保护操作（不含命令原文）</h2><div id="recent" class="muted">尚未读取</div></div>
<div id="note" class="note"></div>
<script>
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function row(state, label, text) {
    return '<div class="row"><span class="dot ' + state + '"></span><span>'
      + '<span class="k">' + esc(label) + '</span>' + esc(text) + '</span></div>';
  }
  function get(action) {
    return fetch("/agent-guard/api?action=" + encodeURIComponent(action)).then(function (r) { return r.json(); });
  }
  function renderState(s) {
    var out = "";
    out += row(s.enabled ? "ok" : "warn", "护栏", s.enabled ? "已启用" : "已停用（配置 enabled: false）");
    out += row(s.durable ? "ok" : "bad", "数据目录", s.durable ? s.dir : "仅内存（记录会丢失）");
    out += row(s.journal.chainOk ? "ok" : "bad", "日志链", s.journal.chainDetail);
    out += row("", "日志条数", s.journal.records + "（队列 " + s.journal.queued + "）");
    out += row(s.backupEnabled ? "ok" : "warn", "写前备份", s.backupEnabled ? "开启" : "关闭（受保护写入会被拒绝）");
    out += row(s.snapshotEnabled ? "ok" : "warn", "每轮快照", s.snapshotEnabled ? "开启（最小间隔 " + s.scheduler.minIntervalMs + "ms）" : "关闭");
    out += row("", "影响预算", s.goalClass);
    out += row("", "熔断阈值", "同一路径连续 " + s.circuitThreshold + " 次写且状态变化");
    if (s.warning) out += row("warn", "告警", s.warning);
    document.getElementById("status").innerHTML = out;
  }
  function renderSnapshots(list) {
    if (!list || !list.length) { document.getElementById("snapshots").textContent = "暂无回滚点。"; return; }
    var html = "<ul>";
    for (var i = 0; i < list.length; i++) {
      html += "<li class='mono'>" + esc(list[i].id) + " <span class='muted'>" + Math.round(list[i].bytes / 1024) + " KiB</span></li>";
    }
    html += "</ul><div class='muted'>回滚说明请调用 guard_journal(action: \\"rollback\\")；本面板不提供回滚按钮。</div>";
    document.getElementById("snapshots").innerHTML = html;
  }
  function renderRecent(body) {
    var rows = body.rows || [];
    if (!rows.length) { document.getElementById("recent").textContent = "暂无记录。"; return; }
    var html = "<ul>";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var when = typeof r.ts === "string" ? r.ts.replace("T", " ").slice(0, 19) : "?";
      var targets = Array.isArray(r.targets) ? r.targets.length : 0;
      html += "<li class='mono'>" + esc(when) + " | " + esc(r.tool) + " | " + esc(r.action) + " | "
        + esc(r.decision) + (targets ? " | 目标 " + targets + " 个" : "") + "</li>";
    }
    html += "</ul>";
    document.getElementById("recent").innerHTML = html;
  }
  function load() {
    document.getElementById("note").textContent = "";
    get("state").then(renderState).catch(function (e) {
      document.getElementById("note").textContent = "读取状态失败：" + e;
    });
    get("state").then(function (s) { renderSnapshots(s.snapshots); }).catch(function () {});
    get("recent").then(renderRecent).catch(function (e) {
      document.getElementById("note").textContent = "读取记录失败：" + e;
    });
  }
  var box = document.getElementById("refresh");
  var button = document.createElement("button");
  button.textContent = "刷新（只读）";
  button.onclick = load;
  box.appendChild(button);
  load();
</script>
</body></html>`
}
