import { expect, test, vi } from 'vite-plus/test'
import type { Bot } from 'grammy'
import {
  formatCallbackData,
  formatDismissData,
  parseDismissData,
  createTelegramMessenger,
  handlePairingMessage,
  registerPairingHandler,
  registerTapHandler,
  routeTap,
  formatPairingInstructions,
  formatLegacyInstructions,
} from '../../src/telegram/index.ts'
import type { Owner } from '../../src/telegram/index.ts'
import { Pairing } from '../../src/pairing/index.ts'

const attempt = (pairing: Pairing) => (senderId: string, text: string) =>
  pairing.attempt(senderId, text)

test('formatCallbackData format', () => expect(formatCallbackData('abc', 1)).toBe('abc:1'))

test('formatCallbackData fits 64 bytes with a UUID', () => {
  const data = formatCallbackData(crypto.randomUUID(), 9)
  expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
})

test('non-owner tap ignored, tap not called', () => {
  const tap = vi.fn()
  expect(routeTap(7, 'abc:0', 42, tap)).toBe('ignored')
  expect(tap).not.toHaveBeenCalled()
})

test('owner tap routed', () => {
  const tap = vi.fn(() => 'accepted' as const)
  expect(routeTap(42, 'abc:1', 42, tap)).toBe('accepted')
  expect(tap).toHaveBeenCalledWith('abc', 1)
})

test('owner tap on expired request', () => {
  expect(routeTap(42, 'abc:1', 42, () => 'expired')).toBe('expired')
})

test.each([undefined, '', 'abc', 'abc:', 'abc:x', ':1', 'abc:1:2', 'abc:-1'])(
  'malformed data %s is expired',
  (d) => {
    const tap = vi.fn()
    expect(routeTap(42, d, 42, tap)).toBe('expired')
    expect(tap).not.toHaveBeenCalled()
  },
)

test('sendRequest sends plain text with one button per row', async () => {
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 42 } }))
  const bot = { api: { sendMessage } } as unknown as Bot
  const ref = await createTelegramMessenger(bot, { id: 42 }).sendRequest('id1', 'Deploy?', [
    'Yes',
    'No',
  ])
  expect(ref).toEqual({ chatId: 42, messageId: 5 })
  expect(sendMessage).toHaveBeenCalledWith(42, 'Deploy?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Yes', callback_data: 'id1:0' }],
        [{ text: 'No', callback_data: 'id1:1' }],
      ],
    },
  })
})

test('finalize edits text and clears keyboard', async () => {
  const editMessageText = vi.fn(async () => true)
  const bot = { api: { editMessageText } } as unknown as Bot
  await createTelegramMessenger(bot, { id: 42 }).finalize({ chatId: 42, messageId: 5 }, 'done', {
    kind: 'cancelled',
  })
  expect(editMessageText).toHaveBeenCalledWith(42, 5, 'done', {
    reply_markup: { inline_keyboard: [] },
  })
})

function fakeBot() {
  let handler: (ctx: unknown) => Promise<void> = async () => {}
  const on = vi.fn((_filter: string, h: typeof handler) => {
    handler = h
  })
  const run = (
    fromId: number,
    data: string | undefined,
    deleteMessage = vi.fn(async () => true),
  ) => {
    const answerCallbackQuery = vi.fn(async () => true)
    const p = handler({
      from: { id: fromId },
      callbackQuery: { data },
      answerCallbackQuery,
      deleteMessage,
    })
    return { answerCallbackQuery, deleteMessage, p }
  }
  return { bot: { on } as unknown as Bot, on, run }
}

test('handler: owner accepted answers silently', async () => {
  const { bot, on, run } = fakeBot()
  registerTapHandler(bot, { id: 42 }, () => 'accepted', vi.fn())
  expect(on).toHaveBeenCalledWith('callback_query:data', expect.any(Function))
  const { answerCallbackQuery, p } = run(42, 'abc:0')
  await p
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: expired shows Expired', async () => {
  const { bot, run } = fakeBot()
  registerTapHandler(bot, { id: 42 }, () => 'expired', vi.fn())
  const { answerCallbackQuery, p } = run(42, 'abc:0')
  await p
  expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'Expired' })
})

