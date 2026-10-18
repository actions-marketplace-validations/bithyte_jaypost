import { DEFAULT_PORT } from '../config/index.ts'
import {
  detectTargets,
  findDefaultTarget,
  findExistingInstall,
  findLeftoverSecrets,
  writeInstall,
} from '../install/index.ts'
import type { InstallRecord, Secrets, TargetName } from '../install/index.ts'
import { findProvider, listSecretValues } from '../provider/index.ts'
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
 * declines, 1 on failure, 130 on interrupt; error text is shown with known tokens masked.
 */
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
  const provider = deps.providers[0]
  // Task 7 makes init generic; until then it asks for the one prompted setting (the token).
  const tokenSetting = provider?.settings.find((setting) => setting.prompt !== undefined)
  if (provider === undefined || tokenSetting?.prompt === undefined) {
    throw new Error('no provider with a prompted setting is registered')
  }
  const { text } = provider.setup
  let secrets: Secrets | undefined
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
    // Mask before anything below can fail with a reused credential in its message.
    seen.push(...listKnownSecretValues(deps, secrets))
    // Record a legacy install too, so a failed run below can still find its config on retry.
    if (existing.legacy) {
      writeInstall(deps.paths.installFile, record)
    }
    // Remove first: the old service may hold the port we're about to check. install.json stays
    // until the new install replaces it; remove() keeps the secrets and is safe to repeat.
    await old.remove(record, false)
  } else {
    secrets = findLeftoverSecrets(deps.paths, env, deps.providers)
    seen.push(...listKnownSecretValues(deps, secrets))
    if (secrets?.provider === provider.name) {
      print(text.leftoverFound)
    }
  }
  const saved = secrets?.provider === provider.name ? secrets.settings : {}
  let token: string | undefined
  const savedToken = saved[tokenSetting.configKey]
  if (savedToken !== undefined) {
    const displayName = await findDisplayName(provider, saved)
    if (displayName) {
      token = String(savedToken)
      print(text.reusing(displayName))
    }
  }
  while (token === undefined) {
    if (deps.signal?.aborted) {
      throw new Aborted()
    }
    const candidate = await prompt.password(tokenSetting.prompt)
    seen.push(candidate)
    if (
      candidate !== '' &&
      (await findDisplayName(provider, { ...saved, [tokenSetting.configKey]: candidate }))
    ) {
      token = candidate
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
    settings: { ...saved, [tokenSetting.configKey]: token },
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
