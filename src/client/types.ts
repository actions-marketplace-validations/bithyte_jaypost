/** Where `Client` finds the service, and the project name its messages carry by default. */
export type ClientOptions = {
  /** Default `127.0.0.1`. */
  readonly host?: string
  /** Default 8787. */
  readonly port?: number
  /** Shown as `[project]` on the first line of every message, unless a call sets its own. */
  readonly project?: string
  /**
   * Sent as a bearer token. Default: `TELEGRAM_ASK_TOKEN`, else `~/.config/telegram-ask/token`,
   * looked up on every call. Throws a `RangeError` at construction if it isn't a valid token.
   */
  readonly token?: string
}

/**
 * A question answered by buttons and/or a typed reply; `timeout` in seconds, default 300, max 86400 (24 h); longer values are
 * capped.
 */
export type AskRequest = {
  readonly text: string
  /** Button labels; required unless `allowText`. */
  readonly options?: readonly string[]
  /** Let the owner answer with a text reply. */
  readonly allowText?: boolean
  /** Answer returned on timeout; one of `options`, or with `allowText` any short answer. */
  readonly timeoutOption: string
  readonly timeout?: number
  readonly project?: string
  /** Aborting it cancels the question; the Telegram message is edited to a "cancelled" line. */
  readonly signal?: AbortSignal
}

/** The tapped option or typed reply, or `timeoutOption` with `timedOut` set. */
export type Answer = { readonly answer: string; readonly timedOut: boolean }

/** A message that doesn't need an answer. */
export type Notification = {
  readonly text: string
  readonly project?: string
  readonly signal?: AbortSignal
}

/** HTTP methods the clients use. */
export type ApiMethod = 'GET' | 'POST' | 'DELETE'

/** Service endpoints the clients call. */
export type ApiPath = '/request' | '/notify' | '/request/async' | `/request/${string}`

/** Outcome of a call to the local service; `message` is ready to show the caller. */
export type ApiResult =
  | { readonly kind: 'ok'; readonly body: unknown }
  | { readonly kind: 'failed'; readonly message: string }

export type ApiOptions = {
  /** Aborting it makes the call fail with "cancelled". */
  readonly signal: AbortSignal
  readonly timeoutMs: number
  /** Default `127.0.0.1`. */
  readonly host?: string
  /** Sent as `authorization: Bearer <token>` when set. */
  readonly token?: string
}

/** The body of a /request call. */
export type AskBody = {
  readonly text: string
  readonly options?: readonly string[]
  readonly allowText?: boolean
  readonly timeoutOption: string
  readonly timeout?: number
  readonly project?: string
}

/** `now` returns milliseconds; default `performance.now`. */
export type AskOptions = Omit<ApiOptions, 'timeoutMs'> & { readonly now?: () => number }

/** Outcome of `requestApi`; `message` is ready to show the caller. */
export type AskResult =
  | { readonly kind: 'ok'; readonly outcome: Answer }
  | { readonly kind: 'failed'; readonly message: string }

/** The body of GET /request/<id>. */
export type StateBody =
  | { readonly id: string; readonly state: 'pending'; readonly expiresAt: string }
  | {
      readonly id: string
      readonly state: 'done'
      readonly answer: string
      readonly timedOut: boolean
    }
  | { readonly id: string; readonly state: 'cancelled' }
