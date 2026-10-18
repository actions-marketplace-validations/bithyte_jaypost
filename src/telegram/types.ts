export interface Owner {
  id: number | undefined
}

export type TapRoute = 'ignored' | 'accepted' | 'expired'

export type PairResult = 'paired' | 'wrong' | 'blocked' | 'not-pairing'

export type Tap = (id: string, optionIndex: number) => 'accepted' | 'expired'
