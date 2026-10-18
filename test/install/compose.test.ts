import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vite-plus/test'
import { createComposeTarget, resolveInstallPaths } from '../../src/install/index.ts'
import type { Exec } from '../../src/system/index.ts'
import { telegramProvider } from '../../src/telegram/index.ts'
import { createFakeProvider, createPairingFakeProvider } from '../provider/fake.ts'

let tmp: string
let calls: [string, readonly string[]][]
let fail: (cmd: string, args: readonly string[]) => boolean
let ownerOut: string

const fakeExec: Exec = async (cmd, args) => {
  calls.push([cmd, args])
  if (fail(cmd, args)) {
    return { code: 1, stdout: '', stderr: 'x' }
  }
  if (args.includes('owner') && args.includes('get')) {
    return { code: 0, stdout: ownerOut, stderr: '' }
  }
  return { code: 0, stdout: '', stderr: '' }
}

function make() {
  const env = { HOME: tmp }
  const paths = resolveInstallPaths(env)
  return {
    t: createComposeTarget({ exec: fakeExec, paths, env, user: 'me', providers: PROVIDERS }),
    paths,
  }
}
const PAIRING_FAKE = createPairingFakeProvider()
const PROVIDERS = [telegramProvider, PAIRING_FAKE]
const base = {
  version: '0.1.0',
  port: 8787,
  provider: telegramProvider,
  settings: { botToken: 't' },
  print: () => {},
}
const withOwner = { ...base, settings: { botToken: 't', ownerId: 9 } }
const rec = { target: 'compose' as const, port: 8787, version: '0.1.0' }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cmp-'))
  calls = []
  fail = () => false
  ownerOut = ''
})

test('unavailable when compose v2 is missing', async () => {
  const { t } = make()
  fail = (c) => c === 'docker'
  expect(await t.available()).toEqual({ ok: false, reason: 'docker compose v2 not available' })
})

test('unavailable when docker missing entirely (throws)', async () => {
  const { paths } = make()
  const env = { HOME: tmp }
  const t = createComposeTarget({
    exec: async () => {
      throw new Error('ENOENT')
    },
    paths,
    env,
    user: 'me',
    providers: PROVIDERS,
  })
  expect(await t.available()).toEqual({ ok: false, reason: 'docker not installed' })
})

test('unavailable when docker info fails', async () => {
  const { t } = make()
  fail = (_c, a) => a[0] === 'info'
  expect(await t.available()).toEqual({
    ok: false,
    reason: "can't talk to docker (not in the docker group?)",
  })
})

test('available when both ok', async () => {
  const { t } = make()
  expect(await t.available()).toEqual({ ok: true })
})

test('install writes files and runs up -d --build', async () => {
  const { t, paths } = make()
  const tar = join(tmp, 'pkg-1.tgz')
  writeFileSync(tar, 'x')
  const r = await t.install({ ...withOwner, tarball: tar })
  expect(r).toEqual({ target: 'compose', provider: 'telegram', port: 8787, version: '0.1.0' })
  expect(readFileSync(join(paths.composeDirectory, 'Dockerfile'), 'utf8')).toContain(
    'COPY pkg-1.tgz',
  )
  expect(existsSync(join(paths.composeDirectory, 'pkg-1.tgz'))).toBe(true)
  expect(existsSync(join(paths.composeDirectory, 'compose.yaml'))).toBe(true)
  const envPath = join(paths.composeDirectory, '.env')
  expect(statSync(envPath).mode & 0o777).toBe(0o600)
  expect(readFileSync(envPath, 'utf8')).toBe(
    'PROVIDER=telegram\nBOT_TOKEN=t\nPORT=8787\nOWNER_ID=9\n',
  )
  expect(readFileSync(join(paths.composeDirectory, '.dockerignore'), 'utf8')).toBe('.env\n')
  expect(calls.at(-1)).toEqual([
    'docker',
    ['compose', '-f', join(paths.composeDirectory, 'compose.yaml'), 'up', '-d', '--build'],
  ])
})

test('install throws when up fails', async () => {
  const { t } = make()
  fail = (_c, a) => a.includes('up')
  await expect(t.install(base)).rejects.toThrow(/docker compose up/)
})

test('readSecrets prefers OWNER_ID in .env, falls back to owner get', async () => {
  const { t } = make()
  await t.install(withOwner)
  expect(await t.readSecrets(rec)).toEqual({
    provider: 'telegram',
    settings: { botToken: 't', ownerId: 9 },
  })
  await t.clearOwner(rec)
  ownerOut = '77\n'
  calls = []
  expect(await t.readSecrets(rec)).toEqual({
    provider: 'telegram',
    settings: { botToken: 't', ownerId: 77 },
  })
  expect(calls[0]![1]).toEqual(
    expect.arrayContaining(['run', '--rm', '--no-deps', 'bot', 'telegram-ask', 'owner', 'get']),
  )
  ownerOut = ''
  expect(await t.readSecrets(rec)).toEqual({ provider: 'telegram', settings: { botToken: 't' } })
})

