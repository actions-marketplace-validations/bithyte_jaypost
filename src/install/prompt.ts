import { createInterface } from 'node:readline/promises'
import type { Interface } from 'node:readline/promises'
import { Writable } from 'node:stream'

export class PromptAborted extends Error {
  constructor() {
    super('prompt aborted')
    this.name = 'PromptAborted'
  }
}

let muted = false
let rl: Interface | undefined

function getRl(): Interface {
  if (rl) return rl
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk)
      cb()
    },
  })
  rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY })
  rl.on('close', () => (rl = undefined))
  return rl
}

/** Rejects with PromptAborted on signal abort, Ctrl-C, or input closing (EOF) before an answer. */
async function question(q: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new PromptAborted()
  const r = getRl()
  const ac = new AbortController()
  let onClose: () => void = () => {}
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onClose = () => reject(new PromptAborted())
    onAbort = () => reject(new PromptAborted())
    r.once('close', onClose)
    r.once('SIGINT', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return (await Promise.race([r.question(q, { signal: ac.signal }), aborted])).trim()
  } finally {
    ac.abort()
    r.off('close', onClose)
    r.off('SIGINT', onAbort)
    signal?.removeEventListener('abort', onAbort)
    aborted.catch(() => {})
  }
}

export async function ask(q: string, signal?: AbortSignal): Promise<string> {
  return question(q, signal)
}

export async function askSecret(q: string, signal?: AbortSignal): Promise<string> {
  process.stdout.write(q)
  muted = true
  try {
    return await question('', signal)
  } finally {
    muted = false
    process.stdout.write('\n')
  }
}

export async function choose<T extends string>(
  q: string,
  options: { value: T; label: string; disabled?: string }[],
  def: T,
  signal?: AbortSignal,
): Promise<T> {
  console.log(q)
  options.forEach((o, i) => {
    console.log(`  ${i + 1}) ${o.label}${o.disabled ? ` (unavailable: ${o.disabled})` : ''}`)
  })
  const defIdx = options.findIndex((o) => o.value === def) + 1
  for (;;) {
    const a = await ask(`Choice [${defIdx}]: `, signal)
    const n = a === '' ? defIdx : Number(a)
    const picked = Number.isInteger(n) ? options[n - 1] : undefined
    if (!picked) console.log('Pick one of the numbers above.')
    else if (picked.disabled) console.log(`Unavailable: ${picked.disabled}`)
    else return picked.value
  }
}

export function closePrompts(): void {
  rl?.close()
  rl = undefined
}
