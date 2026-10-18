import type { RequestResult, Settlement } from './types.ts'

/** Hard cap on a request's timeout; also the timeout when the client sends none. */
export const MAX_TIMEOUT_SECONDS = 300
/** Longest allowed option label, in characters. */
export const MAX_OPTION_LENGTH = 64
/** Longest allowed project name, in characters. */
export const MAX_PROJECT_LENGTH = 100
/** Shared settlement for a request cancelled before an answer. */
export const CANCELLED_SETTLEMENT = { kind: 'cancelled' } as const satisfies Settlement
/** Shared result for `ApprovalService.request` when its signal aborted. */
export const CANCELLED_RESULT = { kind: 'cancelled' } as const satisfies RequestResult
