import type { Bot } from 'grammy'
import type { MessageRef, Messenger } from './messenger.ts'

export type TapRoute = 'ignored' | 'accepted' | 'expired'
type Tap = (id: string, optionIndex: number) => 'accepted' | 'expired'

export function callbackData(id: string, optionIndex: number): string {
  return `${id}:${optionIndex}`
}

export function routeTap(
  fromId: number,
  data: string | undefined,
  ownerId: number,
  tap: Tap,
): TapRoute {
  if (fromId !== ownerId) return 'ignored'
  const m = data === undefined ? null : /^([^:]+):(\d+)$/.exec(data)
  if (!m) return 'expired'
  return tap(m[1]!, Number(m[2]))
}

export function createTelegramMessenger(bot: Bot, ownerId: number): Messenger {
  return {
    async sendRequest(id, text, options): Promise<MessageRef> {
      const sent = await bot.api.sendMessage(ownerId, text, {
        reply_markup: {
          inline_keyboard: options.map((label, i) => [
            { text: label, callback_data: callbackData(id, i) },
          ]),
        },
      })
      return { chatId: sent.chat.id, messageId: sent.message_id }
    },
    async finalize(ref, text) {
      await bot.api.editMessageText(ref.chatId, ref.messageId, text, {
        reply_markup: { inline_keyboard: [] },
      })
    },
  }
}

export function registerTapHandler(bot: Bot, ownerId: number, tap: Tap): void {
  bot.on('callback_query:data', async (ctx) => {
    const route = routeTap(ctx.from.id, ctx.callbackQuery.data, ownerId, tap)
    if (route === 'expired') await ctx.answerCallbackQuery({ text: 'Expired' })
    else await ctx.answerCallbackQuery()
  })
}
