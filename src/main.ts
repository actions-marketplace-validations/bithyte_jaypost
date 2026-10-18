import { Bot, GrammyError } from 'grammy'
import { ApprovalService } from './approvals.ts'
import { loadConfig } from './config.ts'
import type { Config } from './config.ts'
import { createApiServer } from './http.ts'
import { createTelegramMessenger, registerTapHandler } from './telegram.ts'

let config: Config
try {
  config = loadConfig()
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}

const bot = new Bot(config.botToken)
const service = new ApprovalService(createTelegramMessenger(bot, config.ownerId))
registerTapHandler(bot, config.ownerId, (id, i) => service.tap(id, i))

// Log handler errors instead of crashing; grammY's error text doesn't include the token.
bot.catch((err) => {
  console.error('bot error:', err.error instanceof Error ? err.error.message : err.error)
})

const server = createApiServer(service)
server.on('error', (e) => {
  console.error('http server error:', e.message)
  process.exit(1)
})
server.listen(config.port, config.host, () => {
  console.log(`listening on ${config.host}:${config.port}`)
})

let stopping = false
function shutdown(): void {
  if (stopping) return
  stopping = true
  setTimeout(() => process.exit(0), 5000).unref()
  server.close()
  server.closeAllConnections()
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
