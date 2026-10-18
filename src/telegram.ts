import type { Bot } from 'grammy'
import { updateConfigFile } from './config.ts'
import type { MessageRef, Messenger } from './messenger.ts'
import type { Pairing } from './pairing.ts'

export interface Owner {
  id: number | undefined
}

export type TapRoute = 'ignored' | 'accepted' | 'expired'
type Tap = (id: string, optionIndex: number) => 'accepted' | 'expired'

export function callbackData(id: string, optionIndex: number): string {
  return `${id}:${optionIndex}`
}

export function routeTap(
  fromId: number,
  data: string | undefined,
  ownerId: number | undefined,
  tap: Tap,
): TapRoute {
  if (ownerId === undefined || fromId !== ownerId) return 'ignored'
  const m = data === undefined ? null : /^([^:]+):(\d+)$/.exec(data)
  if (!m) return 'expired'
  return tap(m[1]!, Number(m[2]))
}

export function createTelegramMessenger(bot: Bot, owner: Owner): Messenger {
  return {
    async sendRequest(id, text, options): Promise<MessageRef> {
      if (owner.id === undefined) throw new Error('bot is not paired yet')
      const sent = await bot.api.sendMessage(owner.id, text, {
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

export function registerTapHandler(bot: Bot, owner: Owner, tap: Tap): void {
  bot.on('callback_query:data', async (ctx) => {
    const route = routeTap(ctx.from.id, ctx.callbackQuery.data, owner.id, tap)
    if (route === 'expired') await ctx.answerCallbackQuery({ text: 'Expired' })
    else await ctx.answerCallbackQuery()
  })
}

export function handlePairingMessage(
  msg: { fromId: number; chatType: string; text: string },
  pairing: Pairing,
  onPaired: (id: number) => void,
): string | undefined {
  if (msg.chatType !== 'private') return undefined
  const result = pairing.attempt(msg.fromId, msg.text)
  if (result === 'paired') {
    onPaired(msg.fromId)
    return 'Paired. Approval requests will appear here.'
  }
  if (result === 'wrong') {
    return "This bot isn't paired. Check the service logs for the pairing code."
  }
  return undefined
}

export function registerPairingHandler(
  bot: Bot,
  pairing: Pairing,
  onPaired: (id: number) => void,
): void {
  bot.on('message:text', async (ctx) => {
    const reply = handlePairingMessage(
      { fromId: ctx.from.id, chatType: ctx.chat.type, text: ctx.message.text },
      pairing,
      onPaired,
    )
    if (reply !== undefined) await ctx.reply(reply)
  })
}

export function makeOnPaired(
  owner: Owner,
  path: string,
  log: (line: string) => void = console.error,
): (id: number) => void {
  return (id) => {
    owner.id = id
    try {
      updateConfigFile(path, { ownerId: id })
    } catch {
      log(`paired with ${id} but couldn't save the owner to ${path}; it'll be lost on restart`)
    }
  }
}
