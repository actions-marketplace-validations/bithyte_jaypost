import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_PROVIDER, PROVIDERS, requireProvider } from '../provider/index.ts'
import type { Provider, SettingValue } from '../provider/index.ts'
import { isMissingFileError, writeFileAtomic } from '../system/index.ts'
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  INIT_HINT,
  INTEGER_PATTERN,
  SECRET_FILE_MODE,
} from './constants.ts'
import { fileConfigSchema } from './schema.ts'
import type { Config, ConfigPatch, FileConfig } from './types.ts'

function findEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
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

/**
 * Returns {} when the file is missing. Throws on invalid JSON or fields, without quoting the file,
 * since it may hold provider secrets. Read errors other than a missing file are rethrown.
 */
export function readConfigFile(path: string): FileConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return {}
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Don't include the parser's message: V8 can quote part of the file, which may hold a
    // secret.
    throw new Error(`config file ${JSON.stringify(path)} contains invalid JSON; ${INIT_HINT}`)
  }
  const result = fileConfigSchema.safeParse(parsed)
  // Don't include zod's issues either; keep secrets out of error output.
  if (!result.success) {
    throw new Error(
      `config file ${JSON.stringify(path)} has invalid or missing fields; ${INIT_HINT}`,
    )
  }
  return result.data
}

function toInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined
  }
  if (typeof value === 'string' && INTEGER_PATTERN.test(value.trim())) {
    return Number(value.trim())
  }
  return undefined
}

/**
 * Provider (PROVIDER env, else the file, else telegram), its settings, port and host. Env vars
 * (e.g. PROVIDER, PORT, HOST) override the config file. Throws a user-facing error on an unknown
 * provider, a missing required setting, or an invalid setting or port; read errors other than a
 * missing config file are rethrown.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  providers: readonly Provider[] = PROVIDERS,
): Config {
  const file = readConfigFile(resolveConfigPath(env))
  const provider = requireProvider(
    providers,
    findEnvValue(env, 'PROVIDER') ?? file.provider ?? DEFAULT_PROVIDER,
  )
  const settings: Record<string, SettingValue> = {}
  for (const setting of provider.settings) {
    const raw = findEnvValue(env, setting.envVar) ?? file[setting.configKey]
    if (raw === undefined) {
      if (setting.required) {
        throw new Error(`missing ${setting.description}; ${INIT_HINT} (or set ${setting.envVar})`)
      }
      continue
    }
    const value = setting.parse(raw)
    if (value === undefined) {
      throw new Error(`invalid ${setting.description}; ${INIT_HINT} (or set ${setting.envVar})`)
    }
    settings[setting.configKey] = value
  }
  const rawPort = findEnvValue(env, 'PORT') ?? file.port ?? DEFAULT_PORT
  const port = toInteger(rawPort)
  if (port === undefined || port < 1 || port > 65535) {
    throw new Error(`invalid port ${JSON.stringify(String(rawPort))}: must be an integer 1-65535`)
  }
  return { provider, settings, port, host: findEnvValue(env, 'HOST') ?? DEFAULT_HOST }
}

/** Merges `patch` into the file's JSON object; a `null` value deletes that key. */
export function updateConfigFile(path: string, patch: ConfigPatch): void {
  const next: Record<string, unknown> = { ...readConfigFile(path) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key]
    } else if (value !== undefined) {
      next[key] = value
    }
  }
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, SECRET_FILE_MODE)
}
