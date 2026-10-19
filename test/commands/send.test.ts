import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test } from 'vite-plus/test'
import { ApprovalService } from '../../src/approval/index.ts'
import type { MessageReference, Messenger, Settlement } from '../../src/approval/index.ts'
import { runSendNotify, runSendRequest } from '../../src/commands/index.ts'
import type { SendDeps } from '../../src/commands/index.ts'
import { NotificationService } from '../../src/notify/index.ts'
import type { Notifier } from '../../src/notify/index.ts'
import { NO_AUTH, NO_CLIENT_TOKEN } from '../../src/auth/index.ts'
import type { ApiAuth, ClientToken } from '../../src/auth/index.ts'
import { TOKEN_REJECTED_MESSAGE } from '../../src/client/index.ts'
import { createApiServer } from '../../src/server/index.ts'

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const REFERENCE: MessageReference = { chatId: 1, messageId: 2 }

class RecordingMessenger implements Messenger {
  sent: { id: string; text: string }[] = []
  finalized: Settlement[] = []

  async sendRequest(id: string, text: string): Promise<MessageReference> {
    this.sent.push({ id, text })
    return REFERENCE
  }

  async finalize(
    _reference: MessageReference,
    _text: string,
    settlement: Settlement,
  ): Promise<void> {
    this.finalized.push(settlement)
  }
}

class RecordingNotifier implements Notifier {
  sent: string[] = []

  sendNotification = async (_id: string, text: string): Promise<MessageReference> => {
    this.sent.push(text)
    return REFERENCE
  }
}

const servers: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function startApi(
  options: { readonly notifications?: boolean; readonly auth?: ApiAuth } = {},
) {
  const messenger = new RecordingMessenger()
  const notifier = new RecordingNotifier()
  const service = new ApprovalService(messenger)
  const server = createApiServer(service, () => ({ paired: true, bot: 'b' }), {
    maxTextLength: 3900,
    providerName: 'test',
    auth: options.auth ?? NO_AUTH,
    ...(options.notifications === false
      ? {}
      : { notifications: new NotificationService(notifier) }),
  })
  servers.push(server)
  await server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = server.server.address() as AddressInfo
  return { port, service, messenger, notifier }
}

function createDeps(
  port: number,
  signal = new AbortController().signal,
  token: ClientToken = NO_CLIENT_TOKEN,
) {
  const out: string[] = []
  const errors: string[] = []
  const deps: SendDeps = {
    port,
    signal,
    token,
    print: (text) => out.push(text),
    printError: (text) => errors.push(text),
  }
  return { deps, out, errors }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met within 5 s')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const ASK = { text: 'Deploy?', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }

test('request prints the tapped answer', async () => {
  const { port, service, messenger } = await startApi()
  const { deps, out, errors } = createDeps(port)
  const pending = runSendRequest({ ...ASK, project: 'api' }, deps)
  await waitFor(() => messenger.sent.length === 1)
  const [sent] = messenger.sent
  expect(sent?.text).toBe('[api]\n\nDeploy?')
  service.tap(sent?.id ?? '', 0)
  expect(await pending).toBe(0)
  expect(out).toEqual(['Approve'])
  expect(errors).toEqual([])
})

test('request on timeout prints the timeout option', async () => {
  const { port } = await startApi()
  const { deps, out } = createDeps(port)
  expect(await runSendRequest({ ...ASK, timeout: 0.2 }, deps)).toBe(0)
  expect(out).toEqual(['Decline'])
})

test('request --json prints answer and timedOut', async () => {
  const { port } = await startApi()
  const { deps, out } = createDeps(port)
  expect(await runSendRequest({ ...ASK, timeout: 0.2, json: true }, deps)).toBe(0)
  expect(out).toEqual(['{"answer":"Decline","timedOut":true}'])
})

test('request abort cancels the telegram message', async () => {
  const { port, messenger } = await startApi()
  const controller = new AbortController()
  const { deps, errors } = createDeps(port, controller.signal)
  const pending = runSendRequest(ASK, deps)
  await waitFor(() => messenger.sent.length === 1)
  controller.abort()
  expect(await pending).toBe(1)
  expect(errors).toEqual(['telegram-ask: cancelled'])
  await waitFor(() => messenger.finalized.length === 1)
  expect(messenger.finalized).toEqual([{ kind: 'cancelled' }])
})

test('request validation error goes to stderr', async () => {
  const { port } = await startApi()
  const { deps, out, errors } = createDeps(port)
  expect(await runSendRequest({ ...ASK, timeoutOption: 'Maybe' }, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/^telegram-ask: .*timeoutOption/)
})

test('notify sends and prints nothing', async () => {
  const { port, notifier } = await startApi()
  const { deps, out, errors } = createDeps(port)
  expect(await runSendNotify({ text: 'done', project: 'api' }, deps)).toBe(0)
  expect(notifier.sent).toEqual(['[api]\n\ndone'])
  expect(out).toEqual([])
  expect(errors).toEqual([])
})

test('notify without provider support fails', async () => {
  const { port } = await startApi({ notifications: false })
  const { deps, errors } = createDeps(port)
  expect(await runSendNotify({ text: 'done' }, deps)).toBe(1)
  expect(errors).toEqual(['telegram-ask: notifications not supported by this provider'])
})

test('service down fails with a hint', async () => {
  const port = await freePort()
  const { deps, errors } = createDeps(port)
  expect(await runSendNotify({ text: 'done' }, deps)).toBe(1)
  expect(errors).toEqual([
    `telegram-ask: telegram-ask service not reachable on 127.0.0.1:${port} (run telegram-ask status)`,
  ])
})

test('request sends the token', async () => {
  const { port, service, messenger } = await startApi({ auth: { kind: 'token', token: TOKEN } })
  const { deps, out, errors } = createDeps(port, undefined, {
    kind: 'token',
    token: TOKEN,
    source: 'env',
  })
  const pending = runSendRequest(ASK, deps)
  await waitFor(() => messenger.sent.length === 1)
  service.tap(messenger.sent[0]?.id ?? '', 0)
  expect(await pending).toBe(0)
  expect(out).toEqual(['Approve'])
  expect(errors).toEqual([])
})

test('an unusable token fails without calling the service', async () => {
  const { port, messenger } = await startApi()
  const { deps, out, errors } = createDeps(port, undefined, {
    kind: 'unusable',
    message: 'bad token here',
  })
  expect(await runSendRequest(ASK, deps)).toBe(1)
  expect(await runSendNotify({ text: 'hi' }, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual(['telegram-ask: bad token here', 'telegram-ask: bad token here'])
  expect(messenger.sent).toEqual([])
})

test('a wrong token prints the rejected message', async () => {
  const { port, messenger } = await startApi({ auth: { kind: 'token', token: TOKEN } })
  const { deps, errors } = createDeps(port, undefined, {
    kind: 'token',
    token: `${TOKEN}x`,
    source: 'file',
  })
  expect(await runSendRequest(ASK, deps)).toBe(1)
  expect(errors).toEqual([`telegram-ask: ${TOKEN_REJECTED_MESSAGE}`])
  expect(messenger.sent).toEqual([])
})
