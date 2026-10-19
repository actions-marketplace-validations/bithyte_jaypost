import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vite-plus/test'
import { resolveInstallPaths, createQuadletTarget } from '../../src/install/index.ts'
import type { Exec } from '../../src/system/index.ts'
import { NO_AUTH } from '../../src/auth/index.ts'
import { telegramProvider } from '../../src/telegram/index.ts'
import { createPairingFakeProvider } from '../provider/fake.ts'

let tmp: string
let calls: [string, readonly string[]][]
let podmanVersion: string
let ownerOut: string
let execOut: string
let failBuild: boolean
let failArgs: (args: readonly string[]) => string | undefined
let failCtl: (args: readonly string[]) => boolean

const fakeExec: Exec = async (cmd, args) => {
  calls.push([cmd, args])
  if (cmd === 'podman' && args[0] === '--version') {
    return { code: 0, stdout: `podman version ${podmanVersion}\n`, stderr: '' }
  }
  if (cmd === 'systemctl' && failCtl(args)) {
    return { code: 1, stdout: '', stderr: 'boom' }
  }
  const f = cmd === 'podman' ? failArgs(args) : undefined
  if (f !== undefined) {
    return { code: 1, stdout: '', stderr: f }
  }
  if (cmd === 'podman' && args[0] === 'build' && failBuild) {
    return { code: 1, stdout: '', stderr: 'bad' }
  }
  if (cmd === 'podman' && args[0] === 'exec') {
    return { code: 0, stdout: execOut, stderr: '' }
  }
  if (cmd === 'podman' && args[0] === 'run') {
    return { code: 0, stdout: ownerOut, stderr: '' }
  }
  if (cmd === 'loginctl') {
    return { code: 0, stdout: 'Linger=yes\n', stderr: '' }
  }
  return { code: 0, stdout: '', stderr: '' }
}

function make() {
  const env = { HOME: tmp }
  const paths = resolveInstallPaths(env)
  return {
    t: createQuadletTarget({ exec: fakeExec, paths, env, user: 'me', providers: PROVIDERS }),
    paths,
  }
}
const PAIRING_FAKE = createPairingFakeProvider()
const PROVIDERS = [telegramProvider, PAIRING_FAKE]
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
const base = {
  version: '0.1.0',
  port: 8787,
  provider: telegramProvider,
  settings: { botToken: 't' },
  auth: NO_AUTH,
  print: () => {},
}
const withOwner = { ...base, settings: { botToken: 't', ownerId: 9 } }
const rec = { target: 'quadlet' as const, port: 8787, version: '0.1.0' }
const TAG = 'localhost/telegram-ask:0.1.0'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'qd-'))
  calls = []
  podmanVersion = '5.0.0'
  ownerOut = ''
  execOut = ''
  failBuild = false
  failArgs = () => undefined
  failCtl = () => false
})

test('quadlet unavailable on podman 4.3', async () => {
  podmanVersion = '4.3.1'
  const r = await make().t.available()
  expect(r.ok).toBe(false)
  expect(r.ok === false && r.reason).toMatch(/4\.3\.1/)
})

test('quadlet available on 4.4 and 5.x', async () => {
  podmanVersion = '4.4.0'
  expect(await make().t.available()).toEqual({ ok: true })
  podmanVersion = '5.0.0'
  expect(await make().t.available()).toEqual({ ok: true })
})

test('quadlet unavailable when podman missing', async () => {
  const { paths } = make()
  const t = createQuadletTarget({
    exec: async () => {
      throw new Error('ENOENT')
    },
    paths,
    env: {},
    user: 'me',
    providers: PROVIDERS,
  })
  expect((await t.available()).ok).toBe(false)
})

