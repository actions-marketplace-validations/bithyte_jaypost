/** The service listens on loopback by default. */
export const HOST = '127.0.0.1'
/** Fixed copy for failures, shown to agents and scripts as is. */
export const CANCELLED_MESSAGE = 'cancelled'
export const TOO_OLD_MESSAGE =
  'telegram-ask service is too old for notifications (run telegram-ask init to upgrade)'
export const NOT_SUPPORTED_MESSAGE = 'notifications not supported by this provider'
export const NOT_PAIRED_MESSAGE = "telegram-ask isn't paired yet (run telegram-ask status)"
export const SEND_FAILED_MESSAGE = "couldn't send the message to the user"
/** Extra time the HTTP call gets beyond the approval timeout, so the service answers first. */
export const FETCH_GRACE_MS = 30_000
/** Shown when the service answers 401 and no token was sent. */
export const TOKEN_REQUIRED_MESSAGE =
  'telegram-ask service needs a token; set TELEGRAM_ASK_TOKEN to the contents of ~/.config/telegram-ask/token on the host'
/** Shown when the service answers 401 to a token that was sent. */
export const TOKEN_REJECTED_MESSAGE =
  'telegram-ask service rejected the token; check TELEGRAM_ASK_TOKEN, or re-run telegram-ask init if the token file changed'
