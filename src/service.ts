import { Bot, GrammyError } from 'grammy'
import { ApprovalService } from './approvals.ts'
import { configPath, loadConfig } from './config.ts'
import type { Config } from './config.ts'
import { createApiServer } from './http.ts'
import { formatCode, generateCode, Pairing } from './pairing.ts'
import {
  createTelegramMessenger,
  makeOnPaired,
  registerPairingHandler,
  registerTapHandler,
} from './telegram.ts'
import type { Owner } from './telegram.ts'

export async function runService(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let config: Config
  try {
    config = loadConfig(env)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  const owner: Owner = { id: config.ownerId }
  const bot = new Bot(config.botToken)
  const service = new ApprovalService(createTelegramMessenger(bot, owner))
  registerTapHandler(bot, owner, (id, i) => service.tap(id, i))

  // Log handler errors instead of crashing; grammY's error text doesn't include the token.
  bot.catch((err) => {
    console.error('bot error:', err.error instanceof Error ? err.error.message : err.error)
  })

  try {
    await bot.init()
  } catch (e) {
    // Don't print the error text; it can embed the request URL with the token.
    console.error(
      e instanceof GrammyError
        ? `Telegram rejected the bot token (${e.error_code}); check it with \`telegram-approval-bot init\``
        : 'could not reach Telegram to verify the bot token',
    )
    process.exit(1)
  }
  const botUsername = bot.botInfo.username

  let pairing: Pairing | undefined
  if (owner.id === undefined) {
    pairing = new Pairing(generateCode())
    console.log(
      `Not paired. Send "/start ${formatCode(pairing.code!)}" to @${botUsername}, or open https://t.me/${botUsername}?start=${pairing.code}`,
    )
    registerPairingHandler(bot, pairing, makeOnPaired(owner, configPath(env)))
  }

  const server = createApiServer(service, () =>
    owner.id !== undefined || pairing === undefined || pairing.code === undefined
      ? { paired: true, bot: botUsername }
      : { paired: false, code: formatCode(pairing.code), bot: botUsername },
  )
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

  bot.start({ onStart: (me) => console.log(`bot @${me.username} polling`) }).catch((e: unknown) => {
    if (stopping) return
    if (e instanceof GrammyError && e.error_code === 409) {
      console.error('another instance is already polling with this bot token; exiting')
    } else {
      console.error('bot stopped:', e instanceof Error ? e.message : String(e))
    }
    process.exit(1)
  })
}
