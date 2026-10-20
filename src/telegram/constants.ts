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
/** Hint appended to a text-enabled request that has buttons. */
export const TEXT_HINT_WITH_BUTTONS = 'Tap a button or reply to this message to type an answer.'
/** Hint appended to a text-enabled request without buttons. */
export const TEXT_HINT_WITHOUT_BUTTONS = 'Reply to this message with your answer.'
/** Bot answer to a typed reply on a question that only takes buttons. */
export const BUTTONS_ONLY_REPLY = 'Tap one of the buttons to answer this question.'
/** Bot answer to a reply on a message that isn't an open question (or has expired). */
export const NOT_OPEN_REPLY = "That message isn't waiting for an answer."
/** Bot answer to a plain message while several text questions are open. */
export const AMBIGUOUS_REPLY = "Several questions are open; reply to the one you're answering."
/** Bot answer to a non-text reply on an open text question. */
export const NOT_TEXT_REPLY = 'Only text replies count as an answer.'
