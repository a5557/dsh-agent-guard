/**
 * In-process test entry point.
 *
 * ## Why the suites are passed to the runner instead of imported here
 *
 * This file used to `import` every suite and then call `run({ files: [] })`, counting
 * `test:pass` / `test:fail` on the returned stream. Both halves of that were wrong on
 * modern Node:
 *
 * - `files: []` is an EMPTY run -- zero files, zero tests. The suites did run (the
 *   process-level harness reported them), but not through this stream, so the counter
 *   could never see them and printed "0 passed, 0 failed" in all six CI jobs.
 * - The stream from an empty run carries only `test:plan` / `test:diagnostic` /
 *   `test:summary`, so even a correct listener had nothing to count.
 *
 * Passing the files explicitly with `isolation: 'none'` runs them IN this process (no
 * child spawn, which a confined file sandbox refuses with `EPERM`) and yields real
 * per-case events plus an authoritative `test:summary`. A test harness that reports a
 * verdict it did not measure is worse than one that reports nothing, so the count now
 * comes from events this file actually received; if none arrive, the run fails loudly.
 *
 * `isolation: 'none'` requires Node >= 22.8; `engines` pins the whole package at >= 22.
 *
 * Run directly (`node test/run.mjs`) or through the package script (`npm test`).
 */

import { run } from 'node:test'
import { fileURLToPath } from 'node:url'

// Import order is the run order; each suite registers its cases at load time.
const SUITES = [
  'rules.cases.mjs',
  'inspect.cases.mjs',
  'paths.cases.mjs',
  'plugin.cases.mjs',
  'mount.cases.mjs',
  'client.cases.mjs',
  'store.cases.mjs',
  'backup.cases.mjs',
  'guard.cases.mjs',
  'assembly.cases.mjs',
  'visible.cases.mjs',
]
const files = SUITES.map((suite) => fileURLToPath(new URL(`./${suite}`, import.meta.url)))

let passed = 0
let events = 0
const failures = []
let summaryCounts = null

const stream = run({ concurrency: 1, files, isolation: 'none' })
stream.on('data', (event) => {
  events += 1
  if (event.type === 'test:pass' && event.data?.skip !== true) {
    passed += 1
  } else if (event.type === 'test:fail') {
    failures.push({
      name: event.data?.name ?? '<unnamed>',
      message: event.data?.details?.error?.message ?? event.data?.details?.error?.cause?.message ?? 'unknown failure',
      file: event.data?.file ?? null,
      line: event.data?.line ?? null,
    })
  } else if (event.type === 'test:summary') {
    summaryCounts = event.data?.counts ?? null
  }
})

// `run()`'s stream ends rather than closes; awaiting "finished" would hang, so wait
// for the end event that is registered before the runner can emit it.
await new Promise((resolve) => {
  stream.once('end', resolve)
  stream.resume()
})

// The runner does not touch `process.exitCode`, so a failing run must set it here.
if (events === 0) {
  process.stdout.write(
    '\nUNKNOWN: the test runner produced no events at all, so this run measured nothing.\n'
    + 'Treat it as failed: a harness that cannot read its own verdict must not print\n'
    + '"0 failed". Check that `isolation: \'none\'` actually ran the suites in process.\n',
  )
  process.exitCode = 1
} else {
  for (const failure of failures) {
    const where = failure.file === null ? '' : ` (${failure.file}${failure.line === null ? '' : `:${failure.line}`})`
    process.stdout.write(`\nFAIL ${failure.name}${where}\n  ${failure.message}\n`)
  }
  const failed = summaryCounts?.failed ?? failures.length
  const total = summaryCounts?.tests ?? passed + failed
  process.stdout.write(`\n${passed} passed, ${failed} failed (${total} cases)\n`)
  process.exitCode = failed === 0 ? 0 : 1
}
