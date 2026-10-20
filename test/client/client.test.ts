import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { writeTokenFile } from '../../src/auth/index.ts'
import { TOKEN_REJECTED_MESSAGE } from '../../src/client/index.ts'
import { Client, TelegramAskError } from '../../src/index.ts'

const TOKEN = 'A'.repeat(43)
const FIRST = 'B'.repeat(43)
const SECOND = 'C'.repeat(43)
let directory = ''
const tokenFile = (): string => join(directory, 'telegram-ask', 'token')

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'telegram-ask-client-'))
  vi.stubEnv('XDG_CONFIG_HOME', directory)
  vi.stubEnv('TELEGRAM_ASK_TOKEN', '')
})

const servers: Server[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

type Seen = { url?: string; body?: unknown; authorization?: string }

/** Stub service that answers every call with `status` and `reply`, recording the last call. */
async function startStub(status: number, reply: string): Promise<{ port: number; seen: Seen }> {
  const seen: Seen = {}
  const handler: RequestListener = (request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      seen.url = request.url
      seen.authorization = request.headers.authorization
      seen.body = JSON.parse(body)
      response.statusCode = status
      response.end(reply)
    })
  }
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, seen }
}

const ASK = {
  text: 'Deploy?',
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
}

test('request returns the answer', async () => {
  const { port, seen } = await startStub(200, '{"answer":"Approve","timedOut":false}')
  const client = new Client({ port })
  expect(await client.request({ ...ASK, timeout: 60 })).toEqual({
    answer: 'Approve',
    timedOut: false,
  })
  expect(seen).toEqual({ url: '/request', body: { ...ASK, timeout: 60 } })
})

test('request returns a timeout as data', async () => {
  const { port } = await startStub(200, '{"answer":"Decline","timedOut":true,"extra":1}')
  const client = new Client({ port })
  expect(await client.request(ASK)).toEqual({
    answer: 'Decline',
    timedOut: true,
  })
})

test('client project is sent unless the call sets its own', async () => {
  const { port, seen } = await startStub(200, '{"answer":"Approve","timedOut":false}')
  const client = new Client({ port, project: 'api' })
  await client.request(ASK)
  expect(seen.body).toEqual({ ...ASK, project: 'api' })
  await client.request({ ...ASK, project: 'web' })
  expect(seen.body).toEqual({ ...ASK, project: 'web' })
})

test('notify posts the text and resolves', async () => {
  const { port, seen } = await startStub(200, '{"ok":true}')
  const client = new Client({ port, project: 'nas' })
  await client.notify({ text: 'backup finished' })
  expect(seen).toEqual({
    url: '/notify',
    body: { text: 'backup finished', project: 'nas' },
  })
})

test('service 400 throws with its message', async () => {
  const { port } = await startStub(400, '{"error":"options must be unique"}')
  const client = new Client({ port })
  await expect(client.request(ASK)).rejects.toThrow(new TelegramAskError('options must be unique'))
})

test('unreadable answer throws', async () => {
  const { port } = await startStub(200, '{"answer":1}')
  const client = new Client({ port })
  await expect(client.request(ASK)).rejects.toThrow(
    'telegram-ask service sent an unreadable answer: {"answer":1}',
  )
})

test('unreachable host throws and names it', async () => {
  const client = new Client({ host: '127.0.0.2', port: 9 })
  const error = await client.notify({ text: 'hi' }).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(TelegramAskError)
  expect(error).toHaveProperty(
    'message',
    'telegram-ask service not reachable on 127.0.0.2:9 (run telegram-ask status)',
  )
})

test('abort rejects with the signal reason', async () => {
  const server = createServer(() => {})
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const client = new Client({ port: (server.address() as AddressInfo).port })
  const controller = new AbortController()
  const pending = client.request({ ...ASK, signal: controller.signal })
  const reason = new Error('stop')
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
})

test('an explicit token is sent as a bearer header', async () => {
  const { port, seen } = await startStub(200, '{"ok":true}')
  await new Client({ port, token: TOKEN }).notify({ text: 'x' })
  expect(seen.authorization).toBe(`Bearer ${TOKEN}`)
})

test('no token anywhere sends no authorization header', async () => {
  const { port, seen } = await startStub(200, '{"ok":true}')
  await new Client({ port }).notify({ text: 'x' })
  expect(seen.url).toBe('/notify')
  expect(seen.authorization).toBeUndefined()
})

test('the default lookup reads the token file on every call', async () => {
  const { port, seen } = await startStub(200, '{"ok":true}')
  const client = new Client({ port })
  writeTokenFile(tokenFile(), FIRST)
  await client.notify({ text: 'x' })
  expect(seen.authorization).toBe(`Bearer ${FIRST}`)
  writeTokenFile(tokenFile(), SECOND)
  await client.notify({ text: 'x' })
  expect(seen.authorization).toBe(`Bearer ${SECOND}`)
})

test('TELEGRAM_ASK_TOKEN beats the token file', async () => {
  const { port, seen } = await startStub(200, '{"ok":true}')
  writeTokenFile(tokenFile(), FIRST)
  vi.stubEnv('TELEGRAM_ASK_TOKEN', SECOND)
  await new Client({ port }).notify({ text: 'x' })
  expect(seen.authorization).toBe(`Bearer ${SECOND}`)
})

test('a bad explicit token is a RangeError that does not quote it', () => {
  expect(() => new Client({ token: 'short-secret' })).toThrow(
    new RangeError("token isn't a valid telegram-ask token"),
  )
})

test('the constructor does no io and an unreadable token file rejects the call', async () => {
  mkdirSync(tokenFile(), { recursive: true })
  const { port, seen } = await startStub(200, '{"ok":true}')
  const client = new Client({ port })
  const error = await client.notify({ text: 'x' }).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(TelegramAskError)
  expect(error).toHaveProperty(
    'message',
    expect.stringMatching(
      new RegExp(`^token file ${JSON.stringify(tokenFile())} couldn't be read: `),
    ),
  )
  expect(seen.url).toBeUndefined()
})

test('a rejected token surfaces the rejected message', async () => {
  const { port } = await startStub(401, '{"error":"unauthorized"}')
  const client = new Client({ port, token: TOKEN })
  await expect(client.notify({ text: 'x' })).rejects.toThrow(
    new TelegramAskError(TOKEN_REJECTED_MESSAGE),
  )
})

test('allowText is sent, and options only when given', async () => {
  const { port, seen } = await startStub(200, '{"answer":"feature/x","timedOut":false}')
  const client = new Client({ port })
  await client.request({ text: 'Which branch?', allowText: true, timeoutOption: 'main' })
  expect(seen.body).toEqual({ text: 'Which branch?', allowText: true, timeoutOption: 'main' })
})
