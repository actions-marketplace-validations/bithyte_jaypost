import { createInterface } from 'node:readline/promises'
import type { Interface } from 'node:readline/promises'
import { Writable } from 'node:stream'

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

export async function ask(q: string): Promise<string> {
  return (await getRl().question(q)).trim()
}

export async function askSecret(q: string): Promise<string> {
  process.stdout.write(q)
  muted = true
  try {
    return (await getRl().question('')).trim()
  } finally {
    muted = false
    process.stdout.write('\n')
  }
}

export async function choose<T extends string>(
  q: string,
  options: { value: T; label: string; disabled?: string }[],
  def: T,
): Promise<T> {
  console.log(q)
  options.forEach((o, i) => {
    console.log(`  ${i + 1}) ${o.label}${o.disabled ? ` (unavailable: ${o.disabled})` : ''}`)
  })
  const defIdx = options.findIndex((o) => o.value === def) + 1
  for (;;) {
    const a = await ask(`Choice [${defIdx}]: `)
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
