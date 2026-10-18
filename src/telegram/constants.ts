/** Uppercase letters and digits without look-alikes (I, L, O, 0, 1). */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
/** Characters in a pairing code (shown as two groups of four). */
export const PAIRING_CODE_LENGTH = 8
/** Wrong guesses allowed per Telegram user before they are blocked. */
export const DEFAULT_MAX_FAILURES = 5
/** Leading `/start` or `/start@botname` on a pairing message. */
export const START_COMMAND_PATTERN = /^\/start(@\w+)?/i
/** Dashes and whitespace ignored when comparing a typed code. */
export const CODE_SEPARATOR_PATTERN = /[-\s]/g
/** Matches `<id>:<optionIndex>`, the format `formatCallbackData` writes. */
export const CALLBACK_DATA_PATTERN = /^([^:]+):(\d+)$/