test('quadlet install builds tagged image then starts', async () => {
  const { t, paths } = make()
  const tar = join(tmp, 'pkg-1.tgz')
  writeFileSync(tar, 'x')
  const r = await t.install({ ...base, tarball: tar })
  expect(r).toEqual({ target: 'quadlet', provider: 'telegram', port: 8787, version: '0.1.0' })
  expect(calls.filter(([c]) => c !== 'loginctl')).toEqual([
    ['podman', ['build', '-t', TAG, paths.quadletDirectory]],
    ['systemctl', ['--user', 'daemon-reload']],
    ['systemctl', ['--user', 'start', 'telegram-ask']],
  ])
  const envPath = join(paths.quadletDirectory, '.env')
  expect(statSync(envPath).mode & 0o777).toBe(0o600)
  expect(readFileSync(envPath, 'utf8')).toBe('PROVIDER=telegram\nBOT_TOKEN=t\nPORT=8787\n')
  expect(existsSync(join(paths.quadletDirectory, 'pkg-1.tgz'))).toBe(true)
  expect(readFileSync(paths.quadletUnit, 'utf8')).toContain(`Image=${TAG}`)
  expect(readFileSync(join(paths.quadletDirectory, '.dockerignore'), 'utf8')).toBe('.env\n')
})

test('install throws when build fails and does not start', async () => {
  failBuild = true
  const { t } = make()
  await expect(t.install(base)).rejects.toThrow(/podman build/)
  expect(calls.some(([c]) => c === 'systemctl')).toBe(false)
})

test('readSecrets prefers .env, falls back to owner get in container', async () => {
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
  expect(calls[0]).toEqual([
    'podman',
    ['run', '--rm', '-v', 'telegram-ask-data:/data', TAG, 'telegram-ask', 'owner', 'get'],
  ])
})

test('readSecrets on an old env file reads as telegram', async () => {
  const { t, paths } = make()
  mkdirSync(paths.quadletDirectory, { recursive: true })
  writeFileSync(join(paths.quadletDirectory, '.env'), 'BOT_TOKEN=t\nPORT=1\nOWNER_ID=8\n')
  expect(await t.readSecrets(rec)).toEqual({
    provider: 'telegram',
    settings: { botToken: 't', ownerId: 8 },
  })
  expect(calls).toEqual([])
})

test("clearOwner removes the owner env var of the record's provider", async () => {
  const { t, paths } = make()
  const record = await t.install({
    ...base,
    provider: PAIRING_FAKE,
    settings: { fakeKey: 'k', fakeOwner: 'o' },
  })
  expect(record.provider).toBe('fakepair')
  await t.clearOwner(record)
  expect(readFileSync(join(paths.quadletDirectory, '.env'), 'utf8')).toBe(
    'PROVIDER=fakepair\nFAKE_KEY=k\nPORT=8787\n',
  )
})

test('clearOwner uses podman exec', async () => {
  const { t } = make()
  await t.install(withOwner)
  calls = []
  await t.clearOwner(rec)
  expect(calls).toContainEqual([
    'podman',
    ['exec', 'telegram-ask', 'telegram-ask', 'owner', 'clear'],
  ])
})

test('remove without purge keeps volume, image and .env', async () => {
  const { t, paths } = make()
  await t.install(base)
  calls = []
  await t.remove(rec, false)
  expect(calls).toContainEqual(['systemctl', ['--user', 'stop', 'telegram-ask']])
  expect(calls.some(([c]) => c === 'podman')).toBe(false)
  expect(existsSync(paths.quadletUnit)).toBe(false)
  expect(existsSync(join(paths.quadletDirectory, '.env'))).toBe(true)
})

test('remove with purge drops volume, image, dir', async () => {
  const { t, paths } = make()
  await t.install(base)
  calls = []
  await t.remove(rec, true)
  expect(calls).toContainEqual(['podman', ['volume', 'rm', 'telegram-ask-data']])
  expect(calls).toContainEqual(['podman', ['rmi', TAG]])
  expect(existsSync(paths.quadletDirectory)).toBe(false)
})

test('restart, isRunning, logsHint', async () => {
  const { t } = make()
  await t.restart(rec)
  expect(calls[0]).toEqual(['systemctl', ['--user', 'restart', 'telegram-ask']])
  expect(await t.isRunning(rec)).toBe(true)
  expect(t.logsHint(rec)).toBe('journalctl --user -u telegram-ask -f')
})

