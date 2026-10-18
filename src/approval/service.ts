import { finalText } from './formatter.ts'
import { PendingRequests } from './pending.ts'
import type { ApprovalRequest, Messenger, Outcome } from './types.ts'

export class SendError extends Error {}

export class ApprovalService {
  #messenger: Messenger
  #now: () => Date
  #newId: () => string
  #pending = new PendingRequests()

  constructor(
    messenger: Messenger,
    now: () => Date = () => new Date(),
    newId: () => string = () => crypto.randomUUID(),
  ) {
    this.#messenger = messenger
    this.#now = now
    this.#newId = newId
  }

  async request(req: ApprovalRequest, signal?: AbortSignal): Promise<Outcome | null> {
    const id = this.#newId()
    let ref
    try {
      ref = await this.#messenger.sendRequest(id, req.text, req.options)
    } catch (cause) {
      throw new SendError('failed to send approval request', { cause })
    }

    const settled = this.#pending.open(id, req)
    const onAbort = () => {
      this.#pending.cancel(id)
    }
    // Checked after open() so an abort during sendRequest is not missed.
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    const settlement = await settled
    signal?.removeEventListener('abort', onAbort)

    try {
      await this.#messenger.finalize(ref, finalText(req.text, settlement, this.#now()))
    } catch (err) {
      console.error('failed to finalize approval message', err)
    }

    if (settlement.kind === 'cancelled') return null
    return { answer: settlement.answer, timedOut: settlement.kind === 'timedOut' }
  }

  tap(id: string, optionIndex: number): 'accepted' | 'expired' {
    return this.#pending.answer(id, optionIndex) ? 'accepted' : 'expired'
  }
}
