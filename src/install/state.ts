import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

const installRecordSchema = z.object({
  target: z.enum(['systemd', 'compose', 'quadlet']),
  port: z.number(),
  version: z.string(),
  cliPath: z.string().optional(),
  /** Absolute config.json path the systemd unit was installed with. */
  configFile: z.string().optional(),
})

export type InstallRecord = z.infer<typeof installRecordSchema>
export type TargetName = InstallRecord['target']

export function readInstall(file: string): InstallRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  const r = installRecordSchema.safeParse(parsed)
  return r.success ? r.data : undefined
}

export function writeInstall(file: string, rec: InstallRecord): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
}

export function removeInstall(file: string): void {
  rmSync(file, { force: true })
}
