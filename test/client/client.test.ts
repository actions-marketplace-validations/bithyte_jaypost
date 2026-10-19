import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vite-plus/test'
import { Client, TelegramAskError } from '../../src/index.ts'

const servers: Server[] = []
afterEach(async () => {
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

type Seen = { url?: string; body?: unknown }

/** Stub service that answers every call with `status` and `reply`, recording the last call. */
async function startStub(status: number, reply: string): Promise<{ port: number; seen: Seen }> {
  const seen: Seen = {}
  const handler: RequestListener = (request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      seen.url = request.url
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

const ASK = { text: 'Deploy?', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }

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
  expect(await client.request(ASK)).toEqual({ answer: 'Decline', timedOut: true })
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
  expect(seen).toEqual({ url: '/notify', body: { text: 'backup finished', project: 'nas' } })
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
