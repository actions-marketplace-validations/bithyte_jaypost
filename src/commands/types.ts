import type { InstallPaths, Target, TargetName } from '../install/index.ts'
import type { StatusInfo } from '../server/index.ts'

/** The prompts the commands use; injectable so tests can fake them. */
export interface Prompts {
  confirm: (message: string, initialValue: boolean) => Promise<boolean>
  password: (message: string) => Promise<string>
  select: <T extends string>(
    message: string,
    options: { value: T; label: string; disabled?: string }[],
    initialValue: T,
  ) => Promise<T>
}

export interface WaitOptions {
  port: number
  isRunning: () => Promise<boolean>
  logsHint: string
  signal?: AbortSignal
  fetchStatus?: (port: number) => Promise<StatusInfo | undefined>
  sleep?: (ms: number) => Promise<void>
  startTimeoutMs?: number
  print?: (s: string) => void
}

export type WaitResult = 'paired' | 'interrupted' | 'not-started' | 'stopped'

export type WaitForPairing = (opts: WaitOptions) => Promise<WaitResult>

export interface InitDeps {
  targets: Record<TargetName, Target>
  paths: InstallPaths
  prompt: Prompts
  validateToken: (token: string) => Promise<string | undefined>
  portFree: (port: number) => Promise<boolean>
  wait: WaitForPairing
  print: (s: string) => void
  signal?: AbortSignal
  version: string
  /** Defaults to process.env; used to find the systemd config file. */
  env?: NodeJS.ProcessEnv
}

export interface InitArgs {
  target?: TargetName
  port?: number
  tarball?: string
}

export interface ResetOwnerDeps {
  targets: Record<TargetName, Target>
  paths: InstallPaths
  confirm: Prompts['confirm']
  wait: WaitForPairing
  print: (s: string) => void
  signal?: AbortSignal
}

export interface StatusDeps {
  targets: Record<TargetName, Target>
  paths: InstallPaths
  fetchStatus: (port: number) => Promise<StatusInfo | undefined>
  print: (s: string) => void
}

export interface UninstallDeps {
  targets: Record<TargetName, Target>
  paths: InstallPaths
  confirm: Prompts['confirm']
  print: (s: string) => void
  signal?: AbortSignal
}
