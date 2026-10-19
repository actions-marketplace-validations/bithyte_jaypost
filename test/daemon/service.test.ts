import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { NO_AUTH } from '../../src/auth/index.ts'
import type { Config } from '../../src/config/index.ts'
import { startService } from '../../src/daemon/index.ts'
import type { RunningService } from '../../src/daemon/index.ts'
import type { Provider } from '../../src/provider/index.ts'
import { createFakeProvider, createPairingFakeProvider } from '../provider/fake.ts'
import type { FakeRuntime } from '../provider/fake.ts'

const REQUEST = { text: 'Deploy?', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }

let running: RunningService | undefined

afterEach(async () => {
  vi.useRealTimers()
  await running?.stop()
  running = undefined
})

function createConfig(provider: Provider, settings = { fakeKey: 'k' }): Config {
  return { provider, settings, port: 0, host: '127.0.0.1', auth: NO_AUTH }
}

function createConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tab-daemon-')), 'config.json')
}

async function start(
  provider: Provider & { readonly runtimes: FakeRuntime[] },
  options: { configPath?: string; log?: (line: string) => void } = {},
): Promise<{ url: string; runtime: FakeRuntime }> {
  running = await startService({
    config: createConfig(provider),
    configPath: options.configPath ?? createConfigPath(),
    fatal: vi.fn(),
    log: options.log ?? vi.fn(),
    generateCode: () => 'K7QM4XPD',
  })
  await running.server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = running.server.server.address() as AddressInfo
  const runtime = provider.runtimes[0]
  if (runtime === undefined) {
    throw new Error('no runtime created')
  }
  return { url: `http://127.0.0.1:${port}`, runtime }
}

const post = (url: string, path: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    signal,
  })

const getStatus = async (url: string) => (await fetch(`${url}/status`)).json()

test('fake without optional parts: request is sent and an answer settles it', async () => {
  const { url, runtime } = await start(createFakeProvider())
  const response = post(url, '/request', REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  const sent = runtime.sent[0]
  expect(sent?.text).toBe('Deploy?')
  expect(runtime.handlers?.answer(sent?.id ?? '', 1)).toBe('accepted')
  expect(await (await response).json()).toEqual({ answer: 'Decline', timedOut: false })
})

test('fake without optional parts: timeout and cancel settle, no finalize attempted', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { url, runtime } = await start(createFakeProvider())
  const timedOut = post(url, '/request', { ...REQUEST, timeout: 1 })
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(1000)
  expect(await (await timedOut).json()).toEqual({ answer: 'Decline', timedOut: true })
  vi.useRealTimers()
  const controller = new AbortController()
  const cancelled = post(url, '/request', REQUEST, controller.signal).catch(() => undefined)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(2))
  controller.abort()
  await cancelled
  // Give the server time to see the closed connection; an uncancelled request would accept.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(runtime.handlers?.answer(runtime.sent[1]?.id ?? '', 0)).toBe('expired')
})

test('fake without pairing is paired from start', async () => {
  const { url, runtime } = await start(createFakeProvider())
  expect(await getStatus(url)).toEqual({ paired: true, provider: 'fake', displayName: 'fake' })
  const response = post(url, '/request', REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  runtime.handlers?.answer(runtime.sent[0]?.id ?? '', 0)
  expect((await response).status).toBe(200)
})

test('fake without notifications gets 501 on /notify', async () => {
  const { url } = await start(createFakeProvider())
  expect((await post(url, '/notify', { text: 'hi' })).status).toBe(501)
})

test('pairing fake: unpaired status, pair, then paired and saved', async () => {
  const configPath = createConfigPath()
  const log = vi.fn()
  const { url, runtime } = await start(createPairingFakeProvider(), { configPath, log })
  expect(log).toHaveBeenCalledWith('Not paired. Say K7QM4XPD to fake')
  expect(await getStatus(url)).toEqual({
    paired: false,
    provider: 'fakepair',
    displayName: 'fake',
    code: 'K7QM-4XPD',
    instructions: 'Say K7QM4XPD to fake',
  })
  expect(runtime.handlers?.pair?.('u1', 'k7qm-4xpd')).toBe('paired')
  expect(await getStatus(url)).toEqual({ paired: true, provider: 'fakepair', displayName: 'fake' })
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ fakeOwner: 'u1' })
})

test('owner save failure is logged and pairing still completes', async () => {
  const blocker = join(mkdtempSync(join(tmpdir(), 'tab-daemon-')), 'file')
  writeFileSync(blocker, '')
  const configPath = join(blocker, 'config.json')
  const log = vi.fn()
  const { url, runtime } = await start(createPairingFakeProvider(), { configPath, log })
  expect(runtime.handlers?.pair?.('u1', 'K7QM4XPD')).toBe('paired')
  expect(log).toHaveBeenCalledWith(
    `paired with u1 but couldn't save the owner to ${configPath}; it'll be lost on restart`,
  )
  expect(await getStatus(url)).toEqual({ paired: true, provider: 'fakepair', displayName: 'fake' })
})

test('unparseable owner is logged and not saved', async () => {
  const base = createPairingFakeProvider()
  const provider = {
    ...base,
    settings: base.settings.map((setting) =>
      setting.owner ? { ...setting, parse: () => undefined } : setting,
    ),
  }
  const configPath = createConfigPath()
  const log = vi.fn()
  const { runtime } = await start(provider, { configPath, log })
  expect(runtime.handlers?.pair?.('u1', 'K7QM4XPD')).toBe('paired')
  expect(log).toHaveBeenCalledWith(
    `paired with u1 but couldn't save the owner to ${configPath}; it'll be lost on restart`,
  )
  expect(existsSync(configPath) ? readFileSync(configPath, 'utf8') : '{}').not.toContain(
    'fakeOwner',
  )
})

test('rejected credentials throw with the provider reason', async () => {
  const provider = createFakeProvider({
    runtime: { checkCredentials: async () => ({ ok: false, reason: 'fake said no' }) },
  })
  await expect(
    startService({
      config: createConfig(provider),
      configPath: createConfigPath(),
      fatal: vi.fn(),
      log: vi.fn(),
    }),
  ).rejects.toThrow('fake said no')
})

test('owner setting without pairing support is refused at start', async () => {
  const provider = createFakeProvider({ settings: createPairingFakeProvider().settings })
  await expect(
    startService({
      config: createConfig(provider),
      configPath: createConfigPath(),
      fatal: vi.fn(),
      log: vi.fn(),
    }),
  ).rejects.toThrow('provider "fake" has an owner setting but no pairing support')
})

test('the service puts the configured token on the api', async () => {
  const token = 'a'.repeat(43)
  const provider = createFakeProvider()
  running = await startService({
    config: { ...createConfig(provider), auth: { kind: 'token', token } },
    configPath: createConfigPath(),
    fatal: vi.fn(),
    log: vi.fn(),
  })
  await running.server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = running.server.server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect((await fetch(`${url}/status`)).status).toBe(401)
  error.mockRestore()
  expect(
    (await fetch(`${url}/status`, { headers: { authorization: `Bearer ${token}` } })).status,
  ).toBe(200)
})
