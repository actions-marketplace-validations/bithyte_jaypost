/** Request body cap; larger bodies get a 413. */
export const MAX_BODY_BYTES = 65_536

/** Paths of the form /request/:id, for the 405 Allow header. */
export const REQUEST_ID_PATH_PATTERN = /^\/request\/[^/]+$/

/** Body of the 404 for an id that was never created, expired or was lost to a restart. */
export const UNKNOWN_REQUEST_ERROR = 'unknown request'
