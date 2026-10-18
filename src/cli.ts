#!/usr/bin/env node
import { runTest } from './commands/test.ts'
import { DEFAULT_PORT, loadConfig } from './config.ts'
import { runService } from './service.ts'
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

const NOT_BUILT = new Set(['init', 'status', 'reset-owner', 'uninstall', 'owner'])

function pickPort(): number {
  try {
    return loadConfig().port
  } catch {
    const p = Number(process.env.PORT)
    return Number.isInteger(p) && p > 0 ? p : DEFAULT_PORT
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
