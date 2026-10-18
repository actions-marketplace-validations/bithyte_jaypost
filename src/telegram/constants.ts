/** Leading `/start` or `/start@botname` on a pairing message. */
export const START_COMMAND_PATTERN = /^\/start(@\w+)?/i
/** Matches `<id>:<optionIndex>`, the format `formatCallbackData` writes. */
export const CALLBACK_DATA_PATTERN = /^([^:]+):(\d+)$/
/** Label of the button that deletes a notification. */
export const DISMISS_LABEL = 'Dismiss'
/** Matches `dismiss/<id>`, the format `formatDismissData` writes; no `:`, so never an approval tap. */
export const DISMISS_DATA_PATTERN = /^dismiss\/([^:]+)$/
