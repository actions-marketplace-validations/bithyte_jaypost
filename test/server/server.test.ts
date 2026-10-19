import net from 'node:net'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { parse } from 'yaml'
import { NO_AUTH } from '../../src/auth/index.ts'
import type { ApiAuth } from '../../src/auth/index.ts'
import { SendError } from '../../src/approval/index.ts'
import { createApiServer } from '../../src/server/index.ts'
import type { StatusInfo } from '../../src/server/index.ts'
import type { ApprovalRequest, RequestResult } from '../../src/approval/index.ts'
import type { NotifyRequest } from '../../src/notify/index.ts'

type RequestFn = (req: ApprovalRequest, signal?: AbortSignal) => Promise<RequestResult>
type NotifyFn = (req: NotifyRequest) => Promise<void>

const valid = {
  text: 'Deploy?',
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
  timeout: 30,
}

let server: FastifyInstance | undefined

afterEach(async () => {
  if (!server) {
    return
  }
  const s = server
  server = undefined
  await s.close()
})

async function start(
  request: RequestFn,
  status: () => StatusInfo = () => ({ paired: true, bot: 'b' }),
  notify?: NotifyFn,
  auth: ApiAuth = NO_AUTH,
): Promise<string> {
  const stub = { request: vi.fn(request) }
  server = createApiServer(stub, status, {
    maxTextLength: 3900,
    providerName: 'test',
    auth,
    ...(notify === undefined ? {} : { notifications: { notify } }),
  })
  await server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = server.server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

const post = (url: string, body: string) =>
  fetch(`${url}/request`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })

const postNotify = (url: string, body: string) =>
  fetch(`${url}/notify`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })

const TOKEN = 'a'.repeat(43)
const WRONG = 'b'.repeat(43)
const TOKEN_AUTH: ApiAuth = { kind: 'token', token: TOKEN }

const call = (
  url: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
) =>
  fetch(`${url}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body }),
  })

const unpaired = (): StatusInfo => ({ paired: false, code: 'ABCD-EFGH', bot: 'b' })

test('200 with outcome', async () => {
  const request = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  }))
  const url = await start(request)
  const res = await post(url, JSON.stringify(valid))
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(await res.json()).toEqual({ answer: 'Approve', timedOut: false })
  expect(request.mock.calls[0]?.[0]).toEqual({
    text: 'Deploy?',
    options: ['Approve', 'Decline'],
    timeoutOption: 'Decline',
    timeoutSeconds: 30,
  })
})

test('400 on non-JSON body, service not called', async () => {
  const request = vi.fn<RequestFn>()
  const url = await start(request)
  const res = await post(url, '{not json')
  expect(res.status).toBe(400)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(typeof ((await res.json()) as { error: unknown }).error).toBe('string')
  expect(request).not.toHaveBeenCalled()
})

test('400 on JSON null, array, and validation failure, error message present', async () => {
  const request = vi.fn<RequestFn>()
  const url = await start(request)
  for (const body of ['null', '[]', JSON.stringify({ ...valid, options: [] })]) {
    const res = await post(url, body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error.length).toBeGreaterThan(0)
  }
  expect(request).not.toHaveBeenCalled()
})

test('413 on 70 KB body', async () => {
  const request = vi.fn<RequestFn>()
  const url = await start(request)
  const res = await post(url, JSON.stringify({ ...valid, text: 'x'.repeat(70 * 1024) }))
  expect(res.status).toBe(413)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(typeof ((await res.json()) as { error: unknown }).error).toBe('string')
  expect(request).not.toHaveBeenCalled()
})

test('size limit counts bytes, not characters', async () => {
  const request = vi.fn<RequestFn>()
  const url = await start(request)
  // 40000 chars, 80000 bytes
  const res = await post(url, JSON.stringify({ ...valid, text: 'é'.repeat(40000) }))
  expect(res.status).toBe(413)
  expect(request).not.toHaveBeenCalled()
})

test('502 on SendError', async () => {
  const url = await start(async () => {
    throw new SendError('boom')
  })
  const res = await post(url, JSON.stringify(valid))
  expect(res.status).toBe(502)
  expect(await res.json()).toEqual({ error: 'failed to send message' })
})

test('server uses the provider text limit', async () => {
  server = createApiServer({ request: vi.fn<RequestFn>() }, () => ({ paired: true, bot: 'b' }), {
    maxTextLength: 10,
    providerName: 'test',
    auth: NO_AUTH,
  })
  await server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = server.server.address() as AddressInfo
  const res = await post(
    `http://127.0.0.1:${port}`,
    JSON.stringify({ ...valid, text: 'x'.repeat(11) }),
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'text must be at most 10 characters' })
})

