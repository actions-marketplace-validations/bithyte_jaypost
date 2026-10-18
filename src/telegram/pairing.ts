import { randomInt } from 'node:crypto'
import {
  CODE_SEPARATOR_PATTERN,
  DEFAULT_MAX_FAILURES,
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  START_COMMAND_PATTERN,
} from './constants.ts'
import type { PairResult } from './types.ts'

export function generateCode(random: (max: number) => number = randomInt): string {
  let code = ''
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++)
    code += PAIRING_ALPHABET[random(PAIRING_ALPHABET.length)]
  return code
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

function normalize(text: string): string {
  return text
    .trim()
    .replace(START_COMMAND_PATTERN, '')
    .toUpperCase()
    .replace(CODE_SEPARATOR_PATTERN, '')
}

export class Pairing {
  #code: string | undefined
  #maxFailures: number
  #failures = new Map<number, number>()

  constructor(code: string, maxFailures = DEFAULT_MAX_FAILURES) {
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
