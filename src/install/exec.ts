import { spawn } from 'node:child_process'

export type ExecResult = { code: number; stdout: string; stderr: string }
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { inherit?: boolean; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>

export class MissingCommandError extends Error {
  readonly command: string
  constructor(command: string) {
    super(`Command not found: ${command}`)
    this.name = 'MissingCommandError'
    this.command = command
  }
}

/** Never rejects on a non-zero exit; rejects only when the binary doesn't exist. */
export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: opts.env ?? process.env,
      stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') reject(new MissingCommandError(cmd))
      else reject(e)
    })
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
