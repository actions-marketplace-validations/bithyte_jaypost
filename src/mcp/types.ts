/** Service endpoints the MCP server calls. */
export type ApiPath = '/request' | '/notify'

/** Outcome of a call to the local service; `message` is ready to show the agent. */
export type ApiResult =
  | { readonly kind: 'ok'; readonly body: unknown }
  | { readonly kind: 'failed'; readonly message: string }

export type ApiOptions = {
  /** Aborting it makes the call fail with "cancelled". */
  readonly signal: AbortSignal
  readonly timeoutMs: number
}
