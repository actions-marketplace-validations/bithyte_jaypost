import { readFileSync, rmSync } from 'node:fs'
import { writeFileAtomic } from '../system/index.ts'
import { SECRET_FILE_MODE } from './constants.ts'
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
  writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`, SECRET_FILE_MODE)
}

export function removeInstall(file: string): void {
  rmSync(file, { force: true })
}
