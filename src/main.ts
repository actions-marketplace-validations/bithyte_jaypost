import { Bot, GrammyError } from 'grammy'
import { ApprovalService } from './approvals.ts'
import { loadConfig } from './config.ts'
import type { Config } from './config.ts'
import { createApiServer } from './http.ts'
import { createTelegramMessenger, registerTapHandler } from './telegram.ts'
import type { Owner } from './telegram.ts'

let config: Config
try {
  config = loadConfig()
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}

const ownerId = config.ownerId
if (ownerId === undefined) {
  console.error(
    'Missing owner id; run `telegram-approval-bot init` to set up the bot (or set OWNER_ID)',
  )
  process.exit(1)
}

let botUsername = 'bot'
const owner: Owner = { id: ownerId }
const bot = new Bot(config.botToken)
const service = new ApprovalService(createTelegramMessenger(bot, owner))
registerTapHandler(bot, owner, (id, i) => service.tap(id, i))

// Log handler errors instead of crashing; grammY's error text doesn't include the token.
bot.catch((err) => {
  console.error('bot error:', err.error instanceof Error ? err.error.message : err.error)
})

const server = createApiServer(service, () => ({
  paired: true,
  bot: botUsername,
}))
server.listen({ port: config.port, host: config.host }).then(
  () => console.log(`listening on ${config.host}:${config.port}`),
  (e: unknown) => {
    console.error('http server error:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  },
)

let stopping = false
function shutdown(): void {
  if (stopping) return
  stopping = true
  setTimeout(() => process.exit(0), 5000).unref()
  server.close().catch(() => {})
  bot
    .stop()
    .catch(() => {})
    .finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

bot
  .start({
    onStart: (me) => {
      botUsername = me.username
      console.log(`bot @${me.username} polling`)
    },
  })
  .catch((e: unknown) => {
    if (stopping) return
    if (e instanceof GrammyError && e.error_code === 409) {
      console.error('another instance is already polling with this bot token; exiting')
    } else {
      console.error('bot stopped:', e instanceof Error ? e.message : String(e))
    }
    process.exit(1)
  })