test('handler: non-owner ignored, tap not called, no text', async () => {
  const { bot, run } = fakeBot()
  const tap = vi.fn()
  registerTapHandler(bot, { id: 42 }, tap, vi.fn())
  const { answerCallbackQuery, p } = run(7, 'abc:0')
  await p
  expect(tap).not.toHaveBeenCalled()
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: owner dismiss deletes the message and calls dismiss', async () => {
  const { bot, run } = fakeBot()
  const tap = vi.fn()
  const dismiss = vi.fn(() => true)
  registerTapHandler(bot, { id: 42 }, tap, dismiss)
  const { answerCallbackQuery, deleteMessage, p } = run(42, 'dismiss/id1')
  await p
  expect(dismiss).toHaveBeenCalledWith('id1')
  expect(deleteMessage).toHaveBeenCalledTimes(1)
  expect(answerCallbackQuery).toHaveBeenCalledWith()
  expect(tap).not.toHaveBeenCalled()
})

test('handler: dismiss for unknown id still deletes the message', async () => {
  const { bot, run } = fakeBot()
  registerTapHandler(bot, { id: 42 }, vi.fn(), () => false)
  const { answerCallbackQuery, deleteMessage, p } = run(42, 'dismiss/gone')
  await p
  expect(deleteMessage).toHaveBeenCalledTimes(1)
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: failed dismiss delete is logged and the tap answered', async () => {
  const { bot, run } = fakeBot()
  const log = vi.fn()
  registerTapHandler(bot, { id: 42 }, vi.fn(), () => true, log)
  const deleteMessage = vi.fn(async () => {
    throw new Error('message to delete not found')
  })
  const { answerCallbackQuery, p } = run(42, 'dismiss/id1', deleteMessage)
  await expect(p).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledWith('failed to delete notification: message to delete not found')
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: non-owner dismiss is ignored', async () => {
  const { bot, run } = fakeBot()
  const dismiss = vi.fn()
  registerTapHandler(bot, { id: 42 }, vi.fn(), dismiss)
  const { answerCallbackQuery, deleteMessage, p } = run(7, 'dismiss/id1')
  await p
  expect(dismiss).not.toHaveBeenCalled()
  expect(deleteMessage).not.toHaveBeenCalled()
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('formatDismissData format', () => expect(formatDismissData('abc')).toBe('dismiss/abc'))

test('formatDismissData fits 64 bytes with a UUID', () => {
  expect(Buffer.byteLength(formatDismissData(crypto.randomUUID()))).toBeLessThanOrEqual(64)
})

test("dismiss and approval payloads don't overlap", () => {
  expect(parseDismissData(formatDismissData('abc'))).toBe('abc')
  expect(parseDismissData('abc:0')).toBeUndefined()
  expect(parseDismissData('dismiss/abc:0')).toBeUndefined()
  const tap = vi.fn()
  expect(routeTap(42, formatDismissData('abc'), 42, tap)).toBe('expired')
  expect(tap).not.toHaveBeenCalled()
})

test('sendNotification sends text with one Dismiss button', async () => {
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 42 } }))
  const bot = { api: { sendMessage } } as unknown as Bot
  const ref = await createTelegramMessenger(bot, { id: 42 }).sendNotification('id1', 'hi')
  expect(ref).toEqual({ chatId: 42, messageId: 5 })
  expect(sendMessage).toHaveBeenCalledWith(42, 'hi', {
    reply_markup: { inline_keyboard: [[{ text: 'Dismiss', callback_data: 'dismiss/id1' }]] },
  })
})

test('sendNotification throws when unpaired', async () => {
  const sendMessage = vi.fn()
  const bot = { api: { sendMessage } } as unknown as Bot
  await expect(
    createTelegramMessenger(bot, { id: undefined }).sendNotification('id1', 'hi'),
  ).rejects.toThrow()
  expect(sendMessage).not.toHaveBeenCalled()
})

test('deleteMessage deletes by reference', async () => {
  const deleteMessage = vi.fn(async () => true)
  const bot = { api: { deleteMessage } } as unknown as Bot
  await createTelegramMessenger(bot, { id: 42 }).deleteMessage({ chatId: 42, messageId: 5 })
  expect(deleteMessage).toHaveBeenCalledWith(42, 5)
})

test('tap with no owner is ignored', () => {
  const tap = vi.fn()
  expect(routeTap(1, 'abc:0', undefined, tap)).toBe('ignored')
  expect(tap).not.toHaveBeenCalled()
})

