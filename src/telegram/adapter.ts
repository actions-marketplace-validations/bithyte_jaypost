import type { Bot } from 'grammy'
import type { MessageReference, Messenger } from '../approval/index.ts'
import type { Notifier } from '../notify/index.ts'
import type { Pairing } from '../pairing/index.ts'
import {
  CALLBACK_DATA_PATTERN,
  DISMISS_DATA_PATTERN,
  DISMISS_LABEL,
  START_COMMAND_PATTERN,
} from './constants.ts'
import type { Dismiss, Owner, PairingMessage, Tap, TapRoute } from './types.ts'

/** Button payload `<id>:<optionIndex>`; `routeTap` parses it. */
export function formatCallbackData(id: string, optionIndex: number): string {
  return `${id}:${optionIndex}`
}

/** Dismiss button payload `dismiss/<id>`; `parseDismissData` reads it back. */
export function formatDismissData(id: string): string {
  return `dismiss/${id}`
}

/** The notification id in a dismiss payload, or undefined for anything else. */
export function parseDismissData(data: string | undefined): string | undefined {
  return data === undefined ? undefined : DISMISS_DATA_PATTERN.exec(data)?.[1]
}

/**
 * 'ignored' for anyone but the owner, 'expired' for malformed data, else whatever `tap` returns.
 */
export function routeTap(
  fromId: number,
  data: string | undefined,
  ownerId: number | undefined,
  tap: Tap,
): TapRoute {
  if (ownerId === undefined || fromId !== ownerId) {
    return 'ignored'
  }
  const [, id, rawIndex] = (data === undefined ? null : CALLBACK_DATA_PATTERN.exec(data)) ?? []
  if (id === undefined || rawIndex === undefined) {
    return 'expired'
  }
  return tap(id, Number(rawIndex))
}

/**
 * Sends requests as inline-keyboard messages to the owner; the final edit removes the buttons.
 * Notifications get a single Dismiss button. Sending throws when nobody is paired.
 */
export function createTelegramMessenger(bot: Bot, owner: Owner): Messenger & Required<Notifier> {
  return {
    async sendRequest(id, text, options): Promise<MessageReference> {
      if (owner.id === undefined) {
        throw new Error('bot is not paired yet')
      }
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
    async sendNotification(id, text): Promise<MessageReference> {
      if (owner.id === undefined) {
        throw new Error('bot is not paired yet')
      }
      const sent = await bot.api.sendMessage(owner.id, text, {
        reply_markup: {
          inline_keyboard: [[{ text: DISMISS_LABEL, callback_data: formatDismissData(id) }]],
        },
      })
      return { chatId: sent.chat.id, messageId: sent.message_id }
    },
    async deleteMessage(reference) {
      await bot.api.deleteMessage(reference.chatId, reference.messageId)
    },
  }
}

/**
 * Routes approval taps to `tap`. An owner's Dismiss tap deletes the tapped message (so it works
 * without in-memory state, e.g. after a restart) and calls `dismiss`; a failed delete is logged.
 * Always answers the callback so the button stops spinning.
 */
export function registerTapHandler(
  bot: Bot,
  owner: Owner,
  tap: Tap,
  dismiss: Dismiss,
  log: (line: string) => void = console.error,
): void {
  bot.on('callback_query:data', async (context) => {
    const dismissId = parseDismissData(context.callbackQuery.data)
    if (dismissId !== undefined) {
      if (owner.id !== undefined && context.from.id === owner.id) {
        dismiss(dismissId)
        try {
          await context.deleteMessage()
        } catch (error) {
          log(
            `failed to delete notification: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      await context.answerCallbackQuery()
      return
    }
    const route = routeTap(context.from.id, context.callbackQuery.data, owner.id, tap)
    if (route === 'expired') {
      await context.answerCallbackQuery({ text: 'Expired' })
    } else {
      await context.answerCallbackQuery()
    }
  })
}

/**
 * Reply text for a pairing attempt, or undefined to stay silent (not a private chat, blocked, or
 * already paired). Calls `onPaired` on success.
 */
export function handlePairingMessage(
  message: PairingMessage,
  pairing: Pairing,
  onPaired: (id: number) => void,
): string | undefined {
  if (message.chatType !== 'private') {
    return undefined
  }
  const result = pairing.attempt(
    String(message.fromId),
    message.text.trim().replace(START_COMMAND_PATTERN, ''),
  )
  if (result === 'paired') {
    onPaired(message.fromId)
    return 'Paired. Approval requests will appear here.'
  }
  if (result === 'wrong') {
    return "This bot isn't paired. Check the service logs for the pairing code."
  }
  return undefined
}

/** Feeds text messages to `handlePairingMessage` and sends any reply. */
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
    if (reply !== undefined) {
      await context.reply(reply)
    }
  })
}

/**
 * Callback that sets the owner in memory first, then calls `save` (which writes `path`). A failed save is
 * logged, not thrown.
 */
export function createOnPaired(
  owner: Owner,
  save: (id: number) => void,
  path: string,
  log: (line: string) => void = console.error,
): (id: number) => void {
  return (id) => {
    owner.id = id
    try {
      save(id)
    } catch {
      log(`paired with ${id} but couldn't save the owner to ${path}; it'll be lost on restart`)
    }
  }
}
