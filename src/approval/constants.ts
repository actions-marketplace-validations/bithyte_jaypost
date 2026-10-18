import type { RequestResult, Settlement } from './types.ts'

export const MAX_TIMEOUT_SECONDS = 300
export const MAX_OPTION_LENGTH = 64
export const MAX_TEXT_LENGTH = 3900 // leaves room for the appended result line under Telegram's 4096
export const CANCELLED_SETTLEMENT = { kind: 'cancelled' } as const satisfies Settlement
export const CANCELLED_RESULT = { kind: 'cancelled' } as const satisfies RequestResult
