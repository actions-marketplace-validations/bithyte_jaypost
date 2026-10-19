import type {
  MessageEnding,
  OwnerCommand,
  RequestResult,
  RequestState,
  Settlement,
} from './types.ts'

/** Timeout when the client sends none, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 300
/** Hard cap on a request's timeout, in seconds (24 h); longer values are clamped. */
export const MAX_TIMEOUT_SECONDS = 86_400
/** Longest a single wait for a result may block, in seconds. */
export const MAX_WAIT_SECONDS = 120
/** How long a settled result is kept for later retrieval, in milliseconds (24 h). */
export const RESULT_TTL_MS = 24 * 60 * 60 * 1000
/** Longest allowed option label, in characters. */
export const MAX_OPTION_LENGTH = 64
/** Longest allowed project name, in characters. */
export const MAX_PROJECT_LENGTH = 100
/** Shared settlement for a request cancelled before an answer. */
export const CANCELLED_SETTLEMENT = { kind: 'cancelled' } as const satisfies Settlement
/** Ending for a request message whose service restarted before it was answered. */
export const EXPIRED_ENDING = { kind: 'expired' } as const satisfies MessageEnding
/** Shared result for `ApprovalService.request` when its signal aborted. */
export const CANCELLED_RESULT = { kind: 'cancelled' } as const satisfies RequestResult
/** Shared state for a background question that was cancelled. */
export const CANCELLED_STATE = { kind: 'cancelled' } as const satisfies RequestState
/** How many settled requests the service remembers; the oldest drop first. */
export const HISTORY_LIMIT = 20
/** Longest request summary in a command reply, in UTF-16 code units. */
export const SUMMARY_MAX_LENGTH = 80
/** How many history entries `/history` shows without an argument. */
export const DEFAULT_HISTORY_COUNT = 10
/** The commands the owner can send, in menu order. */
export const OWNER_COMMANDS: readonly OwnerCommand[] = [
  { name: 'pending', description: 'List open requests' },
  { name: 'cancel', description: 'Reject all open requests with their timeout answers' },
  { name: 'history', description: 'Show recent answers' },
]