test('500 on unexpected error without leaking details', async () => {
  const url = await start(async () => {
    throw new Error('secret internal detail')
  })
  const res = await post(url, JSON.stringify(valid))
  expect(res.status).toBe(500)
  const text = await res.text()
  expect(text).not.toContain('secret')
  expect(JSON.parse(text)).toHaveProperty('error')
})

test('GET /openapi.yaml serves the spec with the listening port and text limit', async () => {
  const url = await start(vi.fn<RequestFn>(), unpaired)
  const res = await fetch(`${url}/openapi.yaml`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/yaml')
  const document = parse(await res.text())
  expect(document.servers).toEqual([{ url }])
  expect(document.components.schemas.ApprovalRequest.properties.text.maxLength).toBe(3900)
})

test('405 on POST /openapi.yaml', async () => {
  const url = await start(vi.fn<RequestFn>())
  const res = await fetch(`${url}/openapi.yaml`, { method: 'POST' })
  expect(res.status).toBe(405)
  expect(res.headers.get('allow')).toBe('GET')
})

test('404 on GET /other, 405 on GET /request', async () => {
  const url = await start(vi.fn<RequestFn>())
  const other = await fetch(`${url}/other`)
  expect(other.status).toBe(404)
  expect(other.headers.get('content-type')).toContain('application/json')
  const wrongMethod = await fetch(`${url}/request`)
  expect(wrongMethod.status).toBe(405)
  expect(wrongMethod.headers.get('content-type')).toContain('application/json')
})

test('client abort triggers signal', async () => {
  let signal: AbortSignal | undefined
  const url = await start((_req, s) => {
    signal = s
    return new Promise(() => {})
  })
  const ac = new AbortController()
  const aborting = fetch(`${url}/request`, {
    method: 'POST',
    body: JSON.stringify(valid),
    signal: ac.signal,
  }).catch(() => {})
  setTimeout(() => ac.abort(), 50)
  await aborting
  await vi.waitFor(() => expect(signal?.aborted).toBe(true))
})

test('signal is not aborted after a normal response', async () => {
  let signal: AbortSignal | undefined
  const url = await start(async (_req, s) => {
    signal = s
    return { kind: 'completed', outcome: { answer: 'Approve', timedOut: false } }
  })
  const res = await post(url, JSON.stringify(valid))
  await res.json()
  await new Promise((r) => setTimeout(r, 50))
  expect(signal).toBeDefined()
  expect(signal?.aborted).toBe(false)
})

test('client gone before service resolves does not crash the server', async () => {
  let resolve!: (o: RequestResult) => void
  const url = await start(
    (_req, s) =>
      new Promise((r) => {
        resolve = r
        s?.addEventListener('abort', () => r({ kind: 'cancelled' }))
      }),
  )
  const ac = new AbortController()
  const p = fetch(`${url}/request`, {
    method: 'POST',
    body: JSON.stringify(valid),
    signal: ac.signal,
  }).catch(() => {})
  await vi.waitFor(() => expect(resolve).toBeDefined())
  ac.abort()
  await p
  await new Promise((r) => setTimeout(r, 50))
  resolve({ kind: 'completed', outcome: { answer: 'Approve', timedOut: false } })
  await new Promise((r) => setTimeout(r, 50))
  const again = await fetch(`${url}/other`)
  expect(again.status).toBe(404)
})

test('malformed request target gets 404 and the server keeps serving', async () => {
  const url = await start(vi.fn<RequestFn>())
  const port = Number(new URL(url).port)
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let data = ''
    socket.on('data', (d) => (data += d))
    socket.on('error', reject)
    socket.on('close', () => resolve(data))
    socket.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
  })
  expect(raw.startsWith('HTTP/1.1 404')).toBe(true)
  expect(raw).toContain('application/json')
  const after = await fetch(`${url}/other`)
  expect(after.status).toBe(404)
})

