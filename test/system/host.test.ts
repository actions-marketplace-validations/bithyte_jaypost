import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { expect, test, vi } from 'vite-plus/test'
import type { Exec } from '../../src/system/index.ts'
import { ensureLinger, isPortFree, validateToken } from '../../src/system/index.ts'

test('isPortFree false while held, true after', async () => {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  expect(await isPortFree(port)).toBe(false)
  await new Promise((r) => s.close(r))
  expect(await isPortFree(port)).toBe(true)
})

const res = (code: number, stdout = '') => ({ code, stdout, stderr: '' })

test('ensureLinger enables only when Linger=no', async () => {
  const calls: string[][] = []
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    return args[0] === 'show-user' ? res(0, 'Linger=no\n') : res(0)
  }
  await ensureLinger(exec, 'bob', () => {})
  expect(calls).toEqual([
    ['loginctl', 'show-user', 'bob', '-p', 'Linger'],
    ['loginctl', 'enable-linger', 'bob'],
  ])
})

test('ensureLinger skips when Linger=yes', async () => {
  const calls: string[][] = []
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    return res(0, 'Linger=yes\n')
  }
  await ensureLinger(exec, 'bob', () => {})
  expect(calls).toHaveLength(1)
})

test('ensureLinger prints fallback on failure', async () => {
  const print = vi.fn()
  const exec: Exec = async (_c, args) => (args[0] === 'show-user' ? res(0, 'Linger=no\n') : res(1))
  await ensureLinger(exec, 'bob', print)
  expect(print).toHaveBeenCalledWith(
    'Run "loginctl enable-linger bob" so it keeps running after logout.',
  )
})

test('ensureLinger prints fallback when loginctl is missing', async () => {
  const print = vi.fn()
  const exec: Exec = async () => {
    throw new Error('missing')
  }
  await ensureLinger(exec, 'bob', print)
  expect(print).toHaveBeenCalledOnce()
})

async function withBotApi(
  respond: (url: string) => { status: number; body: unknown },
  run: (apiRoot: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((request, response) => {
    const { status, body } = respond(request.url ?? '')
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('validateToken returns username on ok', async () => {
  const urls: string[] = []
  await withBotApi(
    (url) => {
      urls.push(url)
      return {
        status: 200,
        body: { ok: true, result: { id: 1, is_bot: true, first_name: 'x', username: 'mybot' } },
      }
    },
    async (apiRoot) => {
      expect(await validateToken('123:abc', apiRoot)).toBe('mybot')
    },
  )
  expect(urls).toEqual(['/bot123:abc/getMe'])
})

test('validateToken returns undefined when telegram rejects the token', async () => {
  await withBotApi(
    () => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }),
    async (apiRoot) => {
      expect(await validateToken('123:abc', apiRoot)).toBeUndefined()
    },
  )
})

test('validateToken returns undefined when telegram is unreachable', async () => {
  const server = net.createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  await new Promise((r) => server.close(r))
  expect(await validateToken('SECRET-TOKEN', `http://127.0.0.1:${port}`)).toBeUndefined()
})
