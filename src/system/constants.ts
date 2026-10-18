/** Matches `Linger=yes` in `loginctl show-user` output. */
export const LINGER_ON_PATTERN = /Linger=yes/
/** Matches `Linger=no` in `loginctl show-user` output. */
export const LINGER_OFF_PATTERN = /Linger=no/
/** How long to wait for Telegram when checking a token. */
export const TOKEN_CHECK_TIMEOUT_SECONDS = 10
