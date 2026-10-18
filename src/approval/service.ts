import { CANCELLED_RESULT } from './constants.ts'
import { formatFinalText } from './formatter.ts'
import { PendingRequests } from './pending.ts'
import type { ApprovalRequest, Messenger, RequestResult } from './types.ts'

/** The messenger failed to send the request; the original error is in `cause`. */
export class SendError extends Error {}

/** Sends each request to the owner and waits for a tap, the timeout or an abort. */
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

  /**
   * Resolves once settled. Throws `SendError` if the message can't be sent; a failed final edit is
   * only logged. An aborted `signal` settles as cancelled.
   */
  async request(request: ApprovalRequest, signal?: AbortSignal): Promise<RequestResult> {
    const id = this.#newId()
    let reference
    try {
      reference = await this.#messenger.sendRequest(id, request.text, request.options)
    } catch (cause) {
      throw new SendError('failed to send approval request', { cause })
    }
    const settled = this.#pending.open(id, request)
    const onAbort = () => {
      this.#pending.cancel(id)
    }
    // Checked after open() so an abort during sendRequest is not missed.
    if (signal?.aborted) {
      onAbort()
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }
    const settlement = await settled
    signal?.removeEventListener('abort', onAbort)
    try {
      await this.#messenger.finalize(
        reference,
        formatFinalText(request.text, settlement, this.#now()),
      )
    } catch (error) {
      console.error('failed to finalize approval message', error)
    }
    if (settlement.kind === 'cancelled') {
      return CANCELLED_RESULT
    }
    return {
      kind: 'completed',
      outcome: { answer: settlement.answer, timedOut: settlement.kind === 'timedOut' },
    }
  }

  /**
   * Records a button tap; 'expired' when the request is unknown, already settled or the index is
   * invalid.
   */
  tap(id: string, optionIndex: number): 'accepted' | 'expired' {
    return this.#pending.answer(id, optionIndex) ? 'accepted' : 'expired'
  }
}
