/** A pending approval request. `reference` is the provider's opaque message reference. */
export type RequestRecord = {
  readonly id: string
  readonly reference: unknown
  readonly text: string
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
