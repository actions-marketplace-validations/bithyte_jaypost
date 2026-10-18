import { expect, test, vi } from 'vite-plus/test'
import type { Bot } from 'grammy'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  callbackData,
  createTelegramMessenger,
  handlePairingMessage,
  makeOnPaired,
  registerPairingHandler,
  registerTapHandler,
  routeTap,
} from '../src/telegram.ts'
import type { Owner } from '../src/telegram.ts'
import { Pairing } from '../src/pairing.ts'

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
  await createTelegramMessenger(bot, { id: 42 }).finalize({ chatId: 42, messageId: 5 }, 'done')
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
  registerTapHandler(bot, { id: 42 }, () => 'accepted')
  expect(on).toHaveBeenCalledWith('callback_query:data', expect.any(Function))
  const { answerCallbackQuery, p } = run(42, 'abc:0')
  await p
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: expired shows Expired', async () => {
  const { bot, run } = fakeBot()
  registerTapHandler(bot, { id: 42 }, () => 'expired')
  const { answerCallbackQuery, p } = run(42, 'abc:0')
  await p
  expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'Expired' })
})

test('handler: non-owner ignored, tap not called, no text', async () => {
  const { bot, run } = fakeBot()
  const tap = vi.fn()
  registerTapHandler(bot, { id: 42 }, tap)
  const { answerCallbackQuery, p } = run(7, 'abc:0')
  await p
  expect(tap).not.toHaveBeenCalled()
  expect(answerCallbackQuery).toHaveBeenCalledWith()
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
    new Pairing('K7QM4XPD'),
    onPaired,
  )
  expect(reply).toBe('Paired. Approval requests will appear here.')
  expect(onPaired).toHaveBeenCalledWith(9)
})

test('pairing: wrong code gets the hint, onPaired not called', () => {
  const onPaired = vi.fn()
  const reply = handlePairingMessage(
    { fromId: 9, chatType: 'private', text: 'nope' },
    new Pairing('K7QM4XPD'),
    onPaired,
  )
  expect(reply).toBe("This bot isn't paired. Check the service logs for the pairing code.")
  expect(onPaired).not.toHaveBeenCalled()
})

test('pairing: group chat ignored', () => {
  const p = new Pairing('K7QM4XPD')
  expect(
    handlePairingMessage({ fromId: 9, chatType: 'group', text: 'K7QM4XPD' }, p, vi.fn()),
  ).toBeUndefined()
  expect(p.paired).toBe(false)
})

test('pairing: blocked sender gets no reply', () => {
  const p = new Pairing('K7QM4XPD', 1)
  const msg = { fromId: 9, chatType: 'private', text: 'bad' }
  handlePairingMessage(msg, p, vi.fn())
  expect(handlePairingMessage(msg, p, vi.fn())).toBeUndefined()
})

test('after pairing, strangers and old codes get no reply', () => {
  const p = new Pairing('K7QM4XPD')
  p.attempt(1, 'K7QM4XPD')
  const onPaired = vi.fn()
  expect(
    handlePairingMessage({ fromId: 2, chatType: 'private', text: '/start' }, p, onPaired),
  ).toBeUndefined()
  expect(
    handlePairingMessage({ fromId: 2, chatType: 'private', text: 'K7QM4XPD' }, p, onPaired),
  ).toBeUndefined()
  expect(onPaired).not.toHaveBeenCalled()
})

test('pairing handler replies via ctx.reply and stays silent when ignored', async () => {
  let handler: (ctx: unknown) => Promise<void> = async () => {}
  const on = vi.fn((_f: string, h: typeof handler) => {
    handler = h
  })
  registerPairingHandler({ on } as unknown as Bot, new Pairing('K7QM4XPD'), vi.fn())
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

test('onPaired sets owner and writes config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-'))
  const path = join(dir, 'config.json')
  const owner: Owner = { id: undefined }
  const log = vi.fn()
  makeOnPaired(owner, path, log)(42)
  expect(owner.id).toBe(42)
  expect(JSON.parse(readFileSync(path, 'utf8')).ownerId).toBe(42)
  expect(log).not.toHaveBeenCalled()
})

test('onPaired keeps owner in memory when the file is unwritable', () => {
  // a regular file as the parent dir makes the write fail with ENOTDIR
  const dir = mkdtempSync(join(tmpdir(), 'tab-'))
  const blocker = join(dir, 'file')
  writeFileSync(blocker, '')
  const owner: Owner = { id: undefined }
  const log = vi.fn()
  expect(() => makeOnPaired(owner, join(blocker, 'config.json'), log)(42)).not.toThrow()
  expect(owner.id).toBe(42)
  expect(log).toHaveBeenCalledTimes(1)
  expect(log.mock.calls[0]?.[0]).toMatch(/couldn't save/)
})
