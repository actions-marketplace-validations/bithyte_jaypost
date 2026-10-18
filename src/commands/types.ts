import type { InstallPaths, Target, TargetName } from '../install/index.ts'
import type { StatusInfo } from '../server/index.ts'

export type SelectOption<T extends string> = {
  readonly value: T
  readonly label: string
  readonly disabled?: string
}

/** The prompts the commands use; injectable so tests can fake them. */
export type Prompts = {
  readonly confirm: (message: string, initialValue: boolean) => Promise<boolean>
  readonly password: (message: string) => Promise<string>
  readonly select: <T extends string>(
    message: string,
    options: readonly SelectOption<T>[],
    initialValue: T,
  ) => Promise<T>
}

export type WaitOptions = {
  readonly port: number
  readonly isRunning: () => Promise<boolean>
  readonly logsHint: string
  readonly signal?: AbortSignal
  readonly fetchStatus?: (port: number) => Promise<StatusInfo | undefined>
  readonly sleep?: (delayMs: number) => Promise<void>
  readonly startTimeoutMs?: number
  readonly print?: (text: string) => void
}

export type WaitResult = 'paired' | 'interrupted' | 'notStarted' | 'stopped'

export type WaitForPairing = (options: WaitOptions) => Promise<WaitResult>

export type InitDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly prompt: Prompts
  readonly validateToken: (token: string) => Promise<string | undefined>
  readonly isPortFree: (port: number) => Promise<boolean>
  readonly wait: WaitForPairing
  readonly print: (text: string) => void
  readonly signal?: AbortSignal
  readonly version: string
  /** Defaults to process.env; used to find the systemd config file. */
  readonly env?: NodeJS.ProcessEnv
}

export type InitArgs = {
  readonly target?: TargetName
  readonly port?: number
  readonly tarball?: string
}

export type ResetOwnerDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly confirm: Prompts['confirm']
  readonly wait: WaitForPairing
  readonly print: (text: string) => void
  readonly signal?: AbortSignal
}

export type StatusDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly fetchStatus: (port: number) => Promise<StatusInfo | undefined>
  readonly print: (text: string) => void
}

export type UninstallDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly confirm: Prompts['confirm']
  readonly print: (text: string) => void
  readonly signal?: AbortSignal
}