test('messenger sends to the owner id at call time', async () => {
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 9 } }))
  const bot = { api: { sendMessage } } as unknown as Bot
  const owner: Owner = { id: undefined }
  const m = createTelegramMessenger(bot, owner)
  await expect(m.sendRequest('id1', 'Q', ['Yes'])).rejects.toThrow()
  expect(sendMessage).not.toHaveBeenCalled()
  owner.id = 9
  await m.sendRequest('id1', 'Q', ['Yes'])
  expect(sendMessage).toHaveBeenCalledWith(9, 'Q', expect.anything())
})

test('pairing: right code replies and calls onPaired', () => {
  const onPaired = vi.fn()
  const reply = handlePairingMessage(
    { fromId: 9, chatType: 'private', text: '/start K7QM-4XPD' },
    attempt(new Pairing('K7QM4XPD')),
    onPaired,
  )
  expect(reply).toBe('Paired. Approval requests will appear here.')
  expect(onPaired).toHaveBeenCalledWith(9)
})

test.each(['/start K7QM-4XPD', '/start@my_bot k7qm4xpd'])(
  'handlePairingMessage strips /start and /start@bot: %s',
  (text) => {
    const onPaired = vi.fn()
    const reply = handlePairingMessage(
      { fromId: 42, chatType: 'private', text },
      attempt(new Pairing('K7QM4XPD')),
      onPaired,
    )
    expect(reply).toBe('Paired. Approval requests will appear here.')
    expect(onPaired).toHaveBeenCalledWith(42)
  },
)

test('pairing: wrong code gets the hint, onPaired not called', () => {
  const onPaired = vi.fn()
  const reply = handlePairingMessage(
    { fromId: 9, chatType: 'private', text: 'nope' },
    attempt(new Pairing('K7QM4XPD')),
    onPaired,
  )
  expect(reply).toBe("This bot isn't paired. Check the service logs for the pairing code.")
  expect(onPaired).not.toHaveBeenCalled()
})

test('pairing: group chat ignored', () => {
  const p = new Pairing('K7QM4XPD')
  expect(
    handlePairingMessage({ fromId: 9, chatType: 'group', text: 'K7QM4XPD' }, attempt(p), vi.fn()),
  ).toBeUndefined()
  expect(p.paired).toBe(false)
})

test('pairing: blocked sender gets no reply', () => {
  const p = new Pairing('K7QM4XPD', 1)
  const msg = { fromId: 9, chatType: 'private', text: 'bad' }
  handlePairingMessage(msg, attempt(p), vi.fn())
  expect(handlePairingMessage(msg, attempt(p), vi.fn())).toBeUndefined()
})

test('after pairing, strangers and old codes get no reply', () => {
  const p = new Pairing('K7QM4XPD')
  p.attempt('1', 'K7QM4XPD')
  const onPaired = vi.fn()
  expect(
    handlePairingMessage({ fromId: 2, chatType: 'private', text: '/start' }, attempt(p), onPaired),
  ).toBeUndefined()
  expect(
    handlePairingMessage(
      { fromId: 2, chatType: 'private', text: 'K7QM4XPD' },
      attempt(p),
      onPaired,
    ),
  ).toBeUndefined()
  expect(onPaired).not.toHaveBeenCalled()
})

test('pairing handler replies via ctx.reply and stays silent when ignored', async () => {
  let handler: (ctx: unknown) => Promise<void> = async () => {}
  const on = vi.fn((_f: string, h: typeof handler) => {
    handler = h
  })
  registerPairingHandler({ on } as unknown as Bot, attempt(new Pairing('K7QM4XPD')), vi.fn())
  expect(on).toHaveBeenCalledWith('message:text', expect.any(Function))
  const reply = vi.fn(async () => {})
  await handler({
    from: { id: 9 },
    chat: { type: 'private' },
    message: { text: 'K7QM4XPD' },
    reply,
  })
  expect(reply).toHaveBeenCalledWith('Paired. Approval requests will appear here.')
  reply.mockClear()
  await handler({ from: { id: 2 }, chat: { type: 'private' }, message: { text: 'x' }, reply })
  expect(reply).not.toHaveBeenCalled()
})

test('formatPairingInstructions text', () => {
  expect(formatPairingInstructions('K7QM4XPD', 'mybot')).toBe(
    'Send "/start K7QM-4XPD" to @mybot, or open https://t.me/mybot?start=K7QM4XPD',
  )
})

test('formatLegacyInstructions takes the dashed code', () => {
  expect(formatLegacyInstructions('K7QM-4XPD', 'mybot')).toBe(
    'Send "/start K7QM-4XPD" to @mybot, or open https://t.me/mybot?start=K7QM4XPD',
  )
})