test('GET /status reports pairing', async () => {
  const url = await start(
    async () => ({ kind: 'cancelled' }),
    () => ({ paired: false, code: 'K7QM-4XPD', bot: 'b' }),
  )
  const res = await fetch(`${url}/status`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ paired: false, code: 'K7QM-4XPD', bot: 'b' })
})

test('GET /status when paired', async () => {
  const url = await start(async () => ({ kind: 'cancelled' }))
  const res = await fetch(`${url}/status`)
  expect(await res.json()).toEqual({ paired: true, bot: 'b' })
})

test('POST /request is 503 while unpaired, service not called', async () => {
  const request = vi.fn<RequestFn>()
  const url = await start(request, () => ({ paired: false, code: 'X', bot: 'b' }))
  const res = await post(url, JSON.stringify(valid))
  expect(res.status).toBe(503)
  expect(await res.json()).toEqual({ error: 'not paired' })
  const bad = await post(url, '{not json')
  expect(bad.status).toBe(503)
  expect(request).not.toHaveBeenCalled()
})

test('POST /status is 405 with Allow: GET', async () => {
  const url = await start(async () => ({ kind: 'cancelled' }))
  const res = await fetch(`${url}/status`, { method: 'POST', body: '{}' })
  expect(res.status).toBe(405)
  expect(res.headers.get('allow')).toBe('GET')
})

test('project is folded into the request text', async () => {
  const request = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  }))
  const url = await start(request)
  const res = await post(url, JSON.stringify({ ...valid, project: 'api' }))
  expect(res.status).toBe(200)
  expect(request.mock.calls[0]?.[0].text).toBe('[api]\n\nDeploy?')
})

test('project is folded into the notification text', async () => {
  const notify = vi.fn<NotifyFn>(async () => {})
  const url = await start(vi.fn<RequestFn>(), undefined, notify)
  const res = await postNotify(url, JSON.stringify({ text: 'hi', project: 'api' }))
  expect(res.status).toBe(200)
  expect(notify).toHaveBeenCalledWith({ text: '[api]\n\nhi' })
})

