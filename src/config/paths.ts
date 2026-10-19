import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Env value, with an empty string counting as unset. */
export function findEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]
  return value === undefined || value === '' ? undefined : value
}

/**
 * Path of config.json: $TELEGRAM_ASK_CONFIG, else under $XDG_CONFIG_HOME or ~/.config. Empty env
 * values count as unset.
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = findEnvValue(env, 'TELEGRAM_ASK_CONFIG')
  if (explicit) {
    return explicit
  }
  const xdgConfigHome = findEnvValue(env, 'XDG_CONFIG_HOME')
  const base = xdgConfigHome ?? join(findEnvValue(env, 'HOME') ?? homedir(), '.config')
  return join(base, 'telegram-ask', 'config.json')
}

/** Default config directory, ignoring $TELEGRAM_ASK_CONFIG; install files live here. */
export function resolveConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const { TELEGRAM_ASK_CONFIG: _ignored, ...rest } = env
  return dirname(resolveConfigPath(rest))
}
