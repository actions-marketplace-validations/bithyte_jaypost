/** Outcome of a finished command; `code` is 1 if it was killed by a signal. */
export type ExecResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * `inherit` passes stdio through (stdout and stderr then come back empty); `env` defaults to the
 * current environment.
 */
export type ExecOptions = {
  readonly inherit?: boolean
  readonly env?: NodeJS.ProcessEnv
}

/** Runs a command with no shell; injectable so tests don't spawn processes. */
export type Exec = (
  command: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>
