import type { z } from 'zod'
import type { Exec } from '../system/index.ts'
import type { installRecordSchema } from './schema.ts'

/** What install.json stores: which target is installed, its port and version. */
export type InstallRecord = Readonly<z.infer<typeof installRecordSchema>>
/** Install target id, one of systemd, compose or quadlet. */
export type TargetName = InstallRecord['target']

/** Absolute locations for each target's files. */
export type InstallPaths = {
  readonly configDirectory: string
  readonly configFile: string
  readonly installFile: string
  readonly composeDirectory: string
  readonly quadletDirectory: string
  readonly systemdUnit: string
  readonly quadletUnit: string
  /** Fallback npm prefix for installing the CLI when the global one isn't writable. */
  readonly userNpmPrefix: string
}

/** Token and owner found in an existing install; a field is absent when not found. */
export type Secrets = {
  readonly token?: string
  readonly ownerId?: number
}

/**
 * What a target needs to install; `tarball` installs an unpublished build, and `print` reports
 * progress.
 */
export type InstallOptions = {
  readonly version: string
  readonly port: number
  readonly token: string
  readonly ownerId?: number
  readonly tarball?: string
  readonly print: (text: string) => void
}

/** Whether a target can be used here; `reason` says why not. */
export type Availability = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** Lifecycle operations for one install method; failures throw. */
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

/** External dependencies of the targets, injected for tests. */
export type TargetDeps = {
  readonly exec: Exec
  readonly paths: InstallPaths
  readonly env: NodeJS.ProcessEnv
  readonly user: string
}

/** Paths of the running CLI script and the node binary, for the systemd unit to exec. */
export type CliLocation = {
  readonly selfPath: string
  readonly nodePath: string
}

/** A target name with its availability. */
export type DetectedTarget = { readonly name: TargetName } & Availability

/**
 * An install found on disk; `legacy` means it was rebuilt from an old systemd unit, with no
 * install.json.
 */
export type ExistingInstall = {
  readonly record: InstallRecord
  readonly legacy: boolean
}
