import type { InstallPaths, Target, TargetName } from '../install/index.ts'
import type { Provider } from '../provider/index.ts'
import type { StatusInfo } from '../server/index.ts'

/** One entry in a select prompt; a `disabled` reason shows it as unavailable. */
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

/** Inputs to `waitForPairing`; the optional fields are test seams with real defaults. */
export type WaitOptions = {
  readonly port: number
  readonly isRunning: () => Promise<boolean>
  /** Appended to the message when the service stops while waiting. */
  readonly logsHint: string
  readonly signal?: AbortSignal
  /** Injectable for tests; defaults to `defaultFetchStatus`. */
  readonly fetchStatus?: (port: number) => Promise<StatusInfo | undefined>
  readonly sleep?: (delayMs: number) => Promise<void>
  /** Limit on waiting for the first /status answer; defaults to `DEFAULT_START_TIMEOUT_MS`. */
  readonly startTimeoutMs?: number
  readonly print?: (text: string) => void
}

/**
 * Why `waitForPairing` returned: paired, Ctrl-C, no answer within the start timeout, or the service
 * stopped.
 */
export type WaitResult = 'paired' | 'interrupted' | 'notStarted' | 'stopped'

/** Signature of `waitForPairing`, injectable for tests. */
export type WaitForPairing = (options: WaitOptions) => Promise<WaitResult>

/** Everything `runInit` touches outside itself, injected for tests. */
export type InitDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly prompt: Prompts
  /** Registered providers; init uses the first one for now. */
  readonly providers: readonly Provider[]
  readonly isPortFree: (port: number) => Promise<boolean>
  readonly wait: WaitForPairing
  readonly print: (text: string) => void
  readonly signal?: AbortSignal
  readonly version: string
  /** Defaults to process.env; used to find the systemd config file. */
  readonly env?: NodeJS.ProcessEnv
}

/** Parsed `init` flags; absent fields mean the user didn't pass them. */
export type InitArgs = {
  readonly target?: TargetName
  readonly port?: number
  readonly tarball?: string
}

/** Everything `runResetOwner` touches outside itself, injected for tests. */
export type ResetOwnerDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly providers: readonly Provider[]
  readonly confirm: Prompts['confirm']
  readonly wait: WaitForPairing
  readonly print: (text: string) => void
  readonly signal?: AbortSignal
}

/** Everything `runStatus` touches outside itself, injected for tests. */
export type StatusDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly fetchStatus: (port: number) => Promise<StatusInfo | undefined>
  readonly print: (text: string) => void
}

/** Everything `runUninstall` touches outside itself, injected for tests. */
export type UninstallDeps = {
  readonly targets: Readonly<Record<TargetName, Target>>
  readonly paths: InstallPaths
  readonly confirm: Prompts['confirm']
  readonly print: (text: string) => void
  readonly signal?: AbortSignal
}
