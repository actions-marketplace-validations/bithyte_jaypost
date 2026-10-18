import type { z } from 'zod'
import type { Exec } from '../system/index.ts'
import type { installRecordSchema } from './schema.ts'

export type InstallRecord = Readonly<z.infer<typeof installRecordSchema>>
export type TargetName = InstallRecord['target']

export type InstallPaths = {
  readonly configDirectory: string
  readonly configFile: string
  readonly installFile: string
  readonly composeDirectory: string
  readonly quadletDirectory: string
  readonly systemdUnit: string
  readonly quadletUnit: string
  readonly userNpmPrefix: string
}

export type Secrets = {
  readonly token?: string
  readonly ownerId?: number
}

export type InstallOptions = {
  readonly version: string
  readonly port: number
  readonly token: string
  readonly ownerId?: number
  readonly tarball?: string
  readonly print: (text: string) => void
}

export type Availability = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export type Target = {
  readonly name: TargetName
  readonly available: () => Promise<Availability>
  /** Writes files, builds if needed, starts. */
  readonly install: (options: InstallOptions) => Promise<InstallRecord>
  readonly readSecrets: (record: InstallRecord) => Promise<Secrets>
  /** Stop and delete files; purge also deletes token/owner storage. */
  readonly remove: (record: InstallRecord, purge: boolean) => Promise<void>
  readonly restart: (record: InstallRecord) => Promise<void>
  readonly clearOwner: (record: InstallRecord) => Promise<void>
  readonly isRunning: (record: InstallRecord) => Promise<boolean>
  readonly logsHint: (record: InstallRecord) => string
}

export type TargetDeps = {
  readonly exec: Exec
  readonly paths: InstallPaths
  readonly env: NodeJS.ProcessEnv
  readonly user: string
}

export type CliLocation = {
  readonly selfPath: string
  readonly nodePath: string
}

export type DetectedTarget = { readonly name: TargetName } & Availability

export type ExistingInstall = {
  readonly record: InstallRecord
  readonly legacy: boolean
}
