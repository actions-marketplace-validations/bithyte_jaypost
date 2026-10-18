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

export type Settlement =
  | { readonly kind: 'answered'; readonly answer: string }
  | { readonly kind: 'timedOut'; readonly answer: string }
  | { readonly kind: 'cancelled' }

export type ParseResult =
  | { readonly ok: true; readonly value: ApprovalRequest }
  | { readonly ok: false; readonly error: string }

export type MessageReference = {
  readonly chatId: number
  readonly messageId: number
}

export type Messenger = {
  readonly sendRequest: (
    id: string,
    text: string,
    options: readonly string[],
  ) => Promise<MessageReference>
  /** Replace the message text and remove its buttons. */
  readonly finalize: (reference: MessageReference, text: string) => Promise<void>
}

export type PendingEntry = {
  readonly request: ApprovalRequest
  readonly timer: ReturnType<typeof setTimeout>
  readonly resolve: (settlement: Settlement) => void
}
