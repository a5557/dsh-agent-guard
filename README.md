# dsh-agent-guard

> **A DSH guardrail plugin that makes reading first-hand evidence the easiest path —
> and makes writing DSH's private storage the hardest one.**
> Zero network. Zero telemetry. Zero runtime dependencies.

`dsh-agent-guard` exists because of a real incident: an agent never read the primary
evidence, mistook a normal design for a defect, and then rewrote the application's own
private storage — crashing the app. This plugin is the guardrail that incident should
have hit.

**Current scope: evidence capture (v0) + write governance (v1)** — read-only inspection,
write-time interception with backup-before-allow, and per-turn rollback points. Every claim
here is backed by first-hand evidence in [`VERIFY.md`](./VERIFY.md).

---

## Why it exists

After some ordinary folder tidying, an agent session saw that the number of session
directories on disk was larger than the number of workspaces registered, concluded that
"40 conversations are missing", and set out to repair it — first with a directory
junction, then with a script that renamed session directories and rewrote the registry.
The app crashed. The "missing" conversations had never been missing: they were internal
`origin: "subagent"` records that DSH **deliberately does not register**.

The root causes, and what this plugin does about them:

| Root cause | What goes wrong | Countermeasure |
|---|---|---|
| R1 **Path is identity** | Workspace identity, storage key and session header all key off an absolute path — moving a folder changes identity | Detect and report; never "repair" by inventing a second name |
| R2 **Summary counts instead of primary evidence** | "Directory count ≠ registry count" is read as data loss | `guard_inspect` reads the first-hand identity header of every session and labels subagent records `countsAsConversation: false` |
| R3 **Impact budget out of balance** | A display problem is "fixed" by rewriting all core data | Impact budget: a `display`-classified goal may not write core data at all |
| R4 **Uncertainty handed to the user as one double-click** | A destructive script is delivered as a `.bat` | Generating such a script is a flagged action, never a "one-click" deliverable |

## Install

```bash
# From a local checkout (path must be absolute):
dsh plugin --profile <profile> add <absolute-path-to-this-directory>

# From the registry, pinned to an exact version:
dsh plugin --profile <profile> add dsh-agent-guard@0.1.0
```

`package.json` declares `dsh.bundle.patch`, so adding the package mounts it as a profile
layer. **A package that declares no `dsh.bundle` is installed but not mounted** — this
plugin does declare it.

To uninstall:

```bash
dsh plugin --profile <profile> remove dsh-agent-guard
```

Uninstalling removes the registration and nothing else — verified end to end against a real
profile: the composed configuration tree is restored byte-for-byte and the plugin line is gone.
It does **not** delete any data, including your rollback points.

Two harmless leftovers come from pnpm itself, not from this plugin (documented rather than
hidden): pnpm keeps the three `node_modules/.bin/dsh-agent-guard*` shims, and the profile's
`package.json` retains an empty `"dependencies": {}`. Removing the guard's data directory is
always a **manual** decision:

```bash
# only after you no longer need the rollback points:
rm -rf "$DSH_HOME/agent-guard"        # Windows: Remove-Item -Recurse "$env:DSH_HOME\agent-guard"
```

## Usage

### As tools (installed)

```
guard_inspect(scope?, workspace?, maxSessions?, includeHeaders?, redact?)
guard_journal(action?, limit?, snapshot?)
```

`guard_inspect` produces the evidence report (read-only, writes nothing anywhere).
`guard_journal` reports the guard's own state: whether it is enabled, whether the journal is
writable and its hash chain intact, the rollback points, and the most recent protected
operations. `action: "trace"` shows one operation in detail; the `rollback` action returns
*human* rollback instructions — there is no automatic rollback.

### Interception (automatic, once installed)

Protected writes are decided at `tools/pre-execute`, where `deny` short-circuits **before**
the tool body runs. That is the difference between blocking and warning after the fact.
Defaults:

- a write to DSH core data while DSH is not known to be stopped → **refused** (fail-closed:
  "cannot determine" counts as running);
- a permitted protected write → **backup first, then ask**; if the backup fails or exceeds
  the budget (8 MiB per file by default) → **refused**, never allowed unbacked;
- two consecutive writes on one path whose checksum changed → **circuit breaker**, handed to
  a human through the approval channel;
