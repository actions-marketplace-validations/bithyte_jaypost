import { Api } from 'grammy'
import net from 'node:net'
import type { Exec } from './exec.ts'

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

export async function ensureLinger(
  exec: Exec,
  user: string,
  print: (s: string) => void,
): Promise<void> {
  const fallback = () =>
    print(`Run "loginctl enable-linger ${user}" so it keeps running after logout.`)
  try {
    const show = await exec('loginctl', ['show-user', user, '-p', 'Linger'])
    if (show.code === 0 && /Linger=yes/.test(show.stdout)) return
    if (show.code === 0 && !/Linger=no/.test(show.stdout)) return
    const r = await exec('loginctl', ['enable-linger', user])
    if (r.code !== 0) fallback()
  } catch {
    fallback()
  }
}

/** Returns the bot username, or undefined on any failure. Never exposes the token or error text. */
export async function validateToken(token: string): Promise<string | undefined> {
  try {
    // Global fetch rather than grammY's bundled node-fetch.
    const me = await new Api(token, { fetch, timeoutSeconds: 10 }).getMe()
    return me.username || undefined
  } catch {
    return undefined
  }
}
