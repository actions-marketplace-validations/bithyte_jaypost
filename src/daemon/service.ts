import { Bot, GrammyError } from 'grammy'
import { ApprovalService } from '../approval/index.ts'
import { loadConfig, resolveConfigPath } from '../config/index.ts'
import type { Config } from '../config/index.ts'
import { createApiServer } from '../server/index.ts'
import {
  createOnPaired,
  createTelegramMessenger,
  formatCode,
  generateCode,
  Pairing,
  registerPairingHandler,
  registerTapHandler,
} from '../telegram/index.ts'
import type { Owner } from '../telegram/index.ts'

/** Starts the bot and API; exits the process with 1 on bad config, token or port, or a second poller. */
export async function runService(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let config: Config
  try {
    config = loadConfig(env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  const owner: Owner = { id: config.ownerId }
  const bot = new Bot(config.botToken)
  const service = new ApprovalService(createTelegramMessenger(bot, owner))
  registerTapHandler(bot, owner, (id, optionIndex) => service.tap(id, optionIndex))
  // Log handler errors instead of crashing; grammY's error text doesn't include the token.
  bot.catch((error) => {
    console.error('bot error:', error.error instanceof Error ? error.error.message : error.error)
  })
  try {
    await bot.init()
  } catch (error) {
    // Don't print the error text; it can embed the request URL with the token.
    console.error(
      error instanceof GrammyError
        ? `Telegram rejected the bot token (${error.error_code}); check it with \`telegram-approval-bot init\``
        : 'could not reach Telegram to verify the bot token',
    )
    process.exit(1)
  }
  const botUsername = bot.botInfo.username
  let pairing: Pairing | undefined
  if (owner.id === undefined) {
    const code = generateCode()
    pairing = new Pairing(code)
    console.log(
      `Not paired. Send "/start ${formatCode(code)}" to @${botUsername}, or open https://t.me/${botUsername}?start=${code}`,
    )
    registerPairingHandler(bot, pairing, createOnPaired(owner, resolveConfigPath(env)))
  }
  const server = createApiServer(service, () =>
    owner.id !== undefined || pairing === undefined || pairing.code === undefined
      ? { paired: true, bot: botUsername }
      : { paired: false, code: formatCode(pairing.code), bot: botUsername },
  )
  server.listen({ port: config.port, host: config.host }).then(
    () => console.log(`listening on ${config.host}:${config.port}`),
    (error: unknown) => {
      console.error('http server error:', error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
  let stopping = false
  function shutdown(): void {
    if (stopping) {
      return
    }
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
    .start({ onStart: (botUser) => console.log(`bot @${botUser.username} polling`) })
    .catch((error: unknown) => {
      if (stopping) {
        return
      }
      if (error instanceof GrammyError && error.error_code === 409) {
        console.error('another instance is already polling with this bot token; exiting')
      } else {
        console.error('bot stopped:', error instanceof Error ? error.message : String(error))
      }
      process.exit(1)
    })
}
