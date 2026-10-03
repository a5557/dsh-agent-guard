#!/usr/bin/env node
/**
 * `dsh-agent-guard` standalone CLI — read-only evidence capture.
 *
 * This is the v0 delivery described in `DESIGN.md` §15 ("a skill + a read-only
 * inspection script + a small snapshot tool, placed in the workspace, with no profile
 * changes"). It runs entirely OUTSIDE the host process, so it works even when DSH
 * will not start — the situation where evidence matters most.
 *
 * It writes nothing: no files, no caches, no profiles. Everything it prints is
 * derived from reading the current DSH home.
 *
 * Usage:
 *   dsh-agent-guard inspect [--json] [--redact] [--dsh-home <path>]
 *                           [--workspace <path>] [--max-sessions <n>] [--no-headers]
 */

import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { formatReport, guardInspect } from '../lib/index.js'
import { INSPECT_SCOPES } from '../lib/inspect.js'

/** Exit codes: 0 success, 2 usage error, 1 unexpected failure. */
const EXIT_OK = 0
const EXIT_USAGE = 2
const EXIT_FAILURE = 1

const HELP = `dsh-agent-guard — 只读取证（v0）

用法：
  dsh-agent-guard inspect [选项]

选项：
  --json                 输出机器可读的 JSON（默认输出人类可读摘要）
  --redact               脱敏输出：工作区路径/标题/id 替换为占位符
  --dsh-home <path>      指定 DSH 数据目录（默认取 $DSH_HOME，再退回 ~/.dsh）
  --workspace <path>     只看某个工作区
  --max-sessions <n>     最多解出多少个会话身份头（默认 500）
  --no-headers           只做目录级清点，不解压身份头（更快，但无法区分 origin）
  --scope <a,b,c>        采集范围，可选：${INSPECT_SCOPES.join(', ')}
  -h, --help             显示本帮助

说明：
  - 本命令只读取，不写入任何文件；不修数据、不迁移、不提供自动修复。
  - "未登记" 永远与 origin 一并给出：origin:"subagent" 的内部记录会被标注为
    countsAsConversation:false，因此「磁盘目录数 ≠ 登记数」不等于数据丢失。
  - 读不出来的会话会被标为 unreadable/incomplete（不确定），绝不当作"没有记录"。
`

/**
 * Parse command-line arguments.
 *
 * Hand-rolled rather than pulled from a dependency: this package's whole point is
 * being auditable, and zero runtime dependencies is part of that promise
 * (`DESIGN.md` §11).
 *
 * @param {string[]} argv - arguments after the executable and command.
 * @returns {{options: object, error: string|null, help: boolean}} the parse result.
 */
export function parseArgs(argv) {
  const options = { json: false, redact: false, headers: true }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    switch (token) {
      case '--json':
        options.json = true
        break
      case '--redact':
        options.redact = true
        break
      case '--no-headers':
        options.headers = false
        break
      case '-h':
      case '--help':
        return { options, error: null, help: true }
      case '--dsh-home':
      case '--workspace':
      case '--max-sessions':
      case '--scope': {
        const value = argv[i + 1]
        if (value === undefined || value.startsWith('--')) {
          return { options, error: `${token} 需要一个值`, help: false }
        }
        i += 1
        if (token === '--dsh-home') options.dshHome = value
        if (token === '--workspace') options.workspace = value
        if (token === '--max-sessions') {
          const parsed = Number(value)
          if (!Number.isInteger(parsed) || parsed <= 0) {
            return { options, error: `--max-sessions 需要正整数，收到 ${value}`, help: false }
          }
          options.maxSessions = parsed
        }
        if (token === '--scope') {
          const requested = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
          const unknown = requested.filter((part) => !INSPECT_SCOPES.includes(part))
          if (unknown.length > 0) {
            return { options, error: `未知 scope：${unknown.join(', ')}；可用：${INSPECT_SCOPES.join(', ')}`, help: false }
          }
          options.scope = requested
        }
        break
      }
      default:
        return { options, error: `未知选项：${token}`, help: false }
    }
  }
  return { options, error: null, help: false }
}

/**
 * Run one inspection and return the process exit code.
 *
 * @param {object} options - parsed options.
 * @param {{write?: (text: string) => void, writeError?: (text: string) => void}} [io]
 *   - injectable output sinks, so the CLI is testable without spawning a process.
 * @returns {number} the exit code.
 */
export function runInspect(options, io = {}) {
  const write = io.write ?? ((text) => process.stdout.write(text))
  const writeError = io.writeError ?? ((text) => process.stderr.write(text))

  try {
    const report = guardInspect({
      dshHome: options.dshHome,
      workspace: options.workspace,
      maxSessions: options.maxSessions,
      includeHeaders: options.headers !== false,
      workspaceTitleMode: options.redact === true ? 'redacted' : 'real',
      scope: options.scope,
    })
    write(options.json === true ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`)
    return EXIT_OK
  } catch (error) {
    writeError(`取证失败：${error?.message ?? String(error)}\n`)
    writeError('这不是「没有问题」，而是「没有得出结论」——请把上面的原始错误一并保留。\n')
    return EXIT_FAILURE
  }
}

/**
 * CLI entry point.
 *
 * @returns {number} the process exit code.
 */
export function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (command === undefined || command === '-h' || command === '--help') {
    process.stdout.write(HELP)
    return command === undefined ? EXIT_USAGE : EXIT_OK
  }
  if (command !== 'inspect') {
    process.stderr.write(`未知命令：${command}\n\n${HELP}`)
    return EXIT_USAGE
  }

  const parsed = parseArgs(rest)
  if (parsed.help) {
    process.stdout.write(HELP)
    return EXIT_OK
  }
  if (parsed.error !== null) {
    process.stderr.write(`${parsed.error}\n\n${HELP}`)
    return EXIT_USAGE
  }
  return runInspect(parsed.options)
}

// Only act when executed directly, so importing this module in tests is inert.
// `pathToFileURL` handles Windows drive letters and percent-encoding correctly,
// which naive string concatenation does not.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
