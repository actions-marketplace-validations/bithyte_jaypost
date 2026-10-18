import { Api } from 'grammy'
import net from 'node:net'
import { LINGER_OFF_PATTERN, LINGER_ON_PATTERN, TOKEN_CHECK_TIMEOUT_SECONDS } from './constants.ts'
import type { Exec } from './types.ts'

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

export async function ensureLinger(
  exec: Exec,
  user: string,
  print: (text: string) => void,
): Promise<void> {
  const printFallback = () =>
    print(`Run "loginctl enable-linger ${user}" so it keeps running after logout.`)
  try {
    const show = await exec('loginctl', ['show-user', user, '-p', 'Linger'])
    if (show.code === 0 && LINGER_ON_PATTERN.test(show.stdout)) {
      return
    }
    if (show.code === 0 && !LINGER_OFF_PATTERN.test(show.stdout)) {
      return
    }
    const result = await exec('loginctl', ['enable-linger', user])
    if (result.code !== 0) {
      printFallback()
    }
  } catch {
    printFallback()
  }
}

/** Returns the bot username, or undefined on any failure. Never exposes the token or error text. */
export async function validateToken(token: string): Promise<string | undefined> {
  try {
    // Global fetch rather than grammY's bundled node-fetch.
    const botUser = await new Api(token, {
      fetch,
      timeoutSeconds: TOKEN_CHECK_TIMEOUT_SECONDS,
    }).getMe()
    return botUser.username || undefined
  } catch {
    return undefined
  }
}
