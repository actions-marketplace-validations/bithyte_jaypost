import type { z } from 'zod'
import type { Exec } from '../system/index.ts'
import type { installRecordSchema } from './schema.ts'

export type InstallRecord = z.infer<typeof installRecordSchema>
export type TargetName = InstallRecord['target']

export interface InstallPaths {
  configDir: string
  configFile: string
  installFile: string
  composeDir: string
  quadletDir: string
  systemdUnit: string
  quadletUnit: string
  userNpmPrefix: string
}

export interface Secrets {
  token?: string
  ownerId?: number
}

export interface InstallOptions {
  version: string
  port: number
  token: string
  ownerId?: number
  tarball?: string
  print: (s: string) => void
}

export interface Target {
  name: TargetName
  available(): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Writes files, builds if needed, starts. */
  install(opts: InstallOptions): Promise<InstallRecord>
  readSecrets(rec: InstallRecord): Promise<Secrets>
  /** Stop and delete files; purge also deletes token/owner storage. */
  remove(rec: InstallRecord, purge: boolean): Promise<void>
  restart(rec: InstallRecord): Promise<void>
  clearOwner(rec: InstallRecord): Promise<void>
  isRunning(rec: InstallRecord): Promise<boolean>
  logsHint(rec: InstallRecord): string
}

export interface TargetDeps {
  exec: Exec
  paths: InstallPaths
  env: NodeJS.ProcessEnv
  user: string
}

export interface CliLocation {
  selfPath: string
  nodePath: string
}

export interface DetectedTarget {
  name: TargetName
  ok: boolean
  reason?: string
}

export interface ExistingInstall {
  rec: InstallRecord
  legacy: boolean
}
