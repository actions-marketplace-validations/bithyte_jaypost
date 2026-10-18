import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface Config {
  botToken: string
  ownerId: number
  port: number
  host: string
}

export const DEFAULT_PORT = 8787

const ONBOARD_HINT = 'run `npm run onboard` to set up the bot'

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

function readFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Don't include the parser's message: V8 can quote part of the file, which may hold the bot token.
    throw new Error(`Config file ${path} contains invalid JSON; ${ONBOARD_HINT}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config file ${path} must contain a JSON object; ${ONBOARD_HINT}`)
  }
  return parsed as Record<string, unknown>
}

function toInt(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isInteger(v) ? v : undefined
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim())
  return undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = readFile(configPath(env))
  const botToken = envVal(env, 'BOT_TOKEN') ?? file.botToken
  if (typeof botToken !== 'string' || botToken === '') {
    throw new Error(`Missing bot token; ${ONBOARD_HINT} (or set BOT_TOKEN)`)
  }
  const ownerId = toInt(envVal(env, 'OWNER_ID') ?? file.ownerId)
  if (ownerId === undefined || !Number.isSafeInteger(ownerId)) {
    throw new Error(`Missing or invalid owner id; ${ONBOARD_HINT} (or set OWNER_ID)`)
  }
  const rawPort = envVal(env, 'PORT') ?? file.port ?? DEFAULT_PORT
  const port = toInt(rawPort)
  if (port === undefined || port < 1 || port > 65535) {
    throw new Error(`Invalid port ${String(rawPort)}; must be an integer 1-65535`)
  }
  return { botToken, ownerId, port, host: envVal(env, 'HOST') ?? '127.0.0.1' }
}

export function saveConfig(path: string, c: Omit<Config, 'host'>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}
