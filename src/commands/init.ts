import { DEFAULT_PORT } from '../config/index.ts'
import {
  detectTargets,
  findDefaultTarget,
  findExistingInstall,
  findLeftoverSecrets,
  writeInstall,
} from '../install/index.ts'
import type { InstallRecord, Secrets, TargetName } from '../install/index.ts'
import { TARGET_LABELS } from './constants.ts'
import { PromptAborted } from './prompts.ts'
import type { InitArgs, InitDeps } from './types.ts'

async function findBotUsername(deps: InitDeps, token: string): Promise<string | undefined> {
  try {
    return await deps.validateToken(token)
  } catch {
    return undefined
  }
}

class Aborted extends Error {}

function redact(message: string, secrets: readonly string[]): string {
  let redacted = message
  for (const secret of secrets) {
    if (secret !== '') {
      redacted = redacted.replaceAll(secret, '***')
    }
  }
  return redacted
}

export async function runInit(args: InitArgs, deps: InitDeps): Promise<number> {
  // Every token string init has seen, so error messages can be shown with them masked.
  const seen: string[] = []
  try {
    return await runInitInner(args, deps, seen)
  } catch (error) {
    if (error instanceof Aborted || error instanceof PromptAborted || deps.signal?.aborted) {
      deps.print('')
      return 130
    }
    const message = error instanceof Error ? error.message : String(error)
    deps.print(`Install failed: ${redact(message, seen)}`)
    deps.print('Run telegram-approval-bot init again. Check the logs for details.')
    return 1
  }
}

async function runInitInner(args: InitArgs, deps: InitDeps, seen: string[]): Promise<number> {
  const { print, prompt } = deps
  const env = deps.env ?? process.env

  const detected = await detectTargets(deps.targets)
  let name: TargetName
  if (args.target) {
    const chosen = detected.find((candidate) => candidate.name === args.target)
    if (!chosen?.ok) {
      print(`Cannot use ${args.target}: ${chosen?.reason ?? 'unavailable'}`)
      return 1
    }
    name = args.target
  } else {
    const defaultName = findDefaultTarget(detected)
    if (!defaultName) {
      print('No install target is available:')
      for (const candidate of detected) {
        if (!candidate.ok) {
          print(`  ${candidate.name}: ${candidate.reason}`)
        }
      }
      return 1
    }
    name = await prompt.select(
      'Where should the bot run?',
      detected.map((candidate) => ({
        value: candidate.name,
        label: TARGET_LABELS[candidate.name],
        ...(candidate.ok ? {} : { disabled: candidate.reason }),
      })),
      defaultName,
    )
  }
  const target = deps.targets[name]

  let secrets: Secrets = {}
  let record: InstallRecord | undefined
  const existing = findExistingInstall(deps.paths, deps.targets, env)
  if (existing) {
    record = existing.record
    print(
      `Found an existing ${record.target} install (version ${record.version}, port ${record.port}).` +
        (existing.legacy ? ' It looks like a legacy install from an older setup.' : ''),
    )
    if (!(await prompt.confirm('Replace it?', true))) {
      return 0
    }
    const old = deps.targets[record.target]
    secrets = await old.readSecrets(record)
    if (secrets.token) {
      seen.push(secrets.token)
    }
    // Record a legacy install too, so a failed run below can still find its config on retry.
    if (existing.legacy) {
      writeInstall(deps.paths.installFile, record)
    }
    // Remove first: the old service may hold the port we're about to check. install.json stays
    // until the new install replaces it; remove() keeps the secrets and is safe to repeat.
    await old.remove(record, false)
  } else {
    secrets = findLeftoverSecrets(deps.paths, env)
    if (secrets.token) {
      seen.push(secrets.token)
      print('Found a bot token kept from an earlier install.')
    }
  }

  let token: string | undefined
  if (secrets.token) {
    const bot = await findBotUsername(deps, secrets.token)
    if (bot) {
      token = secrets.token
      print(`Reusing the saved bot token (@${bot}).`)
    }
  }
  while (token === undefined) {
    if (deps.signal?.aborted) {
      throw new Aborted()
    }
    const candidate = await prompt.password('Bot token')
    seen.push(candidate)
    if (candidate !== '' && (await findBotUsername(deps, candidate))) {
      token = candidate
    } else {
      print('Telegram rejected that token (or could not be reached). Try again.')
    }
  }

  const port = args.port ?? record?.port ?? DEFAULT_PORT
  if (!(await deps.isPortFree(port))) {
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
  if (result === 'interrupted') {
    return 130
  }
  print(target.logsHint(installed))
  return 1
}
