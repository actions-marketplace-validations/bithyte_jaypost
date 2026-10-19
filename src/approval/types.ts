import type { RequestRecord } from '../state/index.ts'

/** As produced by `parseApprovalRequest`: timeout is clamped, `timeoutOption` is in `options`. */
export type ApprovalRequest = {
  readonly text: string
  readonly options: readonly string[]
  readonly timeoutOption: string
  readonly timeoutSeconds: number
}

/** The answer sent back to the HTTP client. */
export type Outcome = {
  readonly answer: string
  readonly timedOut: boolean
}

/** What `ApprovalService.request` resolves to; `cancelled` when its signal aborted. */
export type RequestResult =
  | { readonly kind: 'completed'; readonly outcome: Outcome }
  | { readonly kind: 'cancelled' }

/**
 * How a pending request ended; `answer` is the chosen option, or the timeout option for `timedOut`.
 */
export type Settlement =
  | { readonly kind: 'answered'; readonly answer: string }
  | { readonly kind: 'timedOut'; readonly answer: string }
  | { readonly kind: 'cancelled' }

/**
 * How a request message ends; `expired` is only used by startup recovery, never by `PendingRequests`.
 */
export type MessageEnding = Settlement | { readonly kind: 'expired' }

/** Outcome of validating a request body; `error` is the client-facing message. */
export type ParseResult =
  | { readonly ok: true; readonly value: ApprovalRequest }
  | { readonly ok: false; readonly error: string }

/**
 * Opaque handle to a sent message; the core only hands it back to the messenger. Must be
 * JSON-serializable, since references are saved to the state file.
 */
export type MessageReference = unknown

/** Chat transport the service uses, so the approval logic stays independent of any provider. */
export type Messenger = {
  /** The returned reference must be JSON-serializable (it's saved to the state file). */
  readonly sendRequest: (
    id: string,
    text: string,
    options: readonly string[],
  ) => Promise<MessageReference>
  /** Request ended: show the final text and stop accepting answers. Absent means skipped. */
  readonly finalize?: (
    reference: MessageReference,
    text: string,
    ending: MessageEnding,
  ) => Promise<void>
}

/** Where in-flight requests are saved so a restart can expire them; calls must not throw. */
export type RequestStore = {
  readonly addRequest: (record: RequestRecord) => void
  readonly removeRequest: (id: string) => void
}

/** Optional collaborators of `ApprovalService`. */
export type ApprovalServiceOptions = {
  readonly store?: RequestStore
}

/** A pending request with its timeout timer and the resolver that settles it. */
export type PendingEntry = {
  readonly request: ApprovalRequest
  readonly timer: ReturnType<typeof setTimeout>
  readonly resolve: (settlement: Settlement) => void
}
