import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vite-plus/test'
import { resolveInstallPaths, createQuadletTarget } from '../../src/install/index.ts'
import type { Exec } from '../../src/system/index.ts'

let tmp: string
let calls: [string, readonly string[]][]
let podmanVersion: string
let ownerOut: string
let failBuild: boolean
let failArgs: (args: readonly string[]) => string | undefined
let failCtl: (args: readonly string[]) => boolean

const fakeExec: Exec = async (cmd, args) => {
  calls.push([cmd, args])
  if (cmd === 'podman' && args[0] === '--version')
    return { code: 0, stdout: `podman version ${podmanVersion}\n`, stderr: '' }
  if (cmd === 'systemctl' && failCtl(args)) return { code: 1, stdout: '', stderr: 'boom' }
  const f = cmd === 'podman' ? failArgs(args) : undefined
  if (f !== undefined) return { code: 1, stdout: '', stderr: f }
  if (cmd === 'podman' && args[0] === 'build' && failBuild)
    return { code: 1, stdout: '', stderr: 'bad' }
  if (cmd === 'podman' && args[0] === 'run') return { code: 0, stdout: ownerOut, stderr: '' }
  if (cmd === 'loginctl') return { code: 0, stdout: 'Linger=yes\n', stderr: '' }
  return { code: 0, stdout: '', stderr: '' }
}

function make() {
  const env = { HOME: tmp }
  const paths = resolveInstallPaths(env)
  return { t: createQuadletTarget({ exec: fakeExec, paths, env, user: 'me' }), paths }
}
const base = { version: '0.1.0', port: 8787, token: 't', print: () => {} }
const rec = { target: 'quadlet' as const, port: 8787, version: '0.1.0' }
const TAG = 'localhost/telegram-approval-bot:0.1.0'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'qd-'))
  calls = []
  podmanVersion = '5.0.0'
  ownerOut = ''
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
  })
  expect((await t.available()).ok).toBe(false)
})

test('quadlet install builds tagged image then starts', async () => {
  const { t, paths } = make()
  const tar = join(tmp, 'pkg-1.tgz')
  writeFileSync(tar, 'x')
  const r = await t.install({ ...base, tarball: tar })
  expect(r).toEqual({ target: 'quadlet', port: 8787, version: '0.1.0' })
  expect(calls.filter(([c]) => c !== 'loginctl')).toEqual([
    ['podman', ['build', '-t', TAG, paths.quadletDirectory]],
    ['systemctl', ['--user', 'daemon-reload']],
    ['systemctl', ['--user', 'start', 'telegram-approval-bot']],
  ])
  const envPath = join(paths.quadletDirectory, '.env')
  expect(statSync(envPath).mode & 0o777).toBe(0o600)
  expect(readFileSync(envPath, 'utf8')).toContain('BOT_TOKEN=t')
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
  await t.install({ ...base, ownerId: 9 })
  expect(await t.readSecrets(rec)).toEqual({ token: 't', ownerId: 9 })
  await t.clearOwner(rec)
  ownerOut = '77\n'
  calls = []
  expect(await t.readSecrets(rec)).toEqual({ token: 't', ownerId: 77 })
  expect(calls[0]).toEqual([
    'podman',
    [
      'run',
      '--rm',
      '-v',
      'telegram-approval-bot-data:/data',
      TAG,
      'telegram-approval-bot',
      'owner',
      'get',
    ],
  ])
})

test('clearOwner uses podman exec', async () => {
  const { t } = make()
  await t.install({ ...base, ownerId: 9 })
  calls = []
  await t.clearOwner(rec)
  expect(calls).toContainEqual([
    'podman',
    ['exec', 'telegram-approval-bot', 'telegram-approval-bot', 'owner', 'clear'],
  ])
})

test('remove without purge keeps volume, image and .env', async () => {
  const { t, paths } = make()
  await t.install(base)
  calls = []
  await t.remove(rec, false)
  expect(calls).toContainEqual(['systemctl', ['--user', 'stop', 'telegram-approval-bot']])
  expect(calls.some(([c]) => c === 'podman')).toBe(false)
  expect(existsSync(paths.quadletUnit)).toBe(false)
  expect(existsSync(join(paths.quadletDirectory, '.env'))).toBe(true)
})

test('remove with purge drops volume, image, dir', async () => {
  const { t, paths } = make()
  await t.install(base)
  calls = []
  await t.remove(rec, true)
  expect(calls).toContainEqual(['podman', ['volume', 'rm', 'telegram-approval-bot-data']])
  expect(calls).toContainEqual(['podman', ['rmi', TAG]])
  expect(existsSync(paths.quadletDirectory)).toBe(false)
})

test('restart, isRunning, logsHint', async () => {
  const { t } = make()
  await t.restart(rec)
  expect(calls[0]).toEqual(['systemctl', ['--user', 'restart', 'telegram-approval-bot']])
  expect(await t.isRunning(rec)).toBe(true)
  expect(t.logsHint(rec)).toBe('journalctl --user -u telegram-approval-bot -f')
})

test('clearOwner falls back to a one-off container when exec fails', async () => {
  const { t } = make()
  await t.install({ ...base, ownerId: 9 })
  failArgs = (a) => (a[0] === 'exec' ? 'not running' : undefined)
  calls = []
  await t.clearOwner(rec)
  expect(calls).toContainEqual([
    'podman',
    [
      'run',
      '--rm',
      '-v',
      'telegram-approval-bot-data:/data',
      TAG,
      'telegram-approval-bot',
      'owner',
      'clear',
    ],
  ])
})

test('clearOwner throws when exec and fallback both fail', async () => {
  const { t } = make()
  await t.install(base)
  failArgs = (a) => (a.includes('clear') ? 'boom' : undefined)
  await expect(t.clearOwner(rec)).rejects.toThrow(/clear the owner/)
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