- a generated `.bat`/`.cmd`/`.ps1`/`.sh` that references a protected path → flagged as
  `emit-script` and never silently allowed.

### In the UI

The plugin ships a **client half**, so it has a native seat in the interface:

- a **sidebar icon** (the `sidebar.panellist` seat, currently unoccupied by official plugins)
  that opens a **main panel** showing guard status, rollback points, and recent protected
  operations;
- a **settings page** ("环境护栏") under Settings, showing the same status plus exactly how
  to disable the guard.

Both views are strictly read-only: no repair, no migration, and **no rollback button**.
The client half is a hand-written `window.__ModuleLoader__.load` bundle, so this package needs
**no build step** and adds **no devDependencies**. An equivalent same-origin HTTP panel is
also served at `/agent-guard` as a fallback for hosts without a client bundle path.

> The official client bundles are built with tsdown; this package hand-writes the **same
> contract** (`React.createElement` instead of JSX), and unit tests execute the bundle in a
> controlled sandbox, asserting all three seat registrations and the absence of any write path.

## Screenshots

**None yet — and none will be added unless it comes from a real run.** The rule this project
follows is the one it asks of others: evidence before claims. A mocked-up UI would be exactly
the kind of summary-instead-of-evidence this plugin exists to refuse.

| What to capture | Where it comes from |
|---|---|
| `1-panel.png` | The sidebar panel or the settings page **after a normal install**, in a session whose workspace contains nothing private |
| `2-blocked-write.png` | An agent attempting a write to `$DSH_HOME/storages/workspace.json` while DSH is running → the approval/denial message, plus the matching `guard_journal` entry |
| `3-inspect.png` | `dsh-agent-guard inspect --redact` output — redacted, so it can be published as-is |

Contributions of a screenshot taken this way are welcome; please redact paths, titles and
session ids first (`--redact` does it for the CLI view).

### As a standalone CLI (no profile changes at all)

One design goal is that this works **even when DSH will not start** — which is exactly when
evidence matters most:

```bash
dsh-agent-guard inspect                 # human-readable summary
dsh-agent-guard inspect --json          # machine-readable report
dsh-agent-guard inspect --redact        # replace paths/titles/ids with placeholders
dsh-agent-guard inspect --no-headers    # directory-level inventory only (fast)
dsh-agent-guard inspect --scope workspaces,processes
```

It reads `$DSH_HOME` (or `~/.dsh`) and writes nothing anywhere.

## What the output looks like

```
会话：磁盘上 74 个会话目录，本次解出 74 个身份头
  · 用户对话 31 条 | origin:"subagent" 或 delegationDepth > 0 的内部记录 43 条
    （内部记录由应用有意不登记，不计入「缺失对话」）
  · <workspace>：登记 9（磁盘上找到 9）| 磁盘 12（对话 9 / 内部记录 3）| 未登记 3

发现（4 条）
  [info] orphan-session-space
      存在一个会话存储目录，但没有任何已登记工作区的路径编码到它……
  [info] unregistered-subagent-records
      3 条记录带 origin: "subagent" 或 delegationDepth > 0：这是应用有意不登记的内部记录，
      不是丢失的对话。
```

Note the shape of every claim: **an "unregistered" count is always reported together with
its `origin` breakdown**, and unreadable headers are reported as `unreadable` — never as
absence. "Cannot read it" and "it is not there" are different facts.

## Capabilities and red lines

**What it does**

- reads the workspace registry, session identity headers, directory layout and host state;
- intercepts writes to protected paths **before** they run: backup first, then allow; a failed
  backup means the write is refused;
- appends an append-only journal with a **hash chain** (edits are detectable) and creates a
  per-turn rollback point, cleaning up only its own snapshots per the retention policy;
- exposes its own state, recent records and **human** rollback instructions via `guard_journal`;
- reports findings with stable codes for scripting and testing, and distinguishes user
  conversations from internal records, and unknown from zero.

**What it cannot do (and says so)**

| Bypass | Why |
|---|---|
| `rename`/`delete` inside `pwsh`/`bash` command text | DSH ships no rename or delete tool, so such commands appear only as opaque text; paths can be extracted but the action cannot be known |
| Background jobs (`run_in_background`) | The command is handed to the job registry; a foreground call promoted to a job on timeout has already passed the gate |
| Host terminals (`ctx.terminals`) | A PTY service; it registers no tools |
| Client / HTTP host APIs | They do not pass through the tool pipeline |
| A user double-clicking a script; another process writing the same path | The plugin runs inside the host process and cannot govern outside it |