test('POST /notify returns ok once sent', async () => {
  const notify = vi.fn<NotifyFn>(async () => {})
  const url = await start(vi.fn<RequestFn>(), undefined, notify)
  const res = await postNotify(url, JSON.stringify({ text: 'hi' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(notify).toHaveBeenCalledWith({ text: 'hi' })
})

test('POST /notify 400 on bad JSON and bad text, notify not called', async () => {
  const notify = vi.fn<NotifyFn>()
  const url = await start(vi.fn<RequestFn>(), undefined, notify)
  for (const body of ['{not json', JSON.stringify({ text: '' }), 'null']) {
    const res = await postNotify(url, body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error.length).toBeGreaterThan(0)
  }
  expect(notify).not.toHaveBeenCalled()
})

test('POST /notify 502 on SendError', async () => {
  const url = await start(vi.fn<RequestFn>(), undefined, async () => {
    throw new SendError('x')
  })
  const res = await postNotify(url, JSON.stringify({ text: 'hi' }))
  expect(res.status).toBe(502)
})

test('POST /notify 413 on 70 KB body', async () => {
  const notify = vi.fn<NotifyFn>()
  const url = await start(vi.fn<RequestFn>(), undefined, notify)
  const res = await postNotify(url, JSON.stringify({ text: 'x'.repeat(70 * 1024) }))
  expect(res.status).toBe(413)
  expect(notify).not.toHaveBeenCalled()
})

test('POST /notify is 503 while unpaired, before validation', async () => {
  const notify = vi.fn<NotifyFn>()
  const url = await start(vi.fn<RequestFn>(), unpaired, notify)
  const res = await postNotify(url, '{not json')
  expect(res.status).toBe(503)
  expect(await res.json()).toEqual({ error: 'not paired' })
  expect(notify).not.toHaveBeenCalled()
})

test('POST /notify is 501 without notifications, before pairing check', async () => {
  const url = await start(vi.fn<RequestFn>(), unpaired)
  const res = await postNotify(url, JSON.stringify({ text: 'hi' }))
  expect(res.status).toBe(501)
  expect(await res.json()).toEqual({ error: 'notifications not supported' })
})

test('GET /notify is 405 with Allow: POST', async () => {
  const url = await start(vi.fn<RequestFn>(), undefined, vi.fn<NotifyFn>())
  const res = await fetch(`${url}/notify`)
  expect(res.status).toBe(405)
  expect(res.headers.get('allow')).toBe('POST')
})

test('401 with WWW-Authenticate on every api route for a missing, malformed or wrong token', async () => {
  const url = await start(vi.fn<RequestFn>(), undefined, vi.fn<NotifyFn>(), TOKEN_AUTH)
  const routes = [
    ['POST', '/request', JSON.stringify(valid)],
    ['POST', '/notify', JSON.stringify({ text: 'hi' })],
    ['GET', '/status', undefined],
  ] as const
  const headerSets: Record<string, string>[] = [
    {},
    { authorization: `Basic ${TOKEN}` },
    { authorization: `Bearer ${WRONG}` },
  ]
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const [method, path, body] of routes) {
    for (const headers of headerSets) {
      const res = await call(url, method, path, headers, body)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer')
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    }
  }
  error.mockRestore()
})

test('401 comes before 503, 400 and 413, and nothing reaches the service', async () => {
  const request = vi.fn<RequestFn>()
  const notify = vi.fn<NotifyFn>()
  const url = await start(request, unpaired, notify, TOKEN_AUTH)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const body of [JSON.stringify(valid), '{not json', 'x'.repeat(70_000)]) {
    for (const path of ['/request', '/notify']) {
      expect((await call(url, 'POST', path, {}, body)).status).toBe(401)
    }
  }
  expect(request).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalled()
  error.mockRestore()
})

test('the right token behaves as today', async () => {
  const request = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  }))
  const url = await start(request, undefined, undefined, TOKEN_AUTH)
  for (const authorization of [`Bearer ${TOKEN}`, `bearer   ${TOKEN}`]) {
    const res = await call(url, 'POST', '/request', { authorization }, JSON.stringify(valid))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ answer: 'Approve', timedOut: false })
  }
  const status = await call(url, 'GET', '/status', { authorization: `Bearer ${TOKEN}` })
  expect(status.status).toBe(200)
  expect(await status.json()).toEqual({ paired: true, bot: 'b' })
})

test('openapi.yaml, 404 and 405 stay open with a token', async () => {
  const url = await start(vi.fn<RequestFn>(), undefined, undefined, TOKEN_AUTH)
  expect((await call(url, 'GET', '/openapi.yaml', {})).status).toBe(200)
  expect((await call(url, 'GET', '/other', {})).status).toBe(404)
  const res = await call(url, 'GET', '/request', {})
  expect(res.status).toBe(405)
  expect(res.headers.get('allow')).toBe('POST')
})

test('rejections are logged once each without the token', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const url = await start(vi.fn<RequestFn>(), undefined, undefined, TOKEN_AUTH)
  await call(url, 'POST', '/request', {}, JSON.stringify(valid))
  await call(url, 'GET', '/status', { authorization: `Bearer ${WRONG}` })
  expect(error.mock.calls).toEqual([
    ['rejected POST /request: missing token'],
    ['rejected GET /status: wrong token'],
  ])
  error.mockRestore()
})

test('without a token a stray authorization header is ignored', async () => {
  const request = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  }))
  const url = await start(request)
  const res = await call(
    url,
    'POST',
    '/request',
    { authorization: 'Bearer whatever' },
    JSON.stringify(valid),
  )
  expect(res.status).toBe(200)
})
