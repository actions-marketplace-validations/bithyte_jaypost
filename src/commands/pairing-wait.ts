import { setTimeout as delay } from 'node:timers/promises'
import { statusInfoSchema } from '../server/index.ts'
import type { StatusInfo } from '../server/index.ts'
import {
  CODE_DASH_PATTERN,
  DEFAULT_START_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  STATUS_TIMEOUT_MS,
} from './constants.ts'
import type { WaitOptions, WaitResult } from './types.ts'

export async function defaultFetchStatus(port: number): Promise<StatusInfo | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    })
    const body = statusInfoSchema.safeParse(await res.json())
    if (body.success) return body.data
  } catch {
    // not up yet
  }
  return undefined
}

function abortableSleep(signal?: AbortSignal): (ms: number) => Promise<void> {
  // Rejects on abort; the loop checks the signal right after.
  return (ms) => delay(ms, undefined, { signal }).catch(() => {})
}

export async function waitForPairing(opts: WaitOptions): Promise<WaitResult> {
  const print = opts.print ?? ((s: string) => console.log(s))
  const fetchStatus = opts.fetchStatus ?? defaultFetchStatus
  const sleep = opts.sleep ?? abortableSleep(opts.signal)
  const startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
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
        const raw = status.code.replace(CODE_DASH_PATTERN, '')
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
    await sleep(POLL_INTERVAL_MS)
  }
}