test('clearOwner falls back to a one-off container when exec fails', async () => {
  const { t } = make()
  await t.install(withOwner)
  failArgs = (a) => (a[0] === 'exec' ? 'not running' : undefined)
  calls = []
  await t.clearOwner(rec)
  expect(calls).toContainEqual([
    'podman',
    ['run', '--rm', '-v', 'telegram-ask-data:/data', TAG, 'telegram-ask', 'owner', 'clear'],
  ])
})

test('clearOwner throws when exec and fallback both fail', async () => {
  const { t } = make()
  await t.install(base)
  failArgs = (a) => (a.includes('clear') ? 'boom' : undefined)
  await expect(t.clearOwner(rec)).rejects.toThrow(/clear the owner/)
})

test('readAuditLog execs audit dump in the running container', async () => {
  const { t } = make()
  execOut = 'LINES'
  calls = []
  expect(await t.readAuditLog(rec)).toBe('LINES')
  expect(calls).toEqual([['podman', ['exec', 'telegram-ask', 'telegram-ask', 'audit', 'dump']]])
})

test('readAuditLog falls back to a one-off container when exec fails', async () => {
  const { t } = make()
  failArgs = (a) => (a[0] === 'exec' ? 'no such container' : undefined)
  ownerOut = 'FROM RUN'
  calls = []
  expect(await t.readAuditLog(rec)).toBe('FROM RUN')
  expect(calls).toContainEqual([
    'podman',
    ['run', '--rm', '-v', 'telegram-ask-data:/data', TAG, 'telegram-ask', 'audit', 'dump'],
  ])
})

test('readAuditLog throws with stderr when both fail', async () => {
  const { t } = make()
  failArgs = () => 'boom'
  await expect(t.readAuditLog(rec)).rejects.toThrow(
    "couldn't read the log from the container: boom",
  )
})

test('purge tolerates not-found errors', async () => {
  const { t, paths } = make()
  await t.install(base)
  failArgs = (a) => (a[0] === 'volume' || a[0] === 'rmi' ? 'Error: no such volume' : undefined)
  await t.remove(rec, true)
  expect(existsSync(paths.quadletDirectory)).toBe(false)
})

test('purge runs all steps, throws, and keeps dir when volume rm fails', async () => {
  const { t, paths } = make()
  await t.install(base)
  failArgs = (a) =>
    a[0] === 'volume' ? 'volume in use' : a[0] === 'rmi' ? 'image busy' : undefined
  calls = []
  await expect(t.remove(rec, true)).rejects.toThrow(/volume in use.*image busy/)
  expect(calls).toContainEqual(['podman', ['rmi', TAG]])
  expect(existsSync(paths.quadletDirectory)).toBe(true)
})

test('purge rmi failure alone throws but dir is deleted', async () => {
  const { t, paths } = make()
  await t.install(base)
  failArgs = (a) => (a[0] === 'rmi' ? 'image busy' : undefined)
  await expect(t.remove(rec, true)).rejects.toThrow(/image busy/)
  expect(existsSync(paths.quadletDirectory)).toBe(false)
})

test('restart throws on a non-zero exit', async () => {
  const { t } = make()
  failCtl = (a) => a.includes('restart')
  await expect(t.restart(rec)).rejects.toThrow('systemctl restart failed (exit 1)')
})

test('install writes TZ into .env when a time zone is given', async () => {
  const { t, paths } = make()
  await t.install({ ...base, timeZone: 'Europe/Bucharest' })
  const lines = readFileSync(join(paths.quadletDirectory, '.env'), 'utf8').split('\n')
  expect(lines).toContain('TZ=Europe/Bucharest')
})

test('install writes no TZ line without a time zone', async () => {
  const { t, paths } = make()
  await t.install(base)
  expect(readFileSync(join(paths.quadletDirectory, '.env'), 'utf8')).not.toContain('TZ=')
})

test('install writes the api token into .env and keeps it out of the Dockerfile', async () => {
  const { t, paths } = make()
  await t.install({ ...base, auth: { kind: 'token', token: TOKEN } })
  const directory = paths.quadletDirectory
  expect(readFileSync(join(directory, '.env'), 'utf8')).toContain(`TELEGRAM_ASK_TOKEN=${TOKEN}\n`)
  expect(readFileSync(join(directory, 'Dockerfile'), 'utf8')).not.toContain(TOKEN)
})