So the correct claim is "**can block this session's tool calls**", never "blocks all damage".

One performance boundary matters too: `pre-execute` has **no timeout** and runs on a **single
ordered lane**, so a backup taken there blocks that turn and cannot be cancelled mid-flight.
The backup budget is therefore deliberately small (8 MiB per file by default; over budget means
the write is refused).

**Permanent red lines (by design)**

- never writes to `$DSH_HOME/sessions/`, `storages/`, or `profiles/`;
- never reads the *contents* of the credentials file — existence and metadata only;
- provides no "one-click repair/migration" for DSH data, ever;
- does not ship a double-clickable script that modifies DSH data;
- no network access, no telemetry, no install hooks.

## Key design trade-offs

- **The rule engine is a pure function with no I/O**, so T1–T9 are directly unit-testable
  without booting the app.
- **Engine faults fail safe**: degraded to "backup + warn", never to an unbacked allow.
- **Its own data directory** is `$DSH_HOME/agent-guard/` (configurable). If the sandbox refuses
  writes it degrades to a temp directory **and says so**; if neither is writable it goes
  memory-only and states that records will be lost. Degrading is fine, degrading silently is not.
- **The journal never stores command text** — only a 12-character digest. Commands, message
  bodies and credentials do not enter the log.
- **Rollback is human-only**: no automatic rollback command, because automatically rewriting
  the application's private storage is precisely the incident's shape.

## Compatibility

| Component | Verified version |
|---|---|
| DSH | 0.1.7-rc.2 |
| Node | ≥ 22 (uses built-in `node:zlib` zstd; also exercised on 24.x, and on Linux/macOS/Windows in CI) |
| Platform | Windows verified in depth; CI runs ubuntu, macOS and Windows on Node 22 and 24. The core is path-string only; Windows-specific probes degrade to "unsupported" elsewhere |
| Runtime dependencies | **none** |

## Frequently asked questions

**Why won't it just fix my session data?**
Because that *is* the incident. DSH's storage is application-private: session directory
names are the encoded keys of workspace paths, and the registry is owned and rewritten by
the app itself. The safe remedies are physical (move the directory back) or in-app (let
the user re-register the workspace) — never a rewrite of private storage by a third party.

**It says 43 records are unregistered. Did I lose conversations?**
No. Those are internal `origin: "subagent"` records, which DSH intentionally does not
register or display. The report always shows this breakdown next to the count so the number
cannot be misread.

**Is my data sent anywhere?**
No. There is no HTTP client in this package, no telemetry, and no analytics. `--redact`
replaces paths, titles and ids with placeholders if you want to share a report.

**What if a header cannot be read?**
It is reported as `unreadable` or `incomplete` and excluded from the conversation/record
tally. Unknown is never silently treated as absent.

**How do I remove the plugin's data?**
After you no longer need the rollback points, delete `$DSH_HOME/agent-guard/` yourself. The
plugin will not do it for you.

## Documentation

- [`VERIFY.md`](./VERIFY.md) — every API claim with its first-hand evidence, plus known gaps
- [`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md) — scope, module layout, acceptance criteria
- [`docs/incident-redacted.md`](./docs/incident-redacted.md) — the incident, mechanism only

> The full design document and the release/verification reports are intentionally kept out of
> this repository: they are working documents tied to the author's local environment.
> `VERIFY.md` carries the API conclusions that matter to users of this plugin.

## Discovery / how to verify this package yourself

This repository carries the topic **`dsh-plugin`**, which is how the DSH ecosystem finds
plugins (community plugin directories and the in-app plugin marketplace all index that tag).

Because the plugin governs writes, "trust me" is not a good enough answer — so the checks ship
**inside the npm package**:

```bash
npm run checks         # read-only audits: encoding, redaction, isolation, coverage, identity space, CI shape
npm run publish:check  # release gates: local suite, version/CHANGELOG, package contents, zero deps, name availability
```

They are zero-dependency and read-only, so you can run them against your own checkout and see
the same evidence the author sees. `npm run publish:check` prints `✅ / ❌ / ⏳` per gate and
never claims a pass for anything it could not measure.

## License

MIT.
