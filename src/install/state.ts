import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { installRecordSchema } from './schema.ts'
import type { InstallRecord } from './types.ts'

export function readInstall(file: string): InstallRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  const result = installRecordSchema.safeParse(parsed)
  return result.success ? result.data : undefined
}

export function writeInstall(file: string, record: InstallRecord): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
}

export function removeInstall(file: string): void {
  rmSync(file, { force: true })
}
