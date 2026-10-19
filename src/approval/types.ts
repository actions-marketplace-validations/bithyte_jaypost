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
 * How a pending request ended; `answer` is the chosen option, or the timeout option for `timedOut`
 * and `rejected`.
 */
export type Settlement =
  | { readonly kind: 'answered'; readonly answer: string }
  | { readonly kind: 'timedOut'; readonly answer: string }
  | { readonly kind: 'rejected'; readonly answer: string }
  | { readonly kind: 'cancelled' }

/**
 * How a request message ends; `expired` is only used by startup recovery, never by `PendingRequests`.
 */
export type MessageEnding = Settlement | { readonly kind: 'expired' }

/**
 * State of a background question as `ApprovalService.get` reports it; `done` covers a tap, the
 * timeout and the owner's /cancel, with `timedOut` telling the timeout apart.
 */
export type RequestState =
  | { readonly kind: 'pending'; readonly expiresAt: Date }
  | { readonly kind: 'done'; readonly outcome: Outcome }
  | { readonly kind: 'cancelled' }

/** What `ApprovalService.start` resolves to; `expiresAt` is when the timeout fires. */
export type StartedRequest = {
  readonly id: string
  readonly expiresAt: Date
}

/** Outcome of validating a `wait` query value; `error` is the client-facing message. */
export type WaitParseResult =
  | { readonly ok: true; readonly seconds: number }
  | { readonly ok: false; readonly error: string }

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
  readonly openedAt: Date
  readonly timer: ReturnType<typeof setTimeout>
  readonly resolve: (settlement: Settlement) => void
}

/** A sent request now waiting in `PendingRequests`; `settlement` resolves once it settles. */
export type OpenedRequest = {
  readonly id: string
  readonly reference: MessageReference
  readonly openedAt: Date
  readonly settlement: Promise<Settlement>
}

/**
 * A background question's current state; `settled` resolves with the final state as soon as it is
 * recorded, before the final edit.
 */
export type BackgroundEntry = {
  readonly state: RequestState
  readonly settled: Promise<RequestState>
}

/** A settled request as kept in the service's in-memory history. */
export type HistoryEntry = {
  readonly text: string
  readonly settlement: Settlement
  readonly settledAt: Date
}

/** An open request as listed to the owner, oldest first. */
export type PendingSummary = {
  readonly id: string
  readonly request: ApprovalRequest
  readonly openedAt: Date
}

/** A command the owner can send to the bot; `description` is its menu text. */
export type OwnerCommand = {
  readonly name: 'pending' | 'cancel' | 'history' | 'mute' | 'unmute' | 'quiet'
  readonly description: string
}

/** Inputs `runOwnerCommand` can't get from the service: the clock and the reply length limit. */
export type OwnerCommandOptions = {
  readonly now: () => Date
  readonly maxTextLength: number
}
