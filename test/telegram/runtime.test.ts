import { GrammyError } from 'grammy'
import type { Bot } from 'grammy'
import { expect, test, vi } from 'vite-plus/test'
import { OWNER_COMMANDS } from '../../src/approval/index.ts'
import { createTelegramRuntime } from '../../src/telegram/index.ts'

const TOKEN = '123:secret-token'

function fakeBot(init: () => Promise<void> = async () => {}) {
  let rejectPolling: (error: unknown) => void = () => {}
  const polling = new Promise<void>((_resolve, reject) => {
    rejectPolling = reject
  })
  const registrations: string[] = []
  const on = vi.fn((filter: string) => {
    registrations.push(`on:${filter}`)
  })
  const command = vi.fn((name: string) => {
    registrations.push(`command:${name}`)
  })
  const setMyCommands = vi.fn(async () => true)
  const start = vi.fn((options: { onStart: (botUser: { username: string }) => void }) => {
    options.onStart({ username: 'mybot' })
    return polling
  })
  const stop = vi.fn(async () => {})
  const bot = {
    botInfo: { username: 'mybot' },
    init,
    on,
    catch: vi.fn(),
    command,
    start,
    stop,
    api: { setMyCommands },
  }
  return {
    bot: bot as unknown as Bot,
    on,
    registrations,
    setMyCommands,
    start,
    stop,
    rejectPolling,
  }
}

function handlers(fatal = vi.fn()) {
  return {
    answer: () => 'accepted' as const,
    dismiss: () => true,
    commands: OWNER_COMMANDS,
    command: () => undefined,
    fatal,
  }
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

test('start logs polling and registers taps, then commands, then pairing', () => {
  const { bot, registrations } = fakeBot()
  const log = vi.fn()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, log, () => bot)
  runtime.start({ ...handlers(), pair: () => 'wrong' })
  expect(log).toHaveBeenCalledWith('bot @mybot polling')
  expect(registrations).toEqual([
    'on:callback_query:data',
    'command:pending',
    'command:cancel',
    'command:history',
    'on:message:text',
  ])
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
  const { bot, registrations } = fakeBot()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start(handlers())
  expect(registrations).not.toContain('on:message:text')
})

test('pairing sets the owner so requests go to them', async () => {
  const { bot, on } = fakeBot()
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 9 } }))
  ;(bot as unknown as { api: object }).api = { sendMessage, setMyCommands: vi.fn(async () => true) }
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

test('setMyCommands uses the owner chat scope when an owner is known', () => {
  const { bot, setMyCommands } = fakeBot()
  const runtime = createTelegramRuntime({ botToken: TOKEN, ownerId: 9 }, vi.fn(), () => bot)
  runtime.start(handlers())
  expect(setMyCommands).toHaveBeenCalledTimes(1)
  expect(setMyCommands.mock.calls[0]?.[1]).toEqual({ scope: { type: 'chat', chat_id: 9 } })
})

test('setMyCommands is not called while unpaired', () => {
  const { bot, setMyCommands } = fakeBot()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start(handlers())
  expect(setMyCommands).not.toHaveBeenCalled()
})

async function runPairing(setMyCommands: ReturnType<typeof vi.fn>, log = vi.fn()) {
  const { bot, on } = fakeBot()
  ;(bot as unknown as { api: object }).api = { setMyCommands }
  const runtime = createTelegramRuntime({ botToken: TOKEN }, log, () => bot)
  runtime.start({ ...handlers(), pair: () => 'paired' })
  const pairingHandler = on.mock.calls.find((call) => call[0] === 'message:text')?.[1] as (
    context: unknown,
  ) => Promise<void>
  const reply = vi.fn(async () => {})
  await pairingHandler({
    from: { id: 9 },
    chat: { type: 'private' },
    message: { text: 'K7QM4XPD' },
    reply,
  })
  return { reply, log }
}

test('pairing sets the command menu for the new owner', async () => {
  const setMyCommands = vi.fn(async () => true)
  await runPairing(setMyCommands)
  expect(setMyCommands).toHaveBeenCalledTimes(1)
  expect(setMyCommands.mock.calls[0]?.[1]).toEqual({ scope: { type: 'chat', chat_id: 9 } })
})

test('pairing still replies when setMyCommands rejects or throws', async () => {
  const rejecting = await runPairing(vi.fn(async () => Promise.reject(new Error(TOKEN))))
  expect(rejecting.reply).toHaveBeenCalledWith('Paired. Approval requests will appear here.')
  await vi.waitFor(() => expect(rejecting.log).toHaveBeenCalledWith('failed to set bot commands'))
  const throwing = await runPairing(
    vi.fn(() => {
      throw new Error(TOKEN)
    }),
  )
  expect(throwing.reply).toHaveBeenCalledWith('Paired. Approval requests will appear here.')
  expect(throwing.log.mock.calls.flat().join('')).not.toContain(TOKEN)
})
