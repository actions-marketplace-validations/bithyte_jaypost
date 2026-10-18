export type ExecResult = { code: number; stdout: string; stderr: string }
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { inherit?: boolean; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>
