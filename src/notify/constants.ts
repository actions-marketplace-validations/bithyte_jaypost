/** How long a notification stays before it's deleted: 8 hours. */
export const NOTIFICATION_TTL_MS = 28_800_000

/** The largest delay `setTimeout` accepts; larger values overflow and fire immediately. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1
