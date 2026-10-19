import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import {
  TOKEN_REJECTED_MESSAGE,
  TOKEN_REQUIRED_MESSAGE,
  postApi,
  toFetchTimeoutMs,
} from '../../src/client/index.ts'

const servers: Server[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
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

async function startStub(handler: RequestListener): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function reply(status: number, body: string): RequestListener {
  return (_request, response) => {
    response.statusCode = status
    response.end(body)
  }
}

function options(timeoutMs = 5000): { signal: AbortSignal; timeoutMs: number } {
  return { signal: new AbortController().signal, timeoutMs }
}

const TOKEN = 'A'.repeat(43)

function unreachable(port: number): string {
  return `telegram-ask service not reachable on 127.0.0.1:${port} (run telegram-ask status)`
}

test('200 returns the parsed body', async () => {
  let seen: { method?: string; url?: string; type?: string; body: string } = {
    body: '',
  }
  const port = await startStub((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      seen = {
        method: request.method,
        url: request.url,
        type: request.headers['content-type'],
        body,
      }
      response.end('{"answer":"Approve","timedOut":false}')
    })
  })
  const result = await postApi(port, '/request', { question: 'ok?' }, options())
  expect(result).toEqual({
    kind: 'ok',
    body: { answer: 'Approve', timedOut: false },
  })
  expect(seen).toEqual({
    method: 'POST',
    url: '/request',
    type: 'application/json',
    body: '{"question":"ok?"}',
  })
})

test.each([
  [400, '/request', '{"error":"options must be unique"}', 'options must be unique'],
  [
    404,
    '/notify',
    '{"error":"not found"}',
    'telegram-ask service is too old for notifications (run telegram-ask init to upgrade)',
  ],
  [501, '/notify', '{"error":"x"}', 'notifications not supported by this provider'],
  [503, '/request', '{"error":"x"}', "telegram-ask isn't paired yet (run telegram-ask status)"],
  [502, '/request', '{"error":"x"}', "couldn't send the message to the user"],
  [
    500,
    '/request',
    '{"error":"internal server error"}',
    'telegram-ask service error 500: internal server error',
  ],
] as const)('status %i on %s maps to a message', async (status, path, body, message) => {
  const port = await startStub(reply(status, body))
  expect(await postApi(port, path, {}, options())).toEqual({
    kind: 'failed',
    message,
  })
})

test('non-json error body is used as is', async () => {
  const port = await startStub(reply(404, '<html>nope</html>\n'))
  expect(await postApi(port, '/request', {}, options())).toEqual({
    kind: 'failed',
    message: 'telegram-ask service error 404: <html>nope</html>',
  })
})

test('unreachable port', async () => {
  const port = await freePort()
  expect(await postApi(port, '/request', {}, options())).toEqual({
    kind: 'failed',
    message: unreachable(port),
  })
})

test('connection reset mid-request reads as unreachable', async () => {
  const port = await startStub((request) => {
    request.socket.destroy()
  })
  expect(await postApi(port, '/request', {}, options())).toEqual({
    kind: 'failed',
    message: unreachable(port),
  })
})

test('timeout', async () => {
  const port = await startStub(() => {})
  expect(await postApi(port, '/request', {}, options(50))).toEqual({
    kind: 'failed',
    message: "telegram-ask service didn't answer within 0.05 s",
  })
})

test('caller abort', async () => {
  const controller = new AbortController()
  let closed!: Promise<void>
  let seen!: () => void
  const requestSeen = new Promise<void>((resolve) => (seen = resolve))
  const port = await startStub((request) => {
    closed = new Promise<void>((resolve) => request.on('close', resolve))
    seen()
  })
  const pending = postApi(port, '/request', {}, { signal: controller.signal, timeoutMs: 5000 })
  await requestSeen
  controller.abort()
  expect(await pending).toEqual({ kind: 'failed', message: 'cancelled' })
  await closed
})

// Global fetch has a fixed 300 s headers timeout that drops an ask waiting the full 300 s; a real
// 300 s wait is too slow for a test, so this pins the client to not going through fetch at all.
test('does not use global fetch', async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('fetch must not be used')))
  const port = await startStub(reply(200, '{"ok":true}'))
  expect(await postApi(port, '/notify', {}, options())).toEqual({
    kind: 'ok',
    body: { ok: true },
  })
})

test('timeout above 300 is capped', () => {
  expect(toFetchTimeoutMs(900)).toBe(330_000)
  expect(toFetchTimeoutMs(undefined)).toBe(330_000)
  expect(toFetchTimeoutMs(10)).toBe(40_000)
})

test('the token is sent as a bearer header only when given', async () => {
  const seen: (string | undefined)[] = []
  const port = await startStub((request, response) => {
    seen.push(request.headers.authorization)
    response.end('{}')
  })
  await postApi(port, '/request', {}, { ...options(), token: TOKEN })
  await postApi(port, '/request', {}, options())
  expect(seen).toEqual([`Bearer ${TOKEN}`, undefined])
})

test('401 explains whether a token was sent', async () => {
  const port = await startStub(reply(401, '{"error":"unauthorized"}'))
  expect(await postApi(port, '/request', {}, options())).toEqual({
    kind: 'failed',
    message: TOKEN_REQUIRED_MESSAGE,
  })
  const result = await postApi(port, '/request', {}, { ...options(), token: TOKEN })
  expect(result).toEqual({ kind: 'failed', message: TOKEN_REJECTED_MESSAGE })
  expect(JSON.stringify(result)).not.toContain(TOKEN)
})
