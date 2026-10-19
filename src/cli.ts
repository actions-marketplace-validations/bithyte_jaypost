#!/usr/bin/env node
import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander'
import { realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSince } from './audit/index.ts'
import { resolveClientToken, resolveTokenFile } from './auth/index.ts'
import {
  createClackPrompts,
  defaultFetchStatus,
  runAudit,
  runInit,
  runLog,
  runOwner,
  runResetOwner,
  runSendNotify,
  runSendRequest,
  runStatus,
  runTest,
  runUninstall,
  waitForPairing,
  writeAll,
} from './commands/index.ts'
import type { InitArgs, LogArgs, SendDeps } from './commands/index.ts'
import { DEFAULT_PORT, loadConfig, VERSION } from './config/index.ts'
import { runService } from './daemon/index.ts'
import { readHookInput, runHook } from './hook/index.ts'
import type { HookDeps } from './hook/index.ts'
import { createTargets, resolveInstallPaths, TARGET_ORDER } from './install/index.ts'
import { resolveMcpPort, runMcp } from './mcp/index.ts'
import type { InstallPaths, Target, TargetName } from './install/index.ts'
import { DEFAULT_PROVIDER, PROVIDERS, requireProvider } from './provider/index.ts'
import { formatOpenApiYaml } from './server/index.ts'
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

function parseSinceOption(raw: string): Date {
  const since = parseSince(raw, new Date())
  if (since === undefined || Number.isNaN(since.getTime())) {
    throw new InvalidArgumentError(
      'must be a duration like 12h, a date like 2026-10-18, or an ISO date-time',
    )
  }
  return since
}

function parseProjectOption(raw: string): string {
  const project = raw.trim()
  if (project === '') {
    throw new InvalidArgumentError('must not be empty')
  }
  return project
}

function parseLimit(raw: string): number {
  const limit = PORT_PATTERN.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new InvalidArgumentError('must be a positive integer')
  }
  return limit
}

function collect(value: string, previous: readonly string[] | undefined): readonly string[] {
  return [...(previous ?? []), value]
}

function createSendDeps(flagPort: number | undefined, signal: AbortSignal): SendDeps {
  return {
    port: resolveMcpPort(flagPort, process.env, resolveInstallPaths().installFile),
    token: resolveClientToken(process.env, resolveTokenFile(process.env)),
    signal,
    print: (text) => console.log(text),
    printError: (text) => console.error(text),
  }
}

function createHookDeps(flagPort: number | undefined, signal: AbortSignal): HookDeps {
  return {
    port: resolveMcpPort(flagPort, process.env, resolveInstallPaths().installFile),
    token: resolveClientToken(process.env, resolveTokenFile(process.env)),
    signal,
    readInput: () => readHookInput(process.stdin, signal),
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
    env: process.env,
  }
}

function resolveMaxTextLength(): number {
  try {
    return loadConfig().provider.maxTextLength
  } catch {
    return requireProvider(PROVIDERS, DEFAULT_PROVIDER).maxTextLength
  }
}

