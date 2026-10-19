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
