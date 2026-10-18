import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readConfigFile } from '../config.ts'
import { composeTarget } from './compose.ts'
import { readEnvFile } from './envfile.ts'
import type { InstallPaths } from './paths.ts'
import { quadletTarget } from './quadlet.ts'
import { readInstall } from './state.ts'
import type { InstallRecord, TargetName } from './state.ts'
import { defaultConfigFile, systemdTarget, unitConfigFile } from './systemd.ts'
import type { Secrets, Target, TargetDeps } from './target.ts'

export const TARGET_ORDER: TargetName[] = ['quadlet', 'compose', 'systemd']

const DEFAULT_PORT = 8787

export function makeTargets(
  deps: TargetDeps,
  cli: { selfPath: string; nodePath: string },
): Record<TargetName, Target> {
  return {
    quadlet: quadletTarget(deps),
    compose: composeTarget(deps),
    systemd: systemdTarget(deps, cli),
  }
}

export async function detect(
  targets: Record<TargetName, Target>,
): Promise<{ name: TargetName; ok: boolean; reason?: string }[]> {
  const out: { name: TargetName; ok: boolean; reason?: string }[] = []
  for (const name of TARGET_ORDER) {
    const r = await targets[name].available()
    out.push(r.ok ? { name, ok: true } : { name, ok: false, reason: r.reason })
  }
  return out
}

export function defaultTarget(
  detected: { name: TargetName; ok: boolean }[],
): TargetName | undefined {
  return detected.find((d) => d.ok)?.name
}

export function findExisting(
  paths: InstallPaths,
  _targets: Record<TargetName, Target>,
  env: NodeJS.ProcessEnv = process.env,
): { rec: InstallRecord; legacy: boolean } | undefined {
  const rec = readInstall(paths.installFile)
  if (rec) return { rec, legacy: false }
  let unit: string
  try {
    unit = readFileSync(paths.systemdUnit, 'utf8')
  } catch {
    return undefined
  }
  // The legacy unit may pin its own config path; prefer it over this shell's env.
  const configFile = unitConfigFile(unit) ?? defaultConfigFile(paths, env)
  let port = DEFAULT_PORT
  try {
    port = readConfigFile(configFile).port ?? DEFAULT_PORT
  } catch {
    // Unreadable config: fall back to the default port.
  }
  return { rec: { target: 'systemd', port, version: 'legacy', configFile }, legacy: true }
}

function envSecrets(path: string): Secrets {
  const e = readEnvFile(path)
  const out: Secrets = {}
  if (e.BOT_TOKEN) out.token = e.BOT_TOKEN
  if (e.OWNER_ID && /^-?\d+$/.test(e.OWNER_ID)) out.ownerId = Number(e.OWNER_ID)
  return out
}

function configSecrets(path: string): Secrets {
  try {
    const c = readConfigFile(path)
    const out: Secrets = {}
    if (c.botToken) out.token = c.botToken
    if (c.ownerId !== undefined && Number.isSafeInteger(c.ownerId)) out.ownerId = c.ownerId
    return out
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
    () => envSecrets(join(paths.quadletDir, '.env')),
    () => envSecrets(join(paths.composeDir, '.env')),
    () => configSecrets(defaultConfigFile(paths, env)),
  ]
  for (const read of sources) {
    const s = read()
    if (s.token !== undefined) return s
  }
  return {}
}
