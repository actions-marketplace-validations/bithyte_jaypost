#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import os from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInit } from './commands/init.ts'
import type { InitArgs } from './commands/init.ts'
import { runOwner } from './commands/owner.ts'
import { runTest } from './commands/test.ts'
import { DEFAULT_PORT, loadConfig } from './config.ts'
import { runService } from './service.ts'
import { realExec } from './install/exec.ts'
import { installPaths } from './install/paths.ts'
import { askSecret, ask, choose, closePrompts } from './install/prompt.ts'
import { portFree, validateToken } from './install/system.ts'
import { makeTargets } from './install/targets.ts'
import { waitForPairing } from './install/wait.ts'
import { VERSION } from './version.ts'

const USAGE = `Usage: telegram-approval-bot <command>

Commands:
  init         set up the bot token and install the service
  start        run the service in the foreground
  status       show service and pairing state
  test         send a test approval request
  reset-owner  clear the paired owner so a new one can pair
  uninstall    remove the service
  --version    print the version
  --help       show this help`

const NOT_BUILT = new Set(['status', 'reset-owner', 'uninstall'])

function pickPort(): number {
  try {
    return loadConfig().port
  } catch {
    const p = Number(process.env.PORT)
    return Number.isInteger(p) && p > 0 ? p : DEFAULT_PORT
  }
}

const INIT_USAGE = 'Usage: telegram-approval-bot init [systemd|compose|quadlet] [--port N]'

export function parseInitArgs(argv: string[]): InitArgs | undefined {
  const out: InitArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--port') {
      const v = argv[++i]
      const n = v !== undefined && /^\d+$/.test(v) ? Number(v) : NaN
      if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined
      out.port = n
    } else if (a === '--tarball') {
      const v = argv[++i]
      if (!v) return undefined
      out.tarball = resolve(v)
    } else if ((a === 'systemd' || a === 'compose' || a === 'quadlet') && !out.target) {
      out.target = a
    } else return undefined
  }
  return out
}

async function initCommand(argv: string[]): Promise<number> {
  const args = parseInitArgs(argv)
  if (!args) {
    console.error(INIT_USAGE)
    return 2
  }
  const paths = installPaths()
  const targets = makeTargets(
    { exec: realExec, paths, env: process.env, user: os.userInfo().username },
    { selfPath: realpathSync(fileURLToPath(import.meta.url)), nodePath: process.execPath },
  )
  const ac = new AbortController()
  const onSigint = () => ac.abort()
  process.on('SIGINT', onSigint)
  try {
    return await runInit(args, {
      targets,
      paths,
      prompt: { ask, askSecret, choose },
      validateToken,
      portFree,
      wait: waitForPairing,
      print: (s) => console.log(s),
      signal: ac.signal,
      version: VERSION,
    })
  } finally {
    process.off('SIGINT', onSigint)
    closePrompts()
  }
}

export async function main(argv: string[]): Promise<number> {
  const [cmd] = argv
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE)
    return 0
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION)
    return 0
  }
  if (cmd === 'start') {
    await runService()
    return 0
  }
  if (cmd === 'test') return runTest(pickPort())
  if (cmd === 'init') return initCommand(argv.slice(1))
  if (cmd === 'owner') return runOwner(argv.slice(1))
  if (NOT_BUILT.has(cmd)) {
    console.error('not implemented')
    return 1
  }
  console.error(`Unknown command: ${cmd}\n\n${USAGE}`)
  return 2
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  // `start` keeps the process alive via the server and bot; only exit for other commands.
  if (process.argv[2] !== 'start') process.exit(code)
}
