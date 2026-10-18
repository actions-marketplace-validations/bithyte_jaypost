import net from 'node:net'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { SendError } from '../../src/approval/index.ts'
import { createApiServer } from '../../src/server/index.ts'
import type { StatusInfo } from '../../src/server/index.ts'
import type { ApprovalRequest, RequestResult } from '../../src/approval/index.ts'

type RequestFn = (req: ApprovalRequest, signal?: AbortSignal) => Promise<RequestResult>

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
): Promise<string> {
  const stub = { request: vi.fn(request) }
  server = createApiServer(stub, status)
  await server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = server.server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

const post = (url: string, body: string) =>
  fetch(`${url}/request`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })

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
  expect(await res.json()).toEqual({ error: 'failed to send Telegram message' })
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
