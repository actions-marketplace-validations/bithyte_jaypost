import { CANCELLED_RESULT, EXPIRED_ENDING, HISTORY_LIMIT } from './constants.ts'
import { formatFinalText } from './formatter.ts'
import { PendingRequests } from './pending.ts'
import type { RequestRecord } from '../state/index.ts'
import type {
  ApprovalRequest,
  ApprovalServiceOptions,
  HistoryEntry,
  MessageEnding,
  MessageReference,
  Messenger,
  PendingSummary,
  RequestResult,
  RequestStore,
} from './types.ts'

/** The messenger failed to send the request; the original error is in `cause`. */
export class SendError extends Error {}

/**
 * Sends each request to the owner and waits for a tap, the timeout or an abort. Also keeps the last
 * `HISTORY_LIMIT` settled requests in memory.
 */
export class ApprovalService {
  #messenger: Messenger
  #now: () => Date
  #newId: () => string
  #store: RequestStore | undefined
  #pending = new PendingRequests()
  #history: HistoryEntry[] = []

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
    const settled = this.#pending.open(id, request, this.#now())
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
    const settledAt = this.#now()
    this.#history.push({ text: request.text, settlement, settledAt })
    if (this.#history.length > HISTORY_LIMIT) {
      this.#history.shift()
    }
    await this.#finalize(reference, request.text, settlement, settledAt)
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

  /** Open requests, oldest first. */
  listPending(): readonly PendingSummary[] {
    return this.#pending.list()
  }

  /**
   * Settles every open request as rejected with its timeout option; callers get `timedOut: false`.
   * Returns what it rejected, oldest first.
   */
  rejectAll(): readonly PendingSummary[] {
    return this.#pending.rejectAll()
  }

  /** The last `count` settled requests, newest first; empty for `count <= 0`. Never throws. */
  history(count: number): readonly HistoryEntry[] {
    if (!(count > 0)) {
      return []
    }
    return this.#history.slice(-count).toReversed()
  }

  /**
   * Marks requests left over from a previous run as expired and removes their records. Never
   * rejects; without `messenger.finalize` the records are only removed.
   */
  async expireOrphans(records: readonly RequestRecord[]): Promise<void> {
    for (const record of records) {
      await this.#finalize(record.reference, record.text, EXPIRED_ENDING, this.#now())
      this.#store?.removeRequest(record.id)
    }
  }

  async #finalize(
    reference: MessageReference,
    text: string,
    ending: MessageEnding,
    endedAt: Date,
  ): Promise<void> {
    if (this.#messenger.finalize === undefined) {
      return
    }
    try {
      await this.#messenger.finalize(reference, formatFinalText(text, ending, endedAt), ending)
    } catch (error) {
      console.error('failed to finalize approval message', error)
    }
  }
}
