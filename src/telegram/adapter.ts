import type { Bot } from 'grammy'
import type { MessageReference, Messenger } from '../approval/index.ts'
import { updateConfigFile } from '../config/index.ts'
import { CALLBACK_DATA_PATTERN } from './constants.ts'
import type { Pairing } from './pairing.ts'
import type { Owner, PairingMessage, Tap, TapRoute } from './types.ts'

export function formatCallbackData(id: string, optionIndex: number): string {
  return `${id}:${optionIndex}`
}

export function routeTap(
  fromId: number,
  data: string | undefined,
  ownerId: number | undefined,
  tap: Tap,
): TapRoute {
  if (ownerId === undefined || fromId !== ownerId) return 'ignored'
  const [, id, rawIndex] = (data === undefined ? null : CALLBACK_DATA_PATTERN.exec(data)) ?? []
  if (id === undefined || rawIndex === undefined) return 'expired'
  return tap(id, Number(rawIndex))
}

export function createTelegramMessenger(bot: Bot, owner: Owner): Messenger {
  return {
    async sendRequest(id, text, options): Promise<MessageReference> {
      if (owner.id === undefined) throw new Error('bot is not paired yet')
      const sent = await bot.api.sendMessage(owner.id, text, {
        reply_markup: {
          inline_keyboard: options.map((label, index) => [
            { text: label, callback_data: formatCallbackData(id, index) },
          ]),
        },
      })
      return { chatId: sent.chat.id, messageId: sent.message_id }
    },
    async finalize(reference, text) {
      await bot.api.editMessageText(reference.chatId, reference.messageId, text, {
        reply_markup: { inline_keyboard: [] },
      })
    },
  }
}

export function registerTapHandler(bot: Bot, owner: Owner, tap: Tap): void {
  bot.on('callback_query:data', async (context) => {
    const route = routeTap(context.from.id, context.callbackQuery.data, owner.id, tap)
    if (route === 'expired') await context.answerCallbackQuery({ text: 'Expired' })
    else await context.answerCallbackQuery()
  })
}

export function handlePairingMessage(
  message: PairingMessage,
  pairing: Pairing,
  onPaired: (id: number) => void,
): string | undefined {
  if (message.chatType !== 'private') return undefined
  const result = pairing.attempt(message.fromId, message.text)
  if (result === 'paired') {
    onPaired(message.fromId)
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
  bot.on('message:text', async (context) => {
    const reply = handlePairingMessage(
      { fromId: context.from.id, chatType: context.chat.type, text: context.message.text },
      pairing,
      onPaired,
    )
    if (reply !== undefined) await context.reply(reply)
  })
}

export function createOnPaired(
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
