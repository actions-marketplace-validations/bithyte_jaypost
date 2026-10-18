/** Leading `/start` or `/start@botname` on a pairing message. */
export const START_COMMAND_PATTERN = /^\/start(@\w+)?/i
/** Matches `<id>:<optionIndex>`, the format `formatCallbackData` writes. */
export const CALLBACK_DATA_PATTERN = /^([^:]+):(\d+)$/
/** Label of the button that deletes a notification. */
export const DISMISS_LABEL = 'Dismiss'
/** Matches `dismiss/<id>`, the format `formatDismissData` writes; no `:`, so never an approval tap. */
export const DISMISS_DATA_PATTERN = /^dismiss\/([^:]+)$/
/** How long to wait for Telegram when checking a token. */
export const TOKEN_CHECK_TIMEOUT_SECONDS = 10
/** Longest request text sent to Telegram. */
export const TELEGRAM_MAX_TEXT_LENGTH = 3900
