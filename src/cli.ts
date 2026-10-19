#!/usr/bin/env node
import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createClackPrompts,
  defaultFetchStatus,
  runInit,
  runOwner,
  runResetOwner,
  runSendNotify,
  runSendRequest,
  runStatus,
  runTest,
  runUninstall,
  waitForPairing,
} from './commands/index.ts'
import type { InitArgs, SendDeps } from './commands/index.ts'
import { DEFAULT_PORT, loadConfig, VERSION } from './config/index.ts'
import { runService } from './daemon/index.ts'
import { createTargets, resolveInstallPaths, TARGET_ORDER } from './install/index.ts'
import { resolveMcpPort, runMcp } from './mcp/index.ts'
import type { InstallPaths, Target, TargetName } from './install/index.ts'
import { PROVIDERS } from './provider/index.ts'
import { isPortFree, realExec } from './system/index.ts'

const PORT_PATTERN = /^\d+$/

function resolvePort(): number {
  try {
    return loadConfig().port
  } catch {
    const port = Number(process.env.PORT)
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT
  }
}

function parsePort(rawPort: string): number {
  const port = PORT_PATTERN.test(rawPort) ? Number(rawPort) : NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError('must be an integer 1-65535')
  }
  return port
}

function parseTimeout(rawTimeout: string): number {
  const timeout = Number(rawTimeout)
  if (rawTimeout.trim() === '' || !Number.isFinite(timeout) || timeout <= 0) {
    throw new InvalidArgumentError('must be a positive number of seconds')
  }
  return timeout
}

function collect(value: string, previous: readonly string[] | undefined): readonly string[] {
  return [...(previous ?? []), value]
}

function createSendDeps(flagPort: number | undefined, signal: AbortSignal): SendDeps {
  return {
    port: resolveMcpPort(flagPort, process.env, resolveInstallPaths().installFile),
    signal,
    print: (text) => console.log(text),
    printError: (text) => console.error(text),
  }
}

function runInitCommand(args: InitArgs): Promise<number> {
  const paths = resolveInstallPaths()
  const targets = createRealTargets(paths)
  return runWithSigint((controller) =>
    runInit(args, {
      targets,
      paths,
      prompt: createClackPrompts(controller.signal),
      providers: PROVIDERS,
      isPortFree,
      wait: waitForPairing,
      print: (text) => console.log(text),
      signal: controller.signal,
      version: VERSION,
    }),
  )
}

function createRealTargets(paths: InstallPaths): Readonly<Record<TargetName, Target>> {
  return createTargets(
    {
      exec: realExec,
      paths,
      env: process.env,
      user: os.userInfo().username,
      providers: PROVIDERS,
    },
    { selfPath: realpathSync(fileURLToPath(import.meta.url)), nodePath: process.execPath },
  )
}

async function runWithSigint(
  run: (controller: AbortController) => Promise<number>,
): Promise<number> {
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)
  try {
    return await run(controller)
  } finally {
    process.off('SIGINT', onSigint)
  }
}

function runStatusCommand(): Promise<number> {
  const paths = resolveInstallPaths()
  return runStatus({
    targets: createRealTargets(paths),
    paths,
    fetchStatus: defaultFetchStatus,
    print: (text) => console.log(text),
  })
}

function runResetOwnerCommand(): Promise<number> {
  const paths = resolveInstallPaths()
  const targets = createRealTargets(paths)
  return runWithSigint((controller) =>
    runResetOwner({
      targets,
      paths,
      providers: PROVIDERS,
      confirm: createClackPrompts(controller.signal).confirm,
      wait: waitForPairing,
      print: (text) => console.log(text),
      signal: controller.signal,
    }),
  )
}

function runUninstallCommand(): Promise<number> {
  const paths = resolveInstallPaths()
  const targets = createRealTargets(paths)
  return runWithSigint((controller) =>
    runUninstall({
      targets,
      paths,
      confirm: createClackPrompts(controller.signal).confirm,
      print: (text) => console.log(text),
      signal: controller.signal,
    }),
  )
}

