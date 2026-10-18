import { CANCELLED_SETTLEMENT } from './constants.ts'
import type { ApprovalRequest, PendingEntry, Settlement } from './types.ts'

export class PendingRequests {
  #entries = new Map<string, PendingEntry>()

  get size(): number {
    return this.#entries.size
  }

  open(id: string, request: ApprovalRequest): Promise<Settlement> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.#settle(id, { kind: 'timedOut', answer: request.timeoutOption }),
        request.timeoutSeconds * 1000,
      )
      this.#entries.set(id, { request, timer, resolve })
    })
  }

  answer(id: string, optionIndex: number): boolean {
    const entry = this.#entries.get(id)
    const answer = entry?.request.options[optionIndex]
    if (answer === undefined) return false
    return this.#settle(id, { kind: 'answered', answer })
  }

  cancel(id: string): boolean {
    return this.#settle(id, CANCELLED_SETTLEMENT)
  }

  #settle(id: string, settlement: Settlement): boolean {
    const entry = this.#entries.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.#entries.delete(id)
    entry.resolve(settlement)
    return true
  }
}
