# Security Policy

## Reporting a vulnerability

Please report security issues **privately**, through GitHub's private vulnerability
reporting on this repository ("Security" → "Report a vulnerability").

Do **not** open a public issue for a security problem, and do not paste environment
details, paths, session titles or logs into a public issue. If a log excerpt is needed,
produce it with `--redact` first:

```bash
dsh-agent-guard inspect --json --redact
```

There is no personal email address in this project, and none should be added.

## What this plugin is allowed to do (capability red lines)

These are enforced in code, not just promised in prose.

| Capability | Status |
|---|---|
| Read the workspace registry, session identity headers, directory layout | **yes** — read-only |
| Read its OWN data directory (`$DSH_HOME/agent-guard/`) | **yes** |
| Write anywhere else | **no** |
| Write DSH's `sessions/`, `storages/`, `profiles/` | **never** |
| Read the contents of `.credentials.yaml` | **never** — existence and permission metadata only |
| Network access of any kind | **never** — no HTTP client, no telemetry, no analytics |
| Install hooks / postinstall scripts | **none** |
| Modify or "repair" DSH session data | **never** — by design (see `DESIGN.md` appendix A) |
| Provide a one-click repair/migration | **never** |
| Delete user rollback points | **never** — not even on uninstall |

The read-only claim is verifiable rather than asserted: the shipped code contains **no**
write-capable filesystem calls. You can check it yourself:

```bash
grep -RnE "writeFileSync|appendFileSync|createWriteStream|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync|truncateSync" lib/ bin/
```

One deliberate exception to "no writes anywhere else" is the plugin's own guard
directory, which is the only place the journal, backup files and snapshots are written.

### Does the session sandbox constrain this plugin? No — and that is stated deliberately

Verified at code level (see `VERIFY.md` appendix D): the session sandbox works by **replacing
the `ctx.fs` service** (`SandboxedFileSystem extends LocalFileSystem`, overriding
`writeText`/`editText` to resolve a `sandboxPolicy`). Its consumers are the model-facing tool
packages and the sandbox decorators; `dsh-fs-local` itself never sees a policy.

Consequently:

| Operation | Constrained by the session sandbox? |
|---|---|
| The model calling `write` / `edit` | yes |
| The model calling `pwsh` / `bash` through the sandboxed shell | yes |
| **This plugin writing via `node:fs` inside the host process** | **no** |

This is not a privilege escalation — a host-process plugin already has that access — but it
must be disclosed rather than left implicit, so nobody assumes the guard sits *inside* the
sandbox. It is also why the guard's own storage is not weakened by the policy it monitors
(design decision D8 in `IMPLEMENTATION-PLAN.md`).

Because an outer mechanism (OS ACLs, a restrictive deployment default) could still refuse the
write, the plugin keeps a **three-step degradation chain** and reports which step it landed on
rather than assuming success:

1. `$DSH_HOME/agent-guard/` (documented location);
2. a temporary directory (degraded, still durable, with a warning);
3. memory-only (records would be lost, stated plainly as a warning).

## What this plugin CANNOT protect against

So that nobody relies on a capability it does not have:

- **Opaque shell command text.** DSH ships no rename or delete tool, so those actions
  appear only as `pwsh`/`bash` command text. Path extraction from command text is a
  heuristic, not a guarantee.
- **Background jobs.** A `run_in_background` command is handed to a job registry; a
  foreground call that times out is *promoted* to a job after the guard already ran.
- **Host terminals.** `ctx.terminals` is a PTY service and registers no tools.
- **Client / HTTP host APIs.** They do not pass through the tool pipeline.
- **Anything outside this process**, including a user double-clicking a script.

The accurate claim is: **it can block this session's tool calls.** It is not a
sandbox, it does not replace DSH's own permission system, and it is not a substitute
for backups.

## Privacy

- No data leaves the machine. There is no network code in this package.
- The journal records the action, the classification and the decision. It does **not**
  record command text (only a 12-character digest), message content, or credentials.
- Backup file names use a content-hash prefix rather than the original file name, so the
  plugin's own directory structure does not disclose which file was backed up.
- `--redact` replaces workspace paths, titles and ids with placeholders.
- Rollback instructions are printed as guidance for a human. The plugin never rewrites
  DSH storage automatically, and never generates a double-clickable script that does.

## Tamper evidence, not tamper prevention

`journal.jsonl` is append-only and each record carries `prevHash`, forming a hash chain.
Editing or removing a record breaks the chain and is **detectable**
(`guard_journal` reports it). This is tamper *evidence*.

Anyone with write access to the guard directory can still rewrite the whole chain. Real
protection against that requires an out-of-band baseline, which is the separate job of a
launch-time tool such as `dsh-protect`. The two are complementary: this plugin covers
in-band process governance; an out-of-band tool covers static baselines.
