/** Shared mutable cell: pairing sets `id`, and the messenger and tap handler read it live. */
export type Owner = {
  id: number | undefined
}

/** What happened to a button tap: not from the owner, handled, or no longer valid. */
export type TapRoute = 'ignored' | 'accepted' | 'expired'

/**
 * Outcome of one pairing attempt; `blocked` after too many wrong guesses, `notPairing` once paired.
 */
export type PairResult = 'paired' | 'wrong' | 'blocked' | 'notPairing'

/** The parts of an incoming Telegram message that pairing looks at. */
export type PairingMessage = {
  readonly fromId: number
  readonly chatType: string
  readonly text: string
}

/** Records an answer for request `id`; 'expired' when it is unknown or already settled. */
export type Tap = (id: string, optionIndex: number) => 'accepted' | 'expired'
