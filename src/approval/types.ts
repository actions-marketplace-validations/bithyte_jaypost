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

/** Outcome of validating a request body; `error` is the client-facing message. */
export type ParseResult =
  | { readonly ok: true; readonly value: ApprovalRequest }
  | { readonly ok: false; readonly error: string }

/** Opaque handle to a sent message; the core only hands it back to the messenger. */
export type MessageReference = unknown

/** Chat transport the service uses, so the approval logic stays independent of any provider. */
export type Messenger = {
  readonly sendRequest: (
    id: string,
    text: string,
    options: readonly string[],
  ) => Promise<MessageReference>
  /** Request ended: show the final text and stop accepting answers. Absent means skipped. */
  readonly finalize?: (
    reference: MessageReference,
    text: string,
    settlement: Settlement,
  ) => Promise<void>
}

/** A pending request with its timeout timer and the resolver that settles it. */
export type PendingEntry = {
  readonly request: ApprovalRequest
  readonly timer: ReturnType<typeof setTimeout>
  readonly resolve: (settlement: Settlement) => void
}
