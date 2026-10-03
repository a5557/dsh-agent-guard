# dsh-agent-guard

> **A DSH guardrail plugin that makes reading first-hand evidence the easiest path.**
> Zero network. Zero telemetry. Zero runtime dependencies. Read-only in v0.

`dsh-agent-guard` exists because of a real incident: an agent never read the primary
evidence, mistook a normal design for a defect, and then rewrote the application's own
private storage — crashing the app. This plugin is the guardrail that incident should
have hit.

**v0 scope (this release): evidence capture only.** One command produces an authoritative,
comparable snapshot of DSH state — registered workspaces, session identity headers,
directory layout, and whether the host is running. It writes nothing.

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
| R3 **Impact budget out of balance** | A display problem is "fixed" by rewriting all core data | Impact-budget rules (v1) refuse core-data writes for display-classified goals |
| R4 **Uncertainty handed to the user as one double-click** | A destructive script is delivered as a `.bat` | Generating such a script is a flagged action, never a "one-click" deliverable |

## Install

```bash
# From a local checkout (path must be absolute):
dsh plugin --profile <profile> add <absolute-path-to-this-directory>

# Once published, pin the exact version:
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

### As a tool (installed)

Ask the agent to inspect DSH state, or call the tool directly:

```
guard_inspect(scope?, workspace?, maxSessions?, includeHeaders?, redact?)
guard_journal(action?, limit?, snapshot?)
```

`guard_journal` shows the guard's own state (enabled, storage mode, hash-chain health,
rollback points) and the most recent protected operations — **without command text**. Its
`rollback` action returns *human* rollback instructions; there is no automatic rollback.

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

### As a standalone CLI (no profile changes at all)

The v0 design goal is that this works **even when DSH will not start** — which is exactly
when evidence matters most:

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

**What v0 does**

- reads the workspace registry, session identity headers, directory layout and host state;
- reports findings with stable codes for scripting and testing;
- distinguishes user conversations from internal records, and unknown from zero.

**What v0 does NOT do**

- it does not write, move, rename, delete or "repair" anything;
- it does not create snapshots or journals yet (v1);
- it does not block anything yet (v1 — see the honest capability notes below).

**Red lines (permanent, by design)**

- never writes to `$DSH_HOME/sessions/`, `storages/`, or `profiles/`;
- never reads the *contents* of the credentials file — existence and metadata only;
- provides no "one-click repair/migration" for DSH data, ever;
- no network access, no telemetry, no install hooks;
- does not ship a double-clickable script that modifies DSH data.

## Honest capability notes (planned for v1)

Interception in DSH is real and can hard-block a tool call before it executes. That said,
this plugin will be honest in its README about what it can and cannot cover:

**Covered:** direct tool calls, MCP tools, PTC (`run_code`) sub-calls, and in-process
subagents — all pass through one `tools/pre-execute` gate where `deny` short-circuits
before dispatch.

**Not covered:** `rename`/`delete` performed inside opaque `pwsh`/`bash` command text (DSH
ships no rename or delete tool, so such commands can only be heuristically parsed);
background jobs; host terminals; client/HTTP host APIs; and a user double-clicking a
script. So the correct claim is "can block this session's tool calls", never "blocks all
damage".

## Compatibility

| Component | Verified version |
|---|---|
| DSH | 0.1.7-rc.2 |
| Node | ≥ 22 (uses built-in `node:zlib` zstd; verified on 24.x) |
| Platform | Windows verified; core is path-string only, Windows-specific probes degrade to "unsupported" elsewhere |
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

## Documentation

- [`VERIFY.md`](./VERIFY.md) — every API claim with its first-hand evidence, plus known gaps
- [`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md) — scope, module layout, acceptance criteria
- [`docs/incident-redacted.md`](./docs/incident-redacted.md) — the incident, mechanism only

> The full design document and the release/verification reports are intentionally kept out of
> this repository: they are working documents tied to the author's local environment.
> `VERIFY.md` carries the API conclusions that matter to users of this plugin.

## License

MIT.
