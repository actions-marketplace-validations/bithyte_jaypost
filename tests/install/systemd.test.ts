import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vite-plus/test'
import { readConfigFile } from '../../src/config.ts'
import type { Exec } from '../../src/install/exec.ts'
import { installPaths } from '../../src/install/paths.ts'
import { systemdTarget, unitConfigFile } from '../../src/install/systemd.ts'

let tmp: string
let calls: [string, string[]][]
let prefixOut: string
let rootOut: string
let failRestart: boolean

const fakeExec: Exec = async (cmd, args) => {
  calls.push([cmd, args])
  if (cmd === 'npm' && args[0] === 'prefix')
    return { code: 0, stdout: prefixOut + '\n', stderr: '' }
  if (cmd === 'npm' && args[0] === 'root') return { code: 0, stdout: rootOut + '\n', stderr: '' }
  if (cmd === 'systemctl' && args[1] === 'restart' && failRestart)
    return { code: 1, stdout: '', stderr: 'boom' }
  if (cmd === 'loginctl') return { code: 0, stdout: 'Linger=yes\n', stderr: '' }
  return { code: 0, stdout: '', stderr: '' }
}

function make(env: NodeJS.ProcessEnv = {}, selfPath = '/src/dist/cli.js') {
  const e = { HOME: tmp, ...env }
  const paths = installPaths(e)
  const t = systemdTarget(
    { exec: fakeExec, paths, env: e, user: 'me' },
    { selfPath, nodePath: '/usr/bin/node' },
  )
  return { t, paths }
}

const base = { version: '0.1.0', port: 8787, token: 't', print: () => {} }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sd-'))
  calls = []
  prefixOut = '/usr'
  rootOut = '/usr/lib/node_modules'
  failRestart = false
})

test('installs from npm into a user prefix when global prefix is not writable', async () => {
  const { t, paths } = make()
  const rec = await t.install(base)
  expect(calls).toContainEqual([
    'npm',
    ['i', '-g', '--prefix', paths.userNpmPrefix, 'telegram-approval-bot@0.1.0'],
  ])
  expect(rec.cliPath).toBe(
    join(paths.userNpmPrefix, 'lib', 'node_modules', 'telegram-approval-bot', 'dist', 'cli.js'),
  )
})

test('installs globally when prefix is writable', async () => {
  prefixOut = tmp
  rootOut = join(tmp, 'lib', 'node_modules')
  const { t } = make()
  const rec = await t.install({ ...base, tarball: '/x/pkg.tgz' })
  expect(calls).toContainEqual(['npm', ['i', '-g', '/x/pkg.tgz']])
  expect(rec.cliPath).toBe(join(rootOut, 'telegram-approval-bot', 'dist', 'cli.js'))
})

test('install writes unit, config 0600, enables', async () => {
  const { t, paths } = make()
  const rec = await t.install(base)
  expect(calls).toContainEqual(['systemctl', ['--user', 'daemon-reload']])
  expect(calls).toContainEqual([
    'systemctl',
    ['--user', 'enable', '--now', 'telegram-approval-bot'],
  ])
  expect(calls.some(([c]) => c === 'sudo')).toBe(false)
  expect(readConfigFile(paths.configFile)).toEqual({ botToken: 't', port: 8787 })
  expect(statSync(paths.configFile).mode & 0o777).toBe(0o600)
  const unit = readFileSync(paths.systemdUnit, 'utf8')
  expect(unit).toContain(`ExecStart="/usr/bin/node" "${rec.cliPath}" start`)
  expect(unit).toContain(`Environment="APPROVAL_BOT_CONFIG=${paths.configFile}"`)
  expect(rec).toMatchObject({
    target: 'systemd',
    port: 8787,
    version: '0.1.0',
    configFile: paths.configFile,
  })
})

test('unit stays quoted with spaces in paths and config env', async () => {
  const cfg = join(tmp, 'my dir', 'c.json')
  rootOut = join(tmp, 'my root')
  const self = join(rootOut, 'telegram-approval-bot', 'dist', 'cli.js')
  const { t, paths } = make({ APPROVAL_BOT_CONFIG: cfg }, self)
  await t.install(base)
  const unit = readFileSync(paths.systemdUnit, 'utf8')
  expect(unit).toContain(`ExecStart="/usr/bin/node" "${self}" start`)
  expect(unit).toContain(`Environment="APPROVAL_BOT_CONFIG=${cfg}"`)
  expect(readConfigFile(cfg).botToken).toBe('t')
})

test('install keeps a reused owner id', async () => {
  const { t, paths } = make()
  await t.install({ ...base, ownerId: 42 })
  expect(readConfigFile(paths.configFile)).toEqual({ botToken: 't', port: 8787, ownerId: 42 })
  expect(await t.readSecrets({} as never)).toEqual({ token: 't', ownerId: 42 })
  await t.clearOwner({} as never)
  expect(readConfigFile(paths.configFile).ownerId).toBeUndefined()
})

