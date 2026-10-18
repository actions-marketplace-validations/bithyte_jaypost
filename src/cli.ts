#!/usr/bin/env node
import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInit } from './commands/init.ts'
import type { InitArgs } from './commands/init.ts'
import { runOwner } from './commands/owner.ts'
import { runResetOwner } from './commands/reset-owner.ts'
import { runStatus } from './commands/status.ts'
import { runTest } from './commands/test.ts'
import { runUninstall } from './commands/uninstall.ts'
import { DEFAULT_PORT, loadConfig } from './config.ts'
import { runService } from './service.ts'
import { realExec } from './install/exec.ts'
import { installPaths } from './install/paths.ts'
import { clackPrompts } from './install/prompt.ts'
import type { TargetName } from './install/state.ts'
import { portFree, validateToken } from './install/system.ts'
import { makeTargets, TARGET_ORDER } from './install/targets.ts'
import { defaultFetchStatus, waitForPairing } from './install/wait.ts'
import { VERSION } from './version.ts'

function pickPort(): number {
  try {
    return loadConfig().port
  } catch {
    const p = Number(process.env.PORT)
    return Number.isInteger(p) && p > 0 ? p : DEFAULT_PORT
  }
}

function parsePort(v: string): number {
  const n = /^\d+$/.test(v) ? Number(v) : NaN
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new InvalidArgumentError('must be an integer 1-65535')
  }
  return n
}

function initCommand(args: InitArgs): Promise<number> {
  const paths = installPaths()
  const targets = realTargets(paths)
  return withSigint((ac) =>
    runInit(args, {
      targets,
      paths,
      prompt: clackPrompts(ac.signal),
      validateToken,
      portFree,
      wait: waitForPairing,
      print: (s) => console.log(s),
      signal: ac.signal,
      version: VERSION,
    }),
  )
}

function realTargets(paths: ReturnType<typeof installPaths>) {
  return makeTargets(
    { exec: realExec, paths, env: process.env, user: os.userInfo().username },
    { selfPath: realpathSync(fileURLToPath(import.meta.url)), nodePath: process.execPath },
  )
}

async function withSigint(fn: (ac: AbortController) => Promise<number>): Promise<number> {
  const ac = new AbortController()
  const onSigint = () => ac.abort()
  process.on('SIGINT', onSigint)
  try {
    return await fn(ac)
  } finally {
    process.off('SIGINT', onSigint)
  }
}

function statusCommand(): Promise<number> {
  const paths = installPaths()
  return runStatus({
    targets: realTargets(paths),
    paths,
    fetchStatus: defaultFetchStatus,
    print: (s) => console.log(s),
  })
}

function resetOwnerCommand(): Promise<number> {
  const paths = installPaths()
  const targets = realTargets(paths)
  return withSigint((ac) =>
    runResetOwner({
      targets,
      paths,
      confirm: clackPrompts(ac.signal).confirm,
      wait: waitForPairing,
      print: (s) => console.log(s),
      signal: ac.signal,
    }),
  )
}

function uninstallCommand(): Promise<number> {
  const paths = installPaths()
  const targets = realTargets(paths)
  return withSigint((ac) =>
    runUninstall({
      targets,
      paths,
      confirm: clackPrompts(ac.signal).confirm,
      print: (s) => console.log(s),
      signal: ac.signal,
    }),
  )
}

export async function main(argv: string[]): Promise<number> {
  let code = 0
  const program = new Command('telegram-approval-bot')
    .version(VERSION, '-v, --version')
    .exitOverride()
  program
    .command('init')
    .description('set up the bot token and install the service')
    .addArgument(new Argument('[target]').choices(TARGET_ORDER))
    .option('--port <n>', "API port (default 8787, or the existing install's)", parsePort)
    // Installs an unpublished build; for testing.
    .addOption(new Option('--tarball <path>').hideHelp())
    .action(async (target: TargetName | undefined, opts: { port?: number; tarball?: string }) => {
      code = await initCommand({
        ...(target ? { target } : {}),
        ...(opts.port === undefined ? {} : { port: opts.port }),
        ...(opts.tarball === undefined ? {} : { tarball: resolve(opts.tarball) }),
      })
    })
  program
    .command('start')
    .description('run the service in the foreground')
    .action(() => runService())
  program
    .command('status')
    .description('show service and pairing state')
    .action(async () => {
      code = await statusCommand()
    })
  program
    .command('test')
    .description('send a test approval request')
    .action(async () => {
      code = await runTest(pickPort(), installPaths().installFile)
    })
  program
    .command('reset-owner')
    .description('clear the paired owner so a new one can pair')
    .action(async () => {
      code = await resetOwnerCommand()
    })
  program
    .command('uninstall')
    .description('remove the service')
    .action(async () => {
      code = await uninstallCommand()
    })
  // Runs inside containers to read or clear the owner in the data volume.
  program
    .command('owner', { hidden: true })
    .argument('[args...]')
    .action((args: string[]) => {
      code = runOwner(args)
    })
  try {
    await program.parseAsync(argv.length === 0 ? ['--help'] : argv, { from: 'user' })
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err
    // Help and version exit 0; usage errors (already printed) exit 2.
    return err.exitCode === 0 ? 0 : 2
  }
  return code
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  // `start` keeps the process alive via the server and bot; only exit for other commands.
  if (process.argv[2] !== 'start') process.exit(code)
}
