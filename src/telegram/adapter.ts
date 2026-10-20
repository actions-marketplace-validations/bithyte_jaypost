import { GrammyError } from 'grammy'
import type { Bot } from 'grammy'
import type { MessageReference, Messenger, OwnerCommand } from '../approval/index.ts'
import type { Notifier } from '../notify/index.ts'
import { formatCode } from '../pairing/index.ts'
import type { PairResult } from '../pairing/index.ts'
import {
  AMBIGUOUS_REPLY,
  BUTTONS_ONLY_REPLY,
  CALLBACK_DATA_PATTERN,
  DISMISS_DATA_PATTERN,
  DISMISS_LABEL,
  NOT_OPEN_REPLY,
  NOT_TEXT_REPLY,
  START_COMMAND_PATTERN,
  TEXT_HINT_WITHOUT_BUTTONS,
  TEXT_HINT_WITH_BUTTONS,
} from './constants.ts'
import type {
  CommandMessage,
  Dismiss,
  IncomingMessage,
  OpenQuestion,
  OpenQuestions,
  Owner,
  PairingMessage,
  Reply,
  ReplyRoute,
  Tap,
  TapRoute,
  TelegramMessageReference,
} from './types.ts'

/** How to pair: `code` is raw (no dash), `bot` the username without `@`. */
export function formatPairingInstructions(code: string, bot: string): string {
  return `Send "/start ${formatCode(code)}" to @${bot}, or open https://t.me/${bot}?start=${code}`
}

/** `formatPairingInstructions` for the dashed code an old /status body carries. */
export function formatLegacyInstructions(displayCode: string, bot: string): string {
  return formatPairingInstructions(displayCode.replaceAll('-', ''), bot)
}

/** Key of an open question in `OpenQuestions`: `<chatId>:<messageId>`. */
export function formatMessageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`
}

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
 * Decides what an incoming message means: a reply to an open text question settles it, a non-reply
 * settles the only open text question, anything else is ignored or reported. Never throws; calls
 * `reply` at most once. The answer is trimmed; the `/` check on non-replies uses the raw text.
 */
export function routeReply(
  message: IncomingMessage,
  ownerId: number | undefined,
  botId: number,
  openQuestions: ReadonlyMap<string, OpenQuestion>,
  reply: Reply,
): ReplyRoute {
  if (!isOwnerCommand(message, ownerId)) {
    return 'ignored'
  }
  const { replyTo, text } = message
  if (replyTo !== undefined) {
    const question = openQuestions.get(formatMessageKey(message.chatId, replyTo.messageId))
    if (question !== undefined) {
      if (text === undefined) {
        return question.allowText ? 'notText' : 'ignored'
      }
      return question.allowText ? reply(question.id, text.trim()) : 'buttonsOnly'
    }
    if (replyTo.fromId === botId) {
      return text === undefined ? 'ignored' : 'notOpen'
    }
  }
  if (text === undefined || text.startsWith('/')) {
    return 'ignored'
  }
  const textQuestions = [...openQuestions.values()].filter((question) => question.allowText)
  const [only, second] = textQuestions
  if (only === undefined) {
    return 'ignored'
  }
  if (second !== undefined) {
    return 'ambiguous'
  }
  return reply(only.id, text.trim()) === 'accepted' ? 'accepted' : 'ignored'
}

/**
 * Sends requests as inline-keyboard messages to the owner; the final edit removes the buttons.
 * A request without options has no keyboard, and `allowText` appends a hint on how to reply.
 * Each sent request is added to `openQuestions` and removed again by `finalize`, even when the
 * final edit fails. Notifications get a single Dismiss button. Sending throws when nobody is
 * paired.
 */
export function createTelegramMessenger(
  bot: Bot,
  owner: Owner,
  openQuestions: OpenQuestions = new Map(),
): Required<Messenger> & Required<Notifier> {
  return {
    async sendRequest(id, text, options, allowText): Promise<MessageReference> {
      if (owner.id === undefined) {
        throw new Error('bot is not paired yet')
      }
      const hasButtons = options.length > 0
      const hint = hasButtons ? TEXT_HINT_WITH_BUTTONS : TEXT_HINT_WITHOUT_BUTTONS
      const sent = await bot.api.sendMessage(owner.id, allowText ? `${text}\n\n${hint}` : text, {
        ...(hasButtons && {
          reply_markup: {
            inline_keyboard: options.map((label, index) => [
              { text: label, callback_data: formatCallbackData(id, index) },
            ]),
          },
        }),
      })
      openQuestions.set(formatMessageKey(sent.chat.id, sent.message_id), { id, allowText })
      return {
        chatId: sent.chat.id,
        messageId: sent.message_id,
        hasButtons,
      } satisfies TelegramMessageReference
    },
    async finalize(reference, text) {
      const { chatId, messageId, hasButtons } = reference as TelegramMessageReference
      openQuestions.delete(formatMessageKey(chatId, messageId))
      await bot.api.editMessageText(
        chatId,
        messageId,
        text,
        hasButtons === false ? {} : { reply_markup: { inline_keyboard: [] } },
      )
    },
    async sendNotification(id, text, options): Promise<MessageReference> {
      if (owner.id === undefined) {
        throw new Error('bot is not paired yet')
      }
      const sent = await bot.api.sendMessage(owner.id, text, {
        disable_notification: options.silent,
        reply_markup: {
          inline_keyboard: [[{ text: DISMISS_LABEL, callback_data: formatDismissData(id) }]],
        },
      })
      return { chatId: sent.chat.id, messageId: sent.message_id } satisfies TelegramMessageReference
    },
    async deleteMessage(reference) {
      const { chatId, messageId } = reference as TelegramMessageReference
      await bot.api.deleteMessage(chatId, messageId)
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

function describeReplyRoute(route: ReplyRoute): string | undefined {
  switch (route) {
    case 'ignored':
    case 'accepted':
      return undefined
    case 'buttonsOnly':
      return BUTTONS_ONLY_REPLY
    case 'notOpen':
    case 'expired':
      return NOT_OPEN_REPLY
    case 'ambiguous':
      return AMBIGUOUS_REPLY
    case 'notText':
      return NOT_TEXT_REPLY
  }
}

/**
 * Routes the owner's messages to `reply` via `routeReply`: an accepted answer is silent, a
 * refused one gets a short bot reply (logged if sending fails), and everything ignored goes on to
 * the next handler. Register after `registerCommandHandler` (registered commands never become
 * answers) and before `registerPairingHandler` (it passes on everything it ignores).
 */
export function registerReplyHandler(
  bot: Bot,
  owner: Owner,
  openQuestions: OpenQuestions,
  reply: Reply,
  log: (line: string) => void = console.error,
): void {
  bot.on('message', async (context, next) => {
    const replyTo = context.message.reply_to_message
    const route = routeReply(
      {
        fromId: context.from?.id,
        chatType: context.chat.type,
        chatId: context.chat.id,
        text: context.message.text,
        replyTo:
          replyTo === undefined
            ? undefined
            : { messageId: replyTo.message_id, fromId: replyTo.from?.id },
      },
      owner.id,
      bot.botInfo.id,
      openQuestions,
      reply,
    )
    if (route === 'ignored') {
      await next()
      return
    }
    const copy = describeReplyRoute(route)
    if (copy === undefined) {
      return
    }
    try {
      await context.reply(copy, { reply_parameters: { message_id: context.message.message_id } })
    } catch (error) {
      log(`failed to reply: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/**
 * Reply text for a pairing attempt, or undefined to stay silent (not a private chat, blocked, or
 * already paired). Calls `onPaired` on success.
 */
