import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PORT, readConfigFile } from '../config/index.ts'
import { createComposeTarget } from './compose.ts'
import { INTEGER_PATTERN, TARGET_ORDER } from './constants.ts'
import { readEnvFile } from './envfile.ts'
import { createQuadletTarget } from './quadlet.ts'
import { readInstall } from './state.ts'
import { createSystemdTarget, findUnitConfigFile, resolveDefaultConfigFile } from './systemd.ts'
import type {
  CliLocation,
  DetectedTarget,
  ExistingInstall,
  InstallPaths,
  Secrets,
  Target,
  TargetDeps,
  TargetName,
} from './types.ts'

/** Builds all three install targets from the same dependencies. */
export function createTargets(
  deps: TargetDeps,
  cli: CliLocation,
): Readonly<Record<TargetName, Target>> {
  return {
    quadlet: createQuadletTarget(deps),
    compose: createComposeTarget(deps),
    systemd: createSystemdTarget(deps, cli),
  }
}

/** Asks each target if it is usable, in `TARGET_ORDER`. */
export async function detectTargets(
  targets: Readonly<Record<TargetName, Target>>,
): Promise<readonly DetectedTarget[]> {
  const detected: DetectedTarget[] = []
  for (const name of TARGET_ORDER) {
    detected.push({ name, ...(await targets[name].available()) })
  }
  return detected
}

/** First available target in the given order, or undefined when none is usable. */
export function findDefaultTarget(detected: readonly DetectedTarget[]): TargetName | undefined {
  return detected.find((candidate) => candidate.ok)?.name
}

/**
 * Install recorded in install.json, else a legacy systemd install rebuilt from its unit file
 * (`legacy: true`); undefined when neither exists.
 */
export function findExistingInstall(
  paths: InstallPaths,
  _targets: Readonly<Record<TargetName, Target>>,
  env: NodeJS.ProcessEnv = process.env,
): ExistingInstall | undefined {
  const record = readInstall(paths.installFile)
  if (record) {
    return { record, legacy: false }
  }
  let unit: string
  try {
    unit = readFileSync(paths.systemdUnit, 'utf8')
  } catch {
    return undefined
  }
  // The legacy unit may pin its own config path; prefer it over this shell's env.
  const configFile = findUnitConfigFile(unit) ?? resolveDefaultConfigFile(paths, env)
  let port = DEFAULT_PORT
  try {
    port = readConfigFile(configFile).port ?? DEFAULT_PORT
  } catch {
    // Unreadable config: fall back to the default port.
  }
  return { record: { target: 'systemd', port, version: 'legacy', configFile }, legacy: true }
}

function readEnvSecrets(path: string): Secrets {
  const values = readEnvFile(path)
  return {
    ...(values.BOT_TOKEN ? { token: values.BOT_TOKEN } : {}),
    ...(values.OWNER_ID && INTEGER_PATTERN.test(values.OWNER_ID)
      ? { ownerId: Number(values.OWNER_ID) }
      : {}),
  }
}

function readConfigSecrets(path: string): Secrets {
  try {
    const config = readConfigFile(path)
    return {
      ...(config.botToken ? { token: config.botToken } : {}),
      ...(config.ownerId !== undefined && Number.isSafeInteger(config.ownerId)
        ? { ownerId: config.ownerId }
        : {}),
    }
  } catch {
    // Corrupt config: treat as nothing left over.
    return {}
  }
}

/**
 * Token and owner left behind by an uninstall that kept them (no install.json any more).
 * Only reads files; never runs a container. First source with a token wins.
 */
export function findLeftoverSecrets(
  paths: InstallPaths,
  env: NodeJS.ProcessEnv = process.env,
): Secrets {
  const sources = [
    () => readEnvSecrets(join(paths.quadletDirectory, '.env')),
    () => readEnvSecrets(join(paths.composeDirectory, '.env')),
    () => readConfigSecrets(resolveDefaultConfigFile(paths, env)),
  ]
  for (const read of sources) {
    const secrets = read()
    if (secrets.token !== undefined) {
      return secrets
    }
  }
  return {}
}
