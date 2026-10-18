import { randomInt } from 'node:crypto'

export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export type PairResult = 'paired' | 'wrong' | 'blocked' | 'not-pairing'

export function generateCode(random: (max: number) => number = randomInt): string {
  let code = ''
  for (let i = 0; i < 8; i++) code += PAIRING_ALPHABET[random(PAIRING_ALPHABET.length)]
  return code
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

function normalize(text: string): string {
  return text
    .trim()
    .replace(/^\/start(@\w+)?/i, '')
    .toUpperCase()
    .replace(/[-\s]/g, '')
}

export class Pairing {
  #code: string | undefined
  #maxFailures: number
  #failures = new Map<number, number>()

  constructor(code: string, maxFailures = 5) {
    this.#code = code.toUpperCase()
    this.#maxFailures = maxFailures
  }

  get code(): string | undefined {
    return this.#code
  }

  get paired(): boolean {
    return this.#code === undefined
  }

  attempt(fromId: number, text: string): PairResult {
    if (this.#code === undefined) return 'not-pairing'
    const failures = this.#failures.get(fromId) ?? 0
    if (failures >= this.#maxFailures) return 'blocked'
    if (normalize(text) === this.#code) {
      this.#code = undefined
      return 'paired'
    }
    this.#failures.set(fromId, failures + 1)
    return 'wrong'
  }
}
