import type { StatusInfo } from '../http.ts'

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

export async function defaultFetchStatus(port: number): Promise<StatusInfo | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(2000),
    })
    const body = (await res.json()) as StatusInfo
    if (body && typeof body === 'object' && typeof body.paired === 'boolean') return body
  } catch {
    // not up yet
  }
  return undefined
}

function abortableSleep(signal?: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const done = () => {
        clearTimeout(t)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const t = setTimeout(done, ms)
      signal?.addEventListener('abort', done, { once: true })
    })
}

export async function waitForPairing(
  opts: WaitOptions,
): Promise<'paired' | 'interrupted' | 'not-started' | 'stopped'> {
  const print = opts.print ?? ((s: string) => console.log(s))
  const fetchStatus = opts.fetchStatus ?? defaultFetchStatus
  const sleep = opts.sleep ?? abortableSleep(opts.signal)
  const startTimeoutMs = opts.startTimeoutMs ?? 60000
  const began = Date.now()
  let answered = false
  let shown = false

  for (;;) {
    if (opts.signal?.aborted) {
      print(
        'Service is still running and waiting for pairing. Run "telegram-approval-bot status" to see the code again.',
      )
      return 'interrupted'
    }
    const status = await fetchStatus(opts.port)
    if (status) {
      answered = true
      if (status.paired) return 'paired'
      if (!shown) {
        shown = true
        const raw = status.code.replace(/-/g, '')
        print(
          `Pairing code: ${status.code}\nSend "/start ${status.code}" to @${status.bot}, or open https://t.me/${status.bot}?start=${raw}`,
        )
      }
    } else if (!answered && Date.now() - began >= startTimeoutMs) {
      return 'not-started'
    }
    if (!(await opts.isRunning())) {
      print(`The service stopped. ${opts.logsHint}`)
      return 'stopped'
    }
    await sleep(1000)
  }
}