export function handlePairingMessage(
  message: PairingMessage,
  pair: (senderId: string, text: string) => PairResult,
  onPaired: (id: number) => void,
): string | undefined {
  if (message.chatType !== 'private') {
    return undefined
  }
  const result = pair(
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
  pair: (senderId: string, text: string) => PairResult,
  onPaired: (id: number) => void,
): void {
  bot.on('message:text', async (context) => {
    const reply = handlePairingMessage(
      { fromId: context.from.id, chatType: context.chat.type, text: context.message.text },
      pair,
      onPaired,
    )
    if (reply !== undefined) {
      await context.reply(reply)
    }
  })
}

/** True only for the paired owner writing in a private chat; channel posts have no sender. */
export function isOwnerCommand(message: CommandMessage, ownerId: number | undefined): boolean {
  return message.chatType === 'private' && ownerId !== undefined && message.fromId === ownerId
}

/**
 * Registers one handler per command. Replies with `command`'s text when it returns one; anyone but
 * the owner in a private chat is ignored, and the update goes no further (so a stranger's command
 * never reaches the pairing handler).
 */
export function registerCommandHandler(
  bot: Bot,
  owner: Owner,
  commands: readonly OwnerCommand[],
  command: (name: string, argument: string) => string | undefined,
): void {
  for (const { name } of commands) {
    bot.command(name, async (context) => {
      if (!isOwnerCommand({ fromId: context.from?.id, chatType: context.chat.type }, owner.id)) {
        return
      }
      const reply = command(name, context.match)
      if (reply !== undefined) {
        await context.reply(reply)
      }
    })
  }
}

/**
 * Shows `commands` in the owner's chat menu only, so lists set in BotFather stay. Fire and forget:
 * a failure is logged by error code, never by text (it can embed the token), and never thrown.
 */
export function setCommandMenu(
  bot: Bot,
  chatId: number,
  commands: readonly OwnerCommand[],
  log: (line: string) => void,
): void {
  void (async () => {
    try {
      await bot.api.setMyCommands(
        commands.map(({ name, description }) => ({ command: name, description })),
        { scope: { type: 'chat', chat_id: chatId } },
      )
    } catch (error) {
      log(
        error instanceof GrammyError
          ? `failed to set bot commands (${error.error_code})`
          : 'failed to set bot commands',
      )
    }
  })()
}
