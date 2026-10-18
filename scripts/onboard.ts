import { createInterface } from 'node:readline/promises'
import { existsSync } from 'node:fs'
import { Writable } from 'node:stream'
import { Bot } from 'grammy'
import { configPath, DEFAULT_PORT, saveConfig } from '../src/config.ts'

let muted = false
const output = new Writable({
  write(chunk, _enc, cb) {
    if (!muted) process.stdout.write(chunk)
    cb()
  },
})
const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY })
rl.on('SIGINT', () => {
  console.log('\nAborted, nothing saved.')
  process.exit(130)
})

async function ask(q: string): Promise<string> {
  return (await rl.question(q)).trim()
}

async function askSecret(q: string): Promise<string> {
  process.stdout.write(q)
  muted = true
  try {
    return (await rl.question('')).trim()
  } finally {
    muted = false
    process.stdout.write('\n')
  }
}

async function main(): Promise<void> {
  console.log('Stop the approval service first, a running poller would take the updates.\n')
  const path = configPath()
  if (existsSync(path)) {
    const a = (await ask(`${path} exists and will be overwritten. Continue? [y/N] `)).toLowerCase()
    if (a !== 'y' && a !== 'yes') return console.log('Aborted.')
  }

  let bot: Bot
  let username: string
  let token: string
  for (;;) {
    token = await askSecret('Bot token (input hidden): ')
    bot = new Bot(token)
    try {
      username = (await bot.api.getMe()).username
      break
    } catch {
      // Don't print the error, it may contain the token in a URL.
      console.log('Telegram rejected that token (or could not be reached). Try again.')
    }
  }

  console.log(`Send /start to @${username} from your Telegram account.`)
  let offset = 0
  let ownerId: number | undefined
  while (ownerId === undefined) {
    const updates = await bot.api.getUpdates({ offset, timeout: 30 })
    for (const u of updates) {
      offset = u.update_id + 1
      const m = u.message
      if (m?.chat.type !== 'private' || m.text?.trim() !== '/start' || !m.from) continue
      const who = `${m.from.first_name} (${m.from.username ? '@' + m.from.username : 'no username'}, id ${m.from.id})`
      const a = (await ask(`Use account ${who}? [Y/n] `)).toLowerCase()
      if (a === '' || a === 'y' || a === 'yes') {
        ownerId = m.from.id
        break
      }
      console.log('Waiting for another /start...')
    }
  }
  // Acknowledge consumed updates so /start isn't replayed to the service.
  await bot.api.getUpdates({ offset, timeout: 0 })

  await bot.api.sendMessage(ownerId, 'Linked. Approval requests will appear here.')

  const rawPort = await ask(`Port [${DEFAULT_PORT}]: `)
  const port = rawPort === '' ? DEFAULT_PORT : Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port ${rawPort}`)
  }

  saveConfig(path, { botToken: token, ownerId, port })
  console.log(`Saved ${path}\nNext: npm start`)
}

try {
  await main()
} catch (e) {
  console.error(`Onboarding failed: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
} finally {
  rl.close()
}
