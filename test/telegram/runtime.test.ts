import { GrammyError } from 'grammy'
import type { Bot } from 'grammy'
import { expect, test, vi } from 'vite-plus/test'
import { createTelegramRuntime } from '../../src/telegram/index.ts'

const TOKEN = '123:secret-token'

function fakeBot(init: () => Promise<void> = async () => {}) {
  let rejectPolling: (error: unknown) => void = () => {}
  const polling = new Promise<void>((_resolve, reject) => {
    rejectPolling = reject
  })
  const on = vi.fn()
  const start = vi.fn((options: { onStart: (botUser: { username: string }) => void }) => {
    options.onStart({ username: 'mybot' })
    return polling
  })
  const stop = vi.fn(async () => {})
  const bot = { botInfo: { username: 'mybot' }, init, on, catch: vi.fn(), start, stop, api: {} }
  return { bot: bot as unknown as Bot, on, start, stop, rejectPolling }
}

function handlers(fatal = vi.fn()) {
  return { answer: () => 'accepted' as const, dismiss: () => true, fatal }
}

test('checkCredentials reports @username', async () => {
  const { bot } = fakeBot()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  expect(await runtime.checkCredentials()).toEqual({ ok: true, displayName: '@mybot' })
})

test('rejected token reason has the code and no token', async () => {
  const { bot } = fakeBot(async () => {
    throw new GrammyError(
      `Call to 'getMe' failed! https://api.telegram.org/bot${TOKEN}/getMe`,
      { ok: false, error_code: 401, description: 'Unauthorized' },
      'getMe',
      {},
    )
  })
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  const check = await runtime.checkCredentials()
  expect(check).toEqual({
    ok: false,
    reason: 'Telegram rejected the bot token (401); check it with `telegram-ask init`',
  })
  expect(JSON.stringify(check)).not.toContain(TOKEN)
})

test('unreachable reason', async () => {
  const { bot } = fakeBot(async () => {
    throw new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/getMe`)
  })
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  expect(await runtime.checkCredentials()).toEqual({
    ok: false,
    reason: 'could not reach Telegram to verify the bot token',
  })
})

test('pairingInstructions text is unchanged', async () => {
  const { bot } = fakeBot()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  await runtime.checkCredentials()
  expect(runtime.pairingInstructions?.('K7QM4XPD')).toBe(
    'Send "/start K7QM-4XPD" to @mybot, or open https://t.me/mybot?start=K7QM4XPD',
  )
  expect(runtime.statusFields?.()).toEqual({ bot: 'mybot' })
})

test('start logs polling and registers handlers', () => {
  const { bot, on } = fakeBot()
  const log = vi.fn()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, log, () => bot)
  runtime.start({ ...handlers(), pair: () => 'wrong' })
  expect(log).toHaveBeenCalledWith('bot @mybot polling')
  expect(on.mock.calls.map((call) => call[0])).toEqual(['callback_query:data', 'message:text'])
})

test('409 calls fatal with the old message', async () => {
  const { bot, rejectPolling } = fakeBot()
  const fatal = vi.fn()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start(handlers(fatal))
  rejectPolling(
    new GrammyError(
      'conflict',
      { ok: false, error_code: 409, description: 'Conflict' },
      'getUpdates',
      {},
    ),
  )
  await vi.waitFor(() =>
    expect(fatal).toHaveBeenCalledWith(
      'another instance is already polling with this bot token; exiting',
    ),
  )
})

test('other polling errors call fatal with bot stopped', async () => {
  const { bot, rejectPolling } = fakeBot()
  const fatal = vi.fn()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start(handlers(fatal))
  rejectPolling(new Error('boom'))
  await vi.waitFor(() => expect(fatal).toHaveBeenCalledWith('bot stopped: boom'))
})

test('polling ending after stop is not fatal', async () => {
  const { bot, stop, rejectPolling } = fakeBot()
  const fatal = vi.fn()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start(handlers(fatal))
  await runtime.stop()
  expect(stop).toHaveBeenCalledTimes(1)
  rejectPolling(new Error('aborted'))
  await new Promise((resolve) => setImmediate(resolve))
  expect(fatal).not.toHaveBeenCalled()
})

test('stop never rejects', async () => {
  const { bot, stop } = fakeBot()
  stop.mockRejectedValueOnce(new Error('not running'))
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  await expect(runtime.stop()).resolves.toBeUndefined()
})

test('pairing handler is not registered without pair', () => {
  const { bot, on } = fakeBot()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start(handlers())
  expect(on.mock.calls.map((call) => call[0])).toEqual(['callback_query:data'])
})

test('pairing sets the owner so requests go to them', async () => {
  const { bot, on } = fakeBot()
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 9 } }))
  ;(bot as unknown as { api: object }).api = { sendMessage }
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start({ ...handlers(), pair: () => 'paired' })
  await expect(runtime.sendRequest('id1', 'Q', ['Yes'])).rejects.toThrow()
  const pairingHandler = on.mock.calls.find((call) => call[0] === 'message:text')?.[1] as (
    context: unknown,
  ) => Promise<void>
  await pairingHandler({
    from: { id: 9 },
    chat: { type: 'private' },
    message: { text: 'K7QM4XPD' },
    reply: vi.fn(async () => {}),
  })
  expect(await runtime.sendRequest('id1', 'Q', ['Yes'])).toEqual({ chatId: 9, messageId: 5 })
})
