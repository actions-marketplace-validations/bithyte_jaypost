/** Shared mutable cell: pairing sets `id`, and the messenger and tap handler read it live. */
export type Owner = {
  id: number | undefined
}

export type TapRoute = 'ignored' | 'accepted' | 'expired'

export type PairResult = 'paired' | 'wrong' | 'blocked' | 'notPairing'

export type PairingMessage = {
  readonly fromId: number
  readonly chatType: string
  readonly text: string
}

export type Tap = (id: string, optionIndex: number) => 'accepted' | 'expired'
