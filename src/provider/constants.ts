/** Provider used when config, env and install state name none. */
export const DEFAULT_PROVIDER = 'telegram'
/** Config keys owned by core; no provider setting may use them. */
export const RESERVED_CONFIG_KEYS: readonly string[] = ['provider', 'port']
/** Env vars owned by core; no provider setting may use them. */
export const RESERVED_ENV_VARS: readonly string[] = [
  'PROVIDER',
  'PORT',
  'HOST',
  'TELEGRAM_ASK_CONFIG',
]