function runOpenApiCommand(file: string | undefined, flagPort: number | undefined): number {
  const yaml = formatOpenApiYaml({
    port: resolveMcpPort(flagPort, process.env, resolveInstallPaths().installFile),
    maxTextLength: resolveMaxTextLength(),
  })
  if (file === undefined) {
    process.stdout.write(yaml)
    return 0
  }
  try {
    writeFileSync(file, yaml)
  } catch (error) {
    console.error(
      `couldn't write ${file}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }
  return 0
}

function runInitCommand(args: InitArgs): Promise<number> {
  const paths = resolveInstallPaths()
  const targets = createRealTargets(paths)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return runWithSignals((controller) =>
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
      ...(timeZone && timeZone !== 'Etc/Unknown' ? { timeZone } : {}),
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

async function runWithSignals(
  run: (controller: AbortController) => Promise<number>,
  signals: readonly NodeJS.Signals[] = ['SIGINT'],
): Promise<number> {
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  for (const signal of signals) {
    process.on(signal, onSignal)
  }
  try {
    return await run(controller)
  } finally {
    for (const signal of signals) {
      process.off(signal, onSignal)
    }
  }
}

function runStatusCommand(): Promise<number> {
  const tokenFile = resolveTokenFile(process.env)
  const paths = resolveInstallPaths()
  return runStatus({
    targets: createRealTargets(paths),
    paths,
    fetchStatus: defaultFetchStatus,
    token: resolveClientToken(process.env, tokenFile),
    tokenFile,
    print: (text) => console.log(text),
  })
}

function runLogCommand(args: LogArgs): Promise<number> {
  const paths = resolveInstallPaths()
  return runLog(args, {
    targets: createRealTargets(paths),
    paths,
    env: process.env,
    version: VERSION,
    now: () => new Date(),
    print: (text) => writeAll(`${text}\n`),
    printError: (text) => console.error(text),
  })
}

function runResetOwnerCommand(): Promise<number> {
  const token = resolveClientToken(process.env, resolveTokenFile(process.env))
  const paths = resolveInstallPaths()
  const targets = createRealTargets(paths)
  return runWithSignals((controller) =>
    runResetOwner({
      targets,
      paths,
      providers: PROVIDERS,
      confirm: createClackPrompts(controller.signal).confirm,
      wait: waitForPairing,
      print: (text) => console.log(text),
      signal: controller.signal,
      token,
    }),
  )
}

function runUninstallCommand(): Promise<number> {
  const paths = resolveInstallPaths()
  const targets = createRealTargets(paths)
  return runWithSignals((controller) =>
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
    .option('--token', 'require an API token (default for new setups)')
    .option('--no-token', "don't require an API token")
    // Installs an unpublished build; for testing.
    .addOption(new Option('--tarball <path>').hideHelp())
    .action(
      async (
        target: TargetName | undefined,
        options: {
          readonly port?: number
          readonly tarball?: string
          readonly provider?: string
          readonly token?: boolean
        },
      ) => {
        code = await runInitCommand({
          ...(target ? { target } : {}),
          ...(options.port === undefined ? {} : { port: options.port }),
          ...(options.provider === undefined ? {} : { provider: options.provider }),
          ...(options.token === undefined ? {} : { token: options.token }),
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
    .command('log')
    .description('show the questions the service asked and how they ended')
    .option(
      '--since <when>',
      'only newer questions: 12h, 7d, 2026-10-18 or an ISO date-time',
      parseSinceOption,
    )
    .option('--project <name>', 'only questions from this project', parseProjectOption)
    .option('-n, --limit <n>', 'show the last N (default 20, or all with --since)', parseLimit)
    .option('--json', 'print one JSON entry per line')
    .action(
      async (options: {
        readonly since?: Date
        readonly project?: string
        readonly limit?: number
        readonly json?: boolean
      }) => {
        code = await runLogCommand({
          ...(options.since === undefined ? {} : { since: options.since }),
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
          ...(options.json === undefined ? {} : { json: options.json }),
        })
      },
    )
  program
    .command('test')
    .description('send a test approval request')
    .action(async () => {
      code = await runTest(
        resolvePort(),
        resolveInstallPaths().installFile,
        resolveClientToken(process.env, resolveTokenFile(process.env)),
      )
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
      const tokenFile = resolveTokenFile(process.env)
      code = await runMcp({
        port: resolveMcpPort(options.port, process.env, resolveInstallPaths().installFile),
        readToken: () => resolveClientToken(process.env, tokenFile),
      })
    })
  program
    .command('openapi')
    .description('print the OpenAPI spec of the HTTP API, or write it to a file')
    .argument('[file]', 'file to write; prints to stdout without one')
    .option('--port <n>', 'API port (default: PORT, then the install, then 8787)', parsePort)
    .action((file: string | undefined, options: { readonly port?: number }) => {
      code = runOpenApiCommand(file, options.port)
    })
  const send = program
    .command('send')
    .description('ask a question or send a notification from a script')
  send
    .command('request')
    .description('ask a question with buttons and print the tapped answer')
    .argument('<text>', 'question to show')
    .requiredOption('-o, --option <label>', 'button label, repeat for each button', collect)
    .requiredOption(
      '-d, --default <label>',
      'answer printed on timeout; added as the last button unless an -o already names it',
    )
    .option(
      '--timeout <seconds>',
      'seconds to wait; default 300, max 86400 (24 h); longer values are capped',
      parseTimeout,
    )
    .option('--project <name>', 'shown as [name] above the question')
    .option('--json', 'print {"answer":...,"timedOut":...} instead of the answer')
    .option('--port <n>', 'API port (default: PORT, then the install, then 8787)', parsePort)
    .action(
      async (
        text: string,
        options: {
          readonly option: readonly string[]
          readonly default: string
          readonly timeout?: number
          readonly project?: string
          readonly json?: boolean
          readonly port?: number
        },
      ) => {
        code = await runWithSignals((controller) =>
          runSendRequest(
            {
              text,
              options: options.option.includes(options.default)
                ? options.option
                : [...options.option, options.default],
              timeoutOption: options.default,
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
        code = await runWithSignals((controller) =>
          runSendNotify(
            { text, ...(options.project === undefined ? {} : { project: options.project }) },
            createSendDeps(options.port, controller.signal),
          ),
        )
      },
    )
  program
    .command('hook')
    .description(
      'answer Claude Code permission prompts and forward notifications (reads a hook event on stdin)',
    )
    .option('--port <n>', 'API port (default: PORT, then the install, then 8787)', parsePort)
    .option('--project <name>', 'shown as [name] (default: the Claude Code project folder)')
    .option(
      '--timeout <seconds>',
      'seconds to wait for an answer; default 300, max 86400 (24 h); longer values are capped',
      parseTimeout,
    )
    .action(
      async (options: {
        readonly port?: number
        readonly project?: string
        readonly timeout?: number
      }) => {
        const args = {
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        }
        code = await runWithSignals(
          (controller) => runHook(args, createHookDeps(options.port, controller.signal)),
          ['SIGINT', 'SIGTERM'],
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
  // Runs inside containers to dump the audit log from the data volume.
  program
    .command('audit', { hidden: true })
    .argument('[args...]')
    .action((args: string[]) => {
      code = runAudit(args)
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
