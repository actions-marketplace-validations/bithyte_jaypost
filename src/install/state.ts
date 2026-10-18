import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type TargetName = 'systemd' | 'compose' | 'quadlet'

export interface InstallRecord {
  target: TargetName
  port: number
  version: string
  cliPath?: string
}

const TARGETS: readonly string[] = ['systemd', 'compose', 'quadlet']

export function readInstall(file: string): InstallRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const r = parsed as Record<string, unknown>
  if (typeof r.target !== 'string' || !TARGETS.includes(r.target)) return undefined
  if (typeof r.port !== 'number' || typeof r.version !== 'string') return undefined
  if (r.cliPath !== undefined && typeof r.cliPath !== 'string') return undefined
  return {
    target: r.target as TargetName,
    port: r.port,
    version: r.version,
    ...(r.cliPath === undefined ? {} : { cliPath: r.cliPath }),
  }
}

export function writeInstall(file: string, rec: InstallRecord): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
}

export function removeInstall(file: string): void {
  rmSync(file, { force: true })
}
