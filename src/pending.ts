import type { ApprovalRequest, Settlement } from './types.ts'

interface Entry {
  req: ApprovalRequest
  timer: ReturnType<typeof setTimeout>
  resolve: (settlement: Settlement) => void
}

export class PendingRequests {
  #entries = new Map<string, Entry>()

  get size(): number {
    return this.#entries.size
  }

  open(id: string, req: ApprovalRequest): Promise<Settlement> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.#settle(id, { kind: 'timedOut', answer: req.timeoutOption }),
        req.timeoutSeconds * 1000,
      )
      this.#entries.set(id, { req, timer, resolve })
    })
  }

  answer(id: string, optionIndex: number): boolean {
    const entry = this.#entries.get(id)
    const answer = entry?.req.options[optionIndex]
    if (answer === undefined) return false
    return this.#settle(id, { kind: 'answered', answer })
  }

  cancel(id: string): boolean {
    return this.#settle(id, { kind: 'cancelled' })
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
