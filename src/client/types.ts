/** Where `Client` finds the service, and the project name its messages carry by default. */
export type ClientOptions = {
  /** Default `127.0.0.1`. */
  readonly host?: string
  /** Default 8787. */
  readonly port?: number
  /** Shown as `[project]` on the first line of every message, unless a call sets its own. */
  readonly project?: string
}

/** A question with buttons; `timeout` in seconds, default and max 300. */
export type AskRequest = {
  readonly text: string
  readonly options: readonly string[]
  /** Answer returned on timeout; one of `options`. */
  readonly timeoutOption: string
  readonly timeout?: number
  readonly project?: string
  /** Aborting it cancels the question; the Telegram message is edited to a "cancelled" line. */
  readonly signal?: AbortSignal
}

/** The tapped option, or `timeoutOption` with `timedOut` set. */
export type Answer = { readonly answer: string; readonly timedOut: boolean }

/** A message that doesn't need an answer. */
export type Notification = {
  readonly text: string
  readonly project?: string
  readonly signal?: AbortSignal
}

/** Service endpoints the clients call. */
export type ApiPath = '/request' | '/notify'

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
}