/** Takes argv without node and script path; returns the exit code (2 for usage errors). */
export async function main(argv: readonly string[]): Promise<number> {
  let code = 0
  const program = new Command('telegram-ask').version(VERSION, '-v, --version').exitOverride()
  program
    .command('init')
    .description('set up the bot token and install the service')
    .addArgument(new Argument('[target]').choices(TARGET_ORDER))
    .option('--port <n>', "API port (default 8787, or the existing install's)", parsePort)
    .addOption(
      new Option('--provider <name>', 'chat app to use').choices(
        PROVIDERS.map((provider) => provider.name),
      ),
    )
    // Installs an unpublished build; for testing.
    .addOption(new Option('--tarball <path>').hideHelp())
    .action(
      async (
        target: TargetName | undefined,
        options: {
          readonly port?: number
          readonly tarball?: string
          readonly provider?: string
        },
      ) => {
        code = await runInitCommand({
          ...(target ? { target } : {}),
          ...(options.port === undefined ? {} : { port: options.port }),
          ...(options.provider === undefined ? {} : { provider: options.provider }),
          ...(options.tarball === undefined ? {} : { tarball: resolve(options.tarball) }),
        })
      },
    )
  program
    .command('start')
    .description('run the service in the foreground')
    .action(() => runService())
  program
    .command('status')
    .description('show service and pairing state')
    .action(async () => {
      code = await runStatusCommand()
    })
  program
    .command('test')
    .description('send a test approval request')
    .action(async () => {
      code = await runTest(resolvePort(), resolveInstallPaths().installFile)
    })
  program
    .command('reset-owner')
    .description('clear the paired owner so a new one can pair')
    .action(async () => {
      code = await runResetOwnerCommand()
    })
  program
    .command('uninstall')
    .description('remove the service')
    .action(async () => {
      code = await runUninstallCommand()
    })
  program
    .command('mcp')
    .description('run an MCP server on stdin/stdout for agents')
    .option('--port <n>', 'API port (default: PORT, then the install, then 8787)', parsePort)
    .action(async (options: { readonly port?: number }) => {
      // Not resolvePort(): that reads config.json, which an agent's container may not have.
      code = await runMcp(
        resolveMcpPort(options.port, process.env, resolveInstallPaths().installFile),
      )
    })
  const send = program
    .command('send')
    .description('ask a question or send a notification from a script')
  send
    .command('request')
    .description('ask a question with buttons and print the tapped answer')
    .argument('<text>', 'question to show')
    .requiredOption('-o, --option <label>', 'button label, repeat for each button', collect)
    .requiredOption('--timeout-option <label>', 'answer printed on timeout; one of the options')
    .option('--timeout <seconds>', 'seconds to wait; default and max 300', parseTimeout)
    .option('--project <name>', 'shown as [name] above the question')
    .option('--json', 'print {"answer":...,"timedOut":...} instead of the answer')
    .option('--port <n>', 'API port (default: PORT, then the install, then 8787)', parsePort)
    .action(
      async (
        text: string,
        options: {
          readonly option: readonly string[]
          readonly timeoutOption: string
          readonly timeout?: number
          readonly project?: string
          readonly json?: boolean
          readonly port?: number
        },
      ) => {
        code = await runWithSigint((controller) =>
          runSendRequest(
            {
              text,
              options: options.option,
              timeoutOption: options.timeoutOption,
              ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
              ...(options.project === undefined ? {} : { project: options.project }),
              ...(options.json === undefined ? {} : { json: options.json }),
            },
            createSendDeps(options.port, controller.signal),
          ),
        )
      },
    )
  send
    .command('notify')
    .description("send a message that doesn't need an answer")
    .argument('<text>', 'message to show')
    .option('--project <name>', 'shown as [name] above the message')
    .option('--port <n>', 'API port (default: PORT, then the install, then 8787)', parsePort)
    .action(
      async (text: string, options: { readonly project?: string; readonly port?: number }) => {
        code = await runWithSigint((controller) =>
          runSendNotify(
            { text, ...(options.project === undefined ? {} : { project: options.project }) },
            createSendDeps(options.port, controller.signal),
          ),
        )
      },
    )
  // Runs inside containers to read or clear the owner in the data volume.
  program
    .command('owner', { hidden: true })
    .argument('[args...]')
    .action((args: string[]) => {
      code = runOwner(args)
    })
  try {
    await program.parseAsync(argv.length === 0 ? ['--help'] : argv, { from: 'user' })
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error
    }
    // Help and version exit 0; usage errors (already printed) exit 2.
    return error.exitCode === 0 ? 0 : 2
  }
  return code
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  // `start` keeps the process alive via the server and bot; only exit for other commands.
  if (process.argv[2] !== 'start') {
    process.exit(code)
  }
}