test('readSecrets on an old env file reads as telegram', async () => {
  const { t, paths } = make()
  mkdirSync(paths.composeDirectory, { recursive: true })
  writeFileSync(join(paths.composeDirectory, '.env'), 'BOT_TOKEN=t\nPORT=1\nOWNER_ID=8\n')
  expect(await t.readSecrets(rec)).toEqual({
    provider: 'telegram',
    settings: { botToken: 't', ownerId: 8 },
  })
  expect(calls).toEqual([])
})

test('readSecrets of an unknown provider has no settings', async () => {
  const { t, paths } = make()
  mkdirSync(paths.composeDirectory, { recursive: true })
  writeFileSync(join(paths.composeDirectory, '.env'), 'PROVIDER=nope\nBOT_TOKEN=t\n')
  expect(await t.readSecrets(rec)).toEqual({ provider: 'nope', settings: {} })
})

test("clearOwner removes the owner env var of the record's provider", async () => {
  const { t, paths } = make()
  const record = await t.install({
    ...base,
    provider: PAIRING_FAKE,
    settings: { fakeKey: 'k', fakeOwner: 'o' },
  })
  expect(record.provider).toBe('fakepair')
  const envPath = join(paths.composeDirectory, '.env')
  expect(readFileSync(envPath, 'utf8')).toBe(
    'PROVIDER=fakepair\nFAKE_KEY=k\nPORT=8787\nFAKE_OWNER=o\n',
  )
  await t.clearOwner(record)
  expect(readFileSync(envPath, 'utf8')).toBe('PROVIDER=fakepair\nFAKE_KEY=k\nPORT=8787\n')
})

test('clearOwner throws when the provider has no owner setting', async () => {
  const { paths } = make()
  const t = createComposeTarget({
    exec: fakeExec,
    paths,
    env: { HOME: tmp },
    user: 'me',
    providers: [createFakeProvider()],
  })
  await expect(t.clearOwner({ ...rec, provider: 'fake' })).rejects.toThrow(
    'provider "fake" has no owner setting',
  )
})

test('clearOwner removes env key and runs owner clear', async () => {
  const { t, paths } = make()
  await t.install(withOwner)
  calls = []
  await t.clearOwner(rec)
  expect(readFileSync(join(paths.composeDirectory, '.env'), 'utf8')).not.toContain('OWNER_ID')
  expect(calls[0]![1]).toContain('clear')
})

test('remove without purge keeps .env and volume', async () => {
  const { t, paths } = make()
  await t.install(base)
  calls = []
  await t.remove(rec, false)
  expect(calls.some(([, a]) => a.includes('-v'))).toBe(false)
  expect(calls.some(([, a]) => a.includes('down'))).toBe(true)
  expect(existsSync(join(paths.composeDirectory, '.env'))).toBe(true)
})

test('remove with purge uses down -v and deletes dir', async () => {
  const { t, paths } = make()
  await t.install(base)
  calls = []
  await t.remove(rec, true)
  expect(calls.some(([, a]) => a.includes('down') && a.includes('-v'))).toBe(true)
  expect(existsSync(paths.composeDirectory)).toBe(false)
})

test('restart, isRunning, logsHint', async () => {
  const { t, paths } = make()
  await t.restart(rec)
  expect(calls[0]![1]).toEqual(expect.arrayContaining(['up', '-d', '--force-recreate']))
  expect(await t.isRunning(rec)).toBe(false)
  expect(t.logsHint(rec)).toBe(
    `docker compose -f ${join(paths.composeDirectory, 'compose.yaml')} logs -f`,
  )
})

test('clearOwner throws when the container command fails', async () => {
  const { t } = make()
  await t.install(base)
  fail = (_c, a) => a.includes('clear')
  await expect(t.clearOwner(rec)).rejects.toThrow(/clear the owner/)
})

test('failing down leaves files in place', async () => {
  const { t, paths } = make()
  await t.install(base)
  fail = (_c, a) => a.includes('down')
  await expect(t.remove(rec, true)).rejects.toThrow(/down failed/)
  expect(existsSync(join(paths.composeDirectory, '.env'))).toBe(true)
})

test('install skips copying a tarball already in the build dir', async () => {
  const { t, paths } = make()
  mkdirSync(paths.composeDirectory, { recursive: true })
  const tar = join(paths.composeDirectory, 'pkg-2.tgz')
  writeFileSync(tar, 'x')
  await t.install({ ...base, tarball: tar })
  expect(readFileSync(tar, 'utf8')).toBe('x')
})

test('restart throws on a non-zero exit', async () => {
  const { t } = make()
  fail = (_c, a) => a.includes('--force-recreate')
  await expect(t.restart(rec)).rejects.toThrow('docker compose up failed (exit 1)')
})
