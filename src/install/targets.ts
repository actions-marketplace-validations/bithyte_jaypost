import { existsSync } from 'node:fs'
import { readConfigFile } from '../config.ts'
import { composeTarget } from './compose.ts'
import type { InstallPaths } from './paths.ts'
import { quadletTarget } from './quadlet.ts'
import { readInstall } from './state.ts'
import type { InstallRecord, TargetName } from './state.ts'
import { systemdTarget } from './systemd.ts'
import type { Target, TargetDeps } from './target.ts'

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
  if (!existsSync(paths.systemdUnit)) return undefined
  const configFile = env.APPROVAL_BOT_CONFIG || paths.configFile
  let port = DEFAULT_PORT
  try {
    const p = readConfigFile(configFile).port
    if (typeof p === 'number') port = p
  } catch {
    // Unreadable config: fall back to the default port.
  }
  return { rec: { target: 'systemd', port, version: 'legacy' }, legacy: true }
}
