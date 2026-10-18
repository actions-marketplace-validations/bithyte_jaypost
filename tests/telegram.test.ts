import { expect, test, vi } from 'vite-plus/test'
import type { Bot } from 'grammy'
import {
  callbackData,
  createTelegramMessenger,
  registerTapHandler,
  routeTap,
} from '../src/telegram.ts'

test('callbackData format', () => expect(callbackData('abc', 1)).toBe('abc:1'))

test('callbackData fits 64 bytes with a UUID', () => {
  const data = callbackData(crypto.randomUUID(), 9)
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
  const ref = await createTelegramMessenger(bot, 42).sendRequest('id1', 'Deploy?', ['Yes', 'No'])
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
  await createTelegramMessenger(bot, 42).finalize({ chatId: 42, messageId: 5 }, 'done')
  expect(editMessageText).toHaveBeenCalledWith(42, 5, 'done', {
    reply_markup: { inline_keyboard: [] },
  })
})

function fakeBot() {
  let handler: (ctx: unknown) => Promise<void> = async () => {}
  const on = vi.fn((_filter: string, h: typeof handler) => {
    handler = h
  })
  const run = (fromId: number, data: string | undefined) => {
    const answerCallbackQuery = vi.fn(async () => true)
    const p = handler({ from: { id: fromId }, callbackQuery: { data }, answerCallbackQuery })
    return { answerCallbackQuery, p }
  }
  return { bot: { on } as unknown as Bot, on, run }
}

test('handler: owner accepted answers silently', async () => {
  const { bot, on, run } = fakeBot()
  registerTapHandler(bot, 42, () => 'accepted')
  expect(on).toHaveBeenCalledWith('callback_query:data', expect.any(Function))
  const { answerCallbackQuery, p } = run(42, 'abc:0')
  await p
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: expired shows Expired', async () => {
  const { bot, run } = fakeBot()
  registerTapHandler(bot, 42, () => 'expired')
  const { answerCallbackQuery, p } = run(42, 'abc:0')
  await p
  expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'Expired' })
})

test('handler: non-owner ignored, tap not called, no text', async () => {
  const { bot, run } = fakeBot()
  const tap = vi.fn()
  registerTapHandler(bot, 42, tap)
  const { answerCallbackQuery, p } = run(7, 'abc:0')
  await p
  expect(tap).not.toHaveBeenCalled()
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})
