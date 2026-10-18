import { DEFAULT_PORT } from '../config/index.ts'
import {
  detectTargets,
  findDefaultTarget,
  findExistingInstall,
  findLeftoverSecrets,
  resolveRecordProvider,
  writeInstall,
} from '../install/index.ts'
import type { InstallRecord, Secrets, TargetName } from '../install/index.ts'
import { findOwnerSetting, findProvider, listSecretValues } from '../provider/index.ts'
import type { Provider, SettingValues } from '../provider/index.ts'
import { TARGET_LABELS } from './constants.ts'
import { PromptAborted } from './prompts.ts'
import type { InitArgs, InitDeps } from './types.ts'

async function findDisplayName(
  provider: Provider,
  settings: SettingValues,
): Promise<string | undefined> {
  try {
    const check = await provider.setup.checkCredentials(settings)
    return check.ok ? check.displayName : undefined
  } catch {
    return undefined
  }
}

/** Secret values of `secrets` when its provider is registered; [] otherwise. */
function listKnownSecretValues(deps: InitDeps, secrets: Secrets | undefined): readonly string[] {
  const provider =
    secrets === undefined ? undefined : findProvider(deps.providers, secrets.provider)
  return provider === undefined || secrets === undefined
    ? []
    : listSecretValues(provider, secrets.settings)
}

class Aborted extends Error {}

/**
 * The provider from `--provider`, the only registered one, or the user's pick (defaulting to the
 * existing install's). Undefined when `--provider` names an unregistered one.
 */
async function chooseProvider(
  args: InitArgs,
  deps: InitDeps,
  record: InstallRecord | undefined,
): Promise<Provider | undefined> {
  const { providers } = deps
  if (args.provider !== undefined) {
    return findProvider(providers, args.provider)
  }
  const [first, second] = providers
  if (first === undefined) {
    throw new Error('no provider is registered')
  }
  if (second === undefined) {
    return first
  }
  const current =
    record === undefined ? undefined : findProvider(providers, resolveRecordProvider(record))
  const chosen = await deps.prompt.select(
    'Which chat app should the bot use?',
    providers.map((provider) => ({ value: provider.name, label: provider.label })),
    current?.name ?? first.name,
  )
  return findProvider(providers, chosen)
}

/** Asks for every prompted setting; empty answers are left out. */
async function promptSettings(provider: Provider, deps: InitDeps): Promise<SettingValues> {
  const values: Record<string, string> = {}
  for (const setting of provider.settings) {
    if (setting.prompt === undefined) {
      continue
    }
    if (deps.signal?.aborted) {
      throw new Aborted()
    }
    const answer = await (setting.secret ? deps.prompt.password : deps.prompt.text)(setting.prompt)
    if (answer !== '') {
      values[setting.configKey] = answer
    }
  }
  return values
}

function isComplete(provider: Provider, settings: SettingValues): boolean {
  return provider.settings
    .filter((setting) => setting.required)
    .every((setting) => Object.hasOwn(settings, setting.configKey))
}

function redact(message: string, secrets: readonly string[]): string {
  let redacted = message
  for (const secret of secrets) {
    if (secret !== '') {
      redacted = redacted.replaceAll(secret, '***')
    }
  }
  return redacted
}

/**
 * Installs or replaces the service and waits for pairing. Returns 0 on success or when the user
 * declines, 1 on failure, 130 on interrupt; error text is shown with known secrets masked.
 */
export async function runInit(args: InitArgs, deps: InitDeps): Promise<number> {
  // Every secret value init has seen, so error messages can be shown with them masked.
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
    deps.print('Run telegram-ask init again. Check the logs for details.')
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
  const existing = findExistingInstall(deps.paths, deps.targets, env)
  const provider = await chooseProvider(args, deps, existing?.record)
  if (provider === undefined) {
    print(`Unknown provider "${args.provider}".`)
    return 1
  }
  const { text } = provider.setup
  let secrets: Secrets | undefined
  let record: InstallRecord | undefined
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
    const oldName = resolveRecordProvider(record)
    if (oldName === provider.name) {
      secrets = await old.readSecrets(record)
      // Mask before anything below can fail with a reused credential in its message.
      seen.push(...listKnownSecretValues(deps, secrets))
    } else {
      const oldProvider = findProvider(deps.providers, oldName)
      const oldLabel = oldProvider?.label ?? oldName
      if (
        !(await prompt.confirm(
          `This deletes the saved ${oldLabel} settings and paired owner. Continue?`,
          false,
        ))
      ) {
        return 0
      }
      if (oldProvider !== undefined) {
        // Read only to mask them; the old provider's settings aren't carried over.
        seen.push(...listKnownSecretValues(deps, await old.readSecrets(record)))
        if (findOwnerSetting(oldProvider) !== undefined) {
          await old.clearOwner(record)
        }
      }
    }
    // Record a legacy install too, so a failed run below can still find its config on retry.
    if (existing.legacy) {
      writeInstall(deps.paths.installFile, record)
    }
    // Remove first: the old service may hold the port we're about to check. install.json stays
    // until the new install replaces it; remove() keeps the secrets and is safe to repeat.
    await old.remove(record, false)
  } else {
    const leftover = findLeftoverSecrets(deps.paths, env, deps.providers)
    seen.push(...listKnownSecretValues(deps, leftover))
    if (leftover?.provider === provider.name) {
      secrets = leftover
      print(text.leftoverFound)
    }
  }
  const saved = secrets?.provider === provider.name ? secrets.settings : {}
  let settings: SettingValues | undefined
  // The `some` check stops a provider with no required settings from reusing an empty bag.
  if (
    isComplete(provider, saved) &&
    provider.settings.some((setting) => Object.hasOwn(saved, setting.configKey))
  ) {
    const displayName = await findDisplayName(provider, saved)
    if (displayName) {
      settings = saved
      print(text.reusing(displayName))
    }
  }
  const isPrompted = provider.settings.some((setting) => setting.prompt !== undefined)
  while (settings === undefined) {
    if (deps.signal?.aborted) {
      throw new Aborted()
    }
    // Nothing to ask for, so asking again can't change the answer.
    if (!isPrompted) {
      print(text.rejected)
      return 1
    }
    const candidate = await promptSettings(provider, deps)
    seen.push(...listSecretValues(provider, candidate))
    const merged = { ...saved, ...candidate }
    if (isComplete(provider, merged) && (await findDisplayName(provider, merged))) {
      settings = merged
    } else {
      print(text.rejected)
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
    provider,
    settings,
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
    print('Done. Try it: telegram-ask test')
    print('Check state: telegram-ask status')
    print(`Logs: ${target.logsHint(installed)}`)
    return 0
  }
  if (result === 'interrupted') {
    return 130
  }
  print(target.logsHint(installed))
  return 1
}
