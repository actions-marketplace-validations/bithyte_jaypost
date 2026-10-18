import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = findEnvValue(env, 'APPROVAL_BOT_CONFIG')
  if (explicit) return explicit
  const xdgConfigHome = findEnvValue(env, 'XDG_CONFIG_HOME')
  const base = xdgConfigHome ?? join(findEnvValue(env, 'HOME') ?? homedir(), '.config')
  return join(base, 'telegram-approval-bot', 'config.json')
}

export function resolveConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const { APPROVAL_BOT_CONFIG: _ignored, ...rest } = env
  return dirname(resolveConfigPath(rest))
}

export function readConfigFile(path: string): FileConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) return {}
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Don't include the parser's message: V8 can quote part of the file, which may hold the bot token.
    throw new Error(`Config file ${path} contains invalid JSON; ${INIT_HINT}`)
  }
  const result = fileConfigSchema.safeParse(parsed)
  // Don't include zod's issues either; keep the token out of error output.
  if (!result.success) {
    throw new Error(`Config file ${path} has invalid or missing fields; ${INIT_HINT}`)
  }
  return result.data
}

function toInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined
  if (typeof value === 'string' && INTEGER_PATTERN.test(value.trim())) return Number(value.trim())
  return undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = readConfigFile(resolveConfigPath(env))
  const botToken = findEnvValue(env, 'BOT_TOKEN') ?? file.botToken
  if (typeof botToken !== 'string' || botToken === '') {
    throw new Error(`Missing bot token; ${INIT_HINT} (or set BOT_TOKEN)`)
  }
  const rawOwnerId = findEnvValue(env, 'OWNER_ID') ?? file.ownerId
  const ownerId = rawOwnerId === undefined ? undefined : toInteger(rawOwnerId)
  if (rawOwnerId !== undefined && (ownerId === undefined || !Number.isSafeInteger(ownerId))) {
    throw new Error(`Invalid owner id; ${INIT_HINT} (or set OWNER_ID)`)
  }
  const rawPort = findEnvValue(env, 'PORT') ?? file.port ?? DEFAULT_PORT
  const port = toInteger(rawPort)
  if (port === undefined || port < 1 || port > 65535) {
    throw new Error(`Invalid port ${String(rawPort)}; must be an integer 1-65535`)
  }
  return { botToken, ownerId, port, host: findEnvValue(env, 'HOST') ?? DEFAULT_HOST }
}

/** Merges `patch` into the file's JSON object; a `null` value deletes that key. */
export function updateConfigFile(path: string, patch: ConfigPatch): void {
  const next: Record<string, unknown> = { ...readConfigFile(path) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else if (value !== undefined) next[key] = value
  }
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, SECRET_FILE_MODE)
}
