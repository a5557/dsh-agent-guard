/**
 * In-process test entry point.
 *
 * Why not `node --test <glob>`: that mode spawns one child process per test file
 * with piped stdio, which a confined file sandbox refuses (`spawn EPERM`). Running
 * the same suites in process keeps the tests runnable in both confinement modes and
 * in CI, and removes process-startup overhead.
 *
 * Run directly (`node test/run.mjs`) or through the package script (`npm test`).
 */

import { run } from 'node:test'

// Suite modules register their cases at import time, so importing them first means
// every test exists before the runner starts.
const suites = [
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
for (const suite of suites) {
  await import(new URL(`./${suite}`, import.meta.url).href)
}

const failures = []
let passed = 0
// `files: []` is load-bearing: without it the runner falls back to file discovery,
// which spawns a child per file and fails under confinement. The suites are already
// registered in this process by the imports above.
const stream = run({ concurrency: 1, files: [] })

stream.on('test:pass', (event) => {
  if (event.skip === true) return
  passed += 1
})
stream.on('test:fail', (event) => {
  const error = event.details?.error
  failures.push({
    name: event.name,
    message: error?.message ?? String(error ?? 'unknown failure'),
    stack: typeof error?.stack === 'string' ? error.stack : null,
  })
})

// `run()`'s stream ends rather than closes; awaiting "finished" would hang, so wait
// for the end event that is registered before the runner can emit it.
await new Promise((resolve) => {
  stream.once('end', resolve)
  stream.resume()
})

for (const failure of failures) {
  process.stdout.write(`\nFAIL ${failure.name}\n  ${failure.message}\n`)
  if (failure.stack !== null) {
    const frames = failure.stack
      .split('\n')
      .filter((line) => line.includes('.mjs'))
      .slice(0, 4)
      .join('\n')
    if (frames.length > 0) process.stdout.write(`${frames}\n`)
  }
}

const failed = failures.length
process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
process.exitCode = failed === 0 ? 0 : 1
