import { spawn } from 'node:child_process'
import type { Exec } from './types.ts'

export class MissingCommandError extends Error {
  readonly command: string
  constructor(command: string) {
    super(`command ${JSON.stringify(command)} not found`)
    this.name = 'MissingCommandError'
    this.command = command
  }
}

/** Never rejects on a non-zero exit; rejects only when the binary doesn't exist. */
export const realExec: Exec = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') reject(new MissingCommandError(command))
      else reject(error)
    })
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
