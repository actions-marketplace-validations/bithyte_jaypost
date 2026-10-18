import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_HOST, DEFAULT_PORT, INIT_HINT, INTEGER_PATTERN } from './constants.ts'
import { fileConfigSchema } from './schema.ts'
import type { Config, FileConfig } from './types.ts'

function envVal(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]
  return v === undefined || v === '' ? undefined : v
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envVal(env, 'APPROVAL_BOT_CONFIG')
  if (explicit) return explicit
  const xdg = envVal(env, 'XDG_CONFIG_HOME')
  const base = xdg ?? join(envVal(env, 'HOME') ?? homedir(), '.config')
  return join(base, 'telegram-approval-bot', 'config.json')
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const { APPROVAL_BOT_CONFIG: _ignored, ...rest } = env
  return dirname(configPath(rest))
}

export function readConfigFile(path: string): FileConfig {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Don't include the parser's message: V8 can quote part of the file, which may hold the bot token.
    throw new Error(`Config file ${path} contains invalid JSON; ${INIT_HINT}`)
  }
  const r = fileConfigSchema.safeParse(parsed)
  // Don't include zod's issues either; keep the token out of error output.
  if (!r.success) throw new Error(`Config file ${path} has invalid or missing fields; ${INIT_HINT}`)
  return r.data
}

function toInt(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isInteger(v) ? v : undefined
  if (typeof v === 'string' && INTEGER_PATTERN.test(v.trim())) return Number(v.trim())
  return undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = readConfigFile(configPath(env))
  const botToken = envVal(env, 'BOT_TOKEN') ?? file.botToken
  if (typeof botToken !== 'string' || botToken === '') {
    throw new Error(`Missing bot token; ${INIT_HINT} (or set BOT_TOKEN)`)
  }
  const rawOwnerId = envVal(env, 'OWNER_ID') ?? file.ownerId
  const ownerId = rawOwnerId === undefined ? undefined : toInt(rawOwnerId)
  if (rawOwnerId !== undefined && (ownerId === undefined || !Number.isSafeInteger(ownerId))) {
    throw new Error(`Invalid owner id; ${INIT_HINT} (or set OWNER_ID)`)
  }
  const rawPort = envVal(env, 'PORT') ?? file.port ?? DEFAULT_PORT
  const port = toInt(rawPort)
  if (port === undefined || port < 1 || port > 65535) {
    throw new Error(`Invalid port ${String(rawPort)}; must be an integer 1-65535`)
  }
  return { botToken, ownerId, port, host: envVal(env, 'HOST') ?? DEFAULT_HOST }
}

/** Merges `patch` into the file's JSON object; a `null` value deletes that key. */
export function updateConfigFile(
  path: string,
  patch: { [K in keyof FileConfig]?: FileConfig[K] | null },
): void {
  const next: Record<string, unknown> = { ...readConfigFile(path) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else if (value !== undefined) next[key] = value
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}
