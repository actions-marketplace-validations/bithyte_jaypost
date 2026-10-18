import { PromptAborted } from '../install/prompt.ts'
import type { InstallPaths } from '../install/paths.ts'
import { removeInstall, writeInstall } from '../install/state.ts'
import type { InstallRecord, TargetName } from '../install/state.ts'
import type { Secrets, Target } from '../install/target.ts'
import { defaultTarget, detect, findExisting } from '../install/targets.ts'
import type { waitForPairing } from '../install/wait.ts'

export interface InitDeps {
  targets: Record<TargetName, Target>
  paths: InstallPaths
  prompt: {
    ask: (q: string) => Promise<string>
    askSecret: (q: string) => Promise<string>
    choose: <T extends string>(
      q: string,
      options: { value: T; label: string; disabled?: string }[],
      def: T,
    ) => Promise<T>
  }
  validateToken: (token: string) => Promise<string | undefined>
  portFree: (port: number) => Promise<boolean>
  wait: typeof waitForPairing
  print: (s: string) => void
  signal?: AbortSignal
  version: string
}

export interface InitArgs {
  target?: TargetName
  port?: number
  tarball?: string
}

const DEFAULT_PORT = 8787

const LABELS: Record<TargetName, string> = {
  quadlet: 'Podman Quadlet (user service)',
  compose: 'Docker Compose',
  systemd: 'systemd user service (npm)',
}

async function safeValidate(deps: InitDeps, token: string): Promise<string | undefined> {
  try {
    return await deps.validateToken(token)
  } catch {
    return undefined
  }
}

class Aborted extends Error {}

export async function runInit(args: InitArgs, deps: InitDeps): Promise<number> {
  try {
    return await runInitInner(args, deps)
  } catch (err) {
    if (err instanceof Aborted || err instanceof PromptAborted || deps.signal?.aborted) {
      deps.print('')
      return 130
    }
    deps.print('Install failed; run telegram-approval-bot init again. Check the logs for details.')
    return 1
  }
}

async function runInitInner(args: InitArgs, deps: InitDeps): Promise<number> {
  const { print, prompt } = deps

  const detected = await detect(deps.targets)
  let name: TargetName
  if (args.target) {
    const d = detected.find((x) => x.name === args.target)
    if (!d?.ok) {
      print(`Cannot use ${args.target}: ${d?.reason ?? 'unavailable'}`)
      return 1
    }
    name = args.target
  } else {
    const def = defaultTarget(detected)
    if (!def) {
      print('No install target is available:')
      for (const d of detected) print(`  ${d.name}: ${d.reason}`)
      return 1
    }
    name = await prompt.choose(
      'Where should the bot run?',
      detected.map((d) => ({
        value: d.name,
        label: LABELS[d.name],
        ...(d.ok ? {} : { disabled: d.reason ?? 'unavailable' }),
      })),
      def,
    )
  }
  const target = deps.targets[name]

  let secrets: Secrets = {}
  let rec: InstallRecord | undefined
  const existing = findExisting(deps.paths, deps.targets)
  if (existing) {
    rec = existing.rec
    print(
      `Found an existing ${rec.target} install (version ${rec.version}, port ${rec.port}).` +
        (existing.legacy ? ' It looks like a legacy install from an older setup.' : ''),
    )
    const answer = (await prompt.ask('Replace it? [Y/n] ')).trim().toLowerCase()
    if (answer === 'n' || answer === 'no') return 0
    const old = deps.targets[rec.target]
    secrets = await old.readSecrets(rec)
    // Remove first: the old service may hold the port we're about to check.
    await old.remove(rec, false)
    removeInstall(deps.paths.installFile)
  }

  let token: string | undefined
  if (secrets.token) {
    const bot = await safeValidate(deps, secrets.token)
    if (bot) {
      token = secrets.token
      print(`Reusing the saved bot token (@${bot}).`)
    }
  }
  while (token === undefined) {
    if (deps.signal?.aborted) throw new Aborted()
    const candidate = await prompt.askSecret('Bot token (input hidden): ')
    if (candidate !== '' && (await safeValidate(deps, candidate))) token = candidate
    else print('Telegram rejected that token (or could not be reached). Try again.')
  }

  const port = args.port ?? rec?.port ?? DEFAULT_PORT
  if (!(await deps.portFree(port))) {
    print(`Port ${port} is in use. Pick another with --port.`)
    return 1
  }

  const installed = await target.install({
    version: deps.version,
    port,
    token,
    ...(secrets.ownerId === undefined ? {} : { ownerId: secrets.ownerId }),
    ...(args.tarball === undefined ? {} : { tarball: args.tarball }),
    print,
  })
  writeInstall(deps.paths.installFile, installed)

  const result = await deps.wait({
    port,
    isRunning: () => target.isRunning(installed),
    logsHint: target.logsHint(installed),
    ...(deps.signal ? { signal: deps.signal } : {}),
    print,
  })
  if (result === 'paired') {
    print('Done. Try it: telegram-approval-bot test')
    print('Check state: telegram-approval-bot status')
    print(`Logs: ${target.logsHint(installed)}`)
    return 0
  }
  if (result === 'interrupted') return 130
  print(target.logsHint(installed))
  return 1
}
