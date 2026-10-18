export type ExecResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type ExecOptions = {
  readonly inherit?: boolean
  readonly env?: NodeJS.ProcessEnv
}

export type Exec = (
  command: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>