test('already global: no npm install', async () => {
  const self = join(rootOut, 'telegram-approval-bot', 'dist', 'cli.js')
  const { t } = make({}, self)
  const rec = await t.install(base)
  expect(calls.some(([c, a]) => c === 'npm' && a[0] === 'i')).toBe(false)
  expect(rec.cliPath).toBe(self)
})

test('remove without purge keeps config; with purge deletes it', async () => {
  const { t, paths } = make()
  const rec = await t.install(base)
  await t.remove(rec, false)
  expect(existsSync(paths.systemdUnit)).toBe(false)
  expect(existsSync(paths.configFile)).toBe(true)
  expect(calls).toContainEqual([
    'systemctl',
    ['--user', 'disable', '--now', 'telegram-approval-bot'],
  ])
  await t.remove(rec, true)
  expect(existsSync(paths.configFile)).toBe(false)
})

test('available, isRunning, restart, logsHint', async () => {
  const { t } = make()
  expect(await t.available()).toEqual({ ok: true })
  expect(await t.isRunning({} as never)).toBe(true)
  await t.restart({} as never)
  expect(calls).toContainEqual(['systemctl', ['--user', 'restart', 'telegram-approval-bot']])
  expect(t.logsHint({} as never)).toBe('journalctl --user -u telegram-approval-bot -f')
})

test('restart throws on a non-zero exit without leaking stderr', async () => {
  failRestart = true
  const { t } = make()
  await expect(t.restart({} as never)).rejects.toThrow('systemctl restart failed (exit 1)')
})

test('relative APPROVAL_BOT_CONFIG is resolved to an absolute path and recorded', async () => {
  const cwd = process.cwd()
  process.chdir(tmp)
  try {
    const { t, paths } = make({ APPROVAL_BOT_CONFIG: 'rel/c.json' })
    const rec = await t.install(base)
    const abs = join(tmp, 'rel', 'c.json')
    expect(rec.configFile).toBe(abs)
    expect(readFileSync(paths.systemdUnit, 'utf8')).toContain(
      `Environment="APPROVAL_BOT_CONFIG=${abs}"`,
    )
    expect(readConfigFile(abs).botToken).toBe('t')
  } finally {
    process.chdir(cwd)
  }
})

test('readSecrets, clearOwner and purge use the recorded configFile, not the env', async () => {
  const recorded = join(tmp, 'recorded.json')
  writeFileSync(recorded, JSON.stringify({ botToken: 'rt', ownerId: 5 }))
  const { t, paths } = make({ APPROVAL_BOT_CONFIG: join(tmp, 'other.json') })
  const rec = { target: 'systemd' as const, port: 1, version: 'v', configFile: recorded }
  expect(await t.readSecrets(rec)).toEqual({ token: 'rt', ownerId: 5 })
  await t.clearOwner(rec)
  expect(readConfigFile(recorded)).toEqual({ botToken: 'rt' })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await t.remove(rec, true)
  expect(existsSync(recorded)).toBe(false)
  expect(existsSync(paths.configFile)).toBe(false)
})

test('install without ownerId keeps a stored owner', async () => {
  const { t, paths } = make()
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ botToken: 'old', ownerId: 42 }))
  await t.install(base)
  expect(readConfigFile(paths.configFile)).toEqual({ botToken: 't', port: 8787, ownerId: 42 })
})

test('purge hint names the user prefix when the fallback was used', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const { t, paths } = make()
  const rec = await t.install(base)
  await t.remove(rec, true)
  expect(log).toHaveBeenCalledWith(
    `The npm package was left in place; remove it with: npm rm -g --prefix ${paths.userNpmPrefix} telegram-approval-bot`,
  )
  log.mockClear()
  await t.remove(
    { ...rec, cliPath: '/usr/lib/node_modules/telegram-approval-bot/dist/cli.js' },
    true,
  )
  expect(log).toHaveBeenCalledWith(
    'The npm package was left in place; remove it with: npm rm -g telegram-approval-bot',
  )
  log.mockRestore()
})

test('unitConfigFile parses quoted and unquoted Environment lines', () => {
  expect(unitConfigFile('[Service]\nEnvironment="APPROVAL_BOT_CONFIG=/a b/50%%/c.json"\n')).toBe(
    '/a b/50%/c.json',
  )
  expect(unitConfigFile('Environment="APPROVAL_BOT_CONFIG=/x\\"q.json"\n')).toBe('/x"q.json')
  expect(unitConfigFile('Environment=APPROVAL_BOT_CONFIG=/plain/c.json\n')).toBe('/plain/c.json')
  expect(unitConfigFile('Environment="FOO=bar"\nExecStart=x\n')).toBeUndefined()
  expect(unitConfigFile('[Unit]\n')).toBeUndefined()
})
