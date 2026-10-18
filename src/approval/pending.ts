import { CANCELLED_SETTLEMENT } from './constants.ts'
import type { ApprovalRequest, PendingEntry, Settlement } from './types.ts'

/**
 * Open requests by id, each settling exactly once (answer, timeout or cancel); settling clears its
 * timer.
 */
export class PendingRequests {
  #entries = new Map<string, PendingEntry>()

  get size(): number {
    return this.#entries.size
  }

  /**
   * Registers `request` and resolves with how it settled. The timeout settles it with the request's
   * timeout option.
   */
  open(id: string, request: ApprovalRequest): Promise<Settlement> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.#settle(id, { kind: 'timedOut', answer: request.timeoutOption }),
        request.timeoutSeconds * 1000,
      )
      this.#entries.set(id, { request, timer, resolve })
    })
  }

  /**
   * Settles with the option at `optionIndex`; false when the id is unknown or already settled, or
   * the index is out of range.
   */
  answer(id: string, optionIndex: number): boolean {
    const entry = this.#entries.get(id)
    const answer = entry?.request.options[optionIndex]
    if (answer === undefined) {
      return false
    }
    return this.#settle(id, { kind: 'answered', answer })
  }

  /** Settles as cancelled; false when the id is unknown or already settled. */
  cancel(id: string): boolean {
    return this.#settle(id, CANCELLED_SETTLEMENT)
  }

  #settle(id: string, settlement: Settlement): boolean {
    const entry = this.#entries.get(id)
    if (!entry) {
      return false
    }
    clearTimeout(entry.timer)
    this.#entries.delete(id)
    entry.resolve(settlement)
    return true
  }
}
