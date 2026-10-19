import { CANCELLED_RESULT, EXPIRED_ENDING } from './constants.ts'
import { formatFinalText } from './formatter.ts'
import { PendingRequests } from './pending.ts'
import type { RequestRecord } from '../state/index.ts'
import type {
  ApprovalRequest,
  ApprovalServiceOptions,
  MessageEnding,
  MessageReference,
  Messenger,
  RequestResult,
  RequestStore,
} from './types.ts'

/** The messenger failed to send the request; the original error is in `cause`. */
export class SendError extends Error {}

/** Sends each request to the owner and waits for a tap, the timeout or an abort. */
export class ApprovalService {
  #messenger: Messenger
  #now: () => Date
  #newId: () => string
  #store: RequestStore | undefined
  #pending = new PendingRequests()

  constructor(
    messenger: Messenger,
    now: () => Date = () => new Date(),
    newId: () => string = () => crypto.randomUUID(),
    options: ApprovalServiceOptions = {},
  ) {
    this.#messenger = messenger
    this.#now = now
    this.#newId = newId
    this.#store = options.store
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
    if (this.#messenger.finalize !== undefined) {
      this.#store?.addRequest({ id, reference, text: request.text })
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
    await this.#finalize(reference, request.text, settlement)
    this.#store?.removeRequest(id)
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

  /**
   * Marks requests left over from a previous run as expired and removes their records. Never
   * rejects; without `messenger.finalize` the records are only removed.
   */
  async expireOrphans(records: readonly RequestRecord[]): Promise<void> {
    for (const record of records) {
      await this.#finalize(record.reference, record.text, EXPIRED_ENDING)
      this.#store?.removeRequest(record.id)
    }
  }

  async #finalize(reference: MessageReference, text: string, ending: MessageEnding): Promise<void> {
    if (this.#messenger.finalize === undefined) {
      return
    }
    try {
      await this.#messenger.finalize(reference, formatFinalText(text, ending, this.#now()), ending)
    } catch (error) {
      console.error('failed to finalize approval message', error)
    }
  }
}
