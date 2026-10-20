import type { Span } from '../format/index.ts'

/**
 * A pending approval request. `reference` is the provider's opaque message reference; `spans` is
 * omitted for plain text (and in files written before formatting existed).
 */
export type RequestRecord = {
  readonly id: string
  readonly reference: unknown
  readonly text: string
  readonly spans?: readonly Span[]
}

/** A sent notification that is still waiting for its expiry. */
export type NotificationRecord = {
  readonly id: string
  readonly reference: unknown
  readonly expiresAtMs: number
}

export type SavedState = {
  readonly requests: readonly RequestRecord[]
  readonly notifications: readonly NotificationRecord[]
}

export type StateParseResult =
  | { readonly ok: true; readonly state: SavedState }
  | { readonly ok: false; readonly reason: string }
