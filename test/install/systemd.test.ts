import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vite-plus/test'
import { readConfigFile } from '../../src/config/index.ts'
import {
  resolveInstallPaths,
  createSystemdTarget,
  findUnitConfigFile,
} from '../../src/install/index.ts'
import type { Exec } from '../../src/system/index.ts'
import { NO_AUTH } from '../../src/auth/index.ts'
import { telegramProvider } from '../../src/telegram/index.ts'
import { createFakeProvider } from '../provider/fake.ts'

let tmp: string
let calls: [string, readonly string[]][]
let prefixOut: string
let rootOut: string
let failRestart: boolean

const fakeExec: Exec = async (cmd, args) => {
  calls.push([cmd, args])
  if (cmd === 'npm' && args[0] === 'prefix') {
    return { code: 0, stdout: prefixOut + '\n', stderr: '' }
  }
  if (cmd === 'npm' && args[0] === 'root') {
    return { code: 0, stdout: rootOut + '\n', stderr: '' }
  }
  if (cmd === 'systemctl' && args[1] === 'restart' && failRestart) {
    return { code: 1, stdout: '', stderr: 'boom' }
  }
  if (cmd === 'loginctl') {
    return { code: 0, stdout: 'Linger=yes\n', stderr: '' }
  }
  return { code: 0, stdout: '', stderr: '' }
}

function make(env: NodeJS.ProcessEnv = {}, selfPath = '/src/dist/cli.js') {
  const e = { HOME: tmp, ...env }
  const paths = resolveInstallPaths(e)
  const t = createSystemdTarget(
    {
      exec: fakeExec,
      paths,
      env: e,
      user: 'me',
      providers: [telegramProvider, createFakeProvider()],
    },
    { selfPath, nodePath: '/usr/bin/node' },
  )
  return { t, paths }
}

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
const base = {
  version: '0.1.0',
  port: 8787,
  provider: telegramProvider,
  settings: { botToken: 't' },
  auth: NO_AUTH,
  print: () => {},
}

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
    ['i', '-g', '--prefix', paths.userNpmPrefix, 'telegram-ask@0.1.0'],
  ])
  expect(rec.cliPath).toBe(
    join(paths.userNpmPrefix, 'lib', 'node_modules', 'telegram-ask', 'dist', 'cli.js'),
  )
})

test('installs globally when prefix is writable', async () => {
  prefixOut = tmp
  rootOut = join(tmp, 'lib', 'node_modules')
  const { t } = make()
  const rec = await t.install({ ...base, tarball: '/x/pkg.tgz' })
  expect(calls).toContainEqual(['npm', ['i', '-g', '/x/pkg.tgz']])
  expect(rec.cliPath).toBe(join(rootOut, 'telegram-ask', 'dist', 'cli.js'))
})

test('install writes unit, config 0600, enables', async () => {
  const { t, paths } = make()
  const rec = await t.install(base)
  expect(calls).toContainEqual(['systemctl', ['--user', 'daemon-reload']])
  expect(calls).toContainEqual(['systemctl', ['--user', 'enable', '--now', 'telegram-ask']])
  expect(calls.some(([c]) => c === 'sudo')).toBe(false)
  expect(readConfigFile(paths.configFile)).toEqual({
    provider: 'telegram',
    botToken: 't',
    port: 8787,
  })
  expect(statSync(paths.configFile).mode & 0o777).toBe(0o600)
  const unit = readFileSync(paths.systemdUnit, 'utf8')
  expect(unit).toContain(`ExecStart="/usr/bin/node" "${rec.cliPath}" start`)
  expect(unit).toContain(`Environment="TELEGRAM_ASK_CONFIG=${paths.configFile}"`)
  expect(rec).toMatchObject({
    target: 'systemd',
    provider: 'telegram',
    port: 8787,
    version: '0.1.0',
    configFile: paths.configFile,
  })
})

test('unit stays quoted with spaces in paths and config env', async () => {
  const cfg = join(tmp, 'my dir', 'c.json')
  rootOut = join(tmp, 'my root')
  const self = join(rootOut, 'telegram-ask', 'dist', 'cli.js')
  const { t, paths } = make({ TELEGRAM_ASK_CONFIG: cfg }, self)
  await t.install(base)
  const unit = readFileSync(paths.systemdUnit, 'utf8')
  expect(unit).toContain(`ExecStart="/usr/bin/node" "${self}" start`)
  expect(unit).toContain(`Environment="TELEGRAM_ASK_CONFIG=${cfg}"`)
  expect(readConfigFile(cfg).botToken).toBe('t')
})

test('install keeps a reused owner id', async () => {
  const { t, paths } = make()
  await t.install({ ...base, settings: { botToken: 't', ownerId: 42 } })
  expect(readConfigFile(paths.configFile)).toEqual({
    provider: 'telegram',
    botToken: 't',
    port: 8787,
    ownerId: 42,
  })
  expect(await t.readSecrets({} as never)).toEqual({
    provider: 'telegram',
    settings: { botToken: 't', ownerId: 42 },
  })
  await t.clearOwner({} as never)
  expect(readConfigFile(paths.configFile).ownerId).toBeUndefined()
})

test('already global: no npm install', async () => {
  const self = join(rootOut, 'telegram-ask', 'dist', 'cli.js')
  const { t } = make({}, self)
  const rec = await t.install(base)
  expect(calls.some(([c, a]) => c === 'npm' && a[0] === 'i')).toBe(false)
  expect(rec.cliPath).toBe(self)
})

test('remove without purge keeps config; with purge deletes it', async () => {
  const { t, paths } = make()
  const rec = await t.install(base)
  const stateFile = join(dirname(paths.configFile), 'state.json')
  writeFileSync(stateFile, '{}')
  await t.remove(rec, false)
  expect(existsSync(paths.systemdUnit)).toBe(false)
  expect(existsSync(paths.configFile)).toBe(true)
  expect(existsSync(stateFile)).toBe(true)
  expect(calls).toContainEqual(['systemctl', ['--user', 'disable', '--now', 'telegram-ask']])
  await t.remove(rec, true)
  expect(existsSync(paths.configFile)).toBe(false)
  expect(existsSync(stateFile)).toBe(false)
})

test('available, isRunning, restart, logsHint', async () => {
  const { t } = make()
  expect(await t.available()).toEqual({ ok: true })
  expect(await t.isRunning({} as never)).toBe(true)
  await t.restart({} as never)
  expect(calls).toContainEqual(['systemctl', ['--user', 'restart', 'telegram-ask']])
  expect(t.logsHint({} as never)).toBe('journalctl --user -u telegram-ask -f')
})

test('restart throws on a non-zero exit without leaking stderr', async () => {
  failRestart = true
  const { t } = make()
  await expect(t.restart({} as never)).rejects.toThrow('systemctl restart failed (exit 1)')
})

test('relative TELEGRAM_ASK_CONFIG is resolved to an absolute path and recorded', async () => {
  const cwd = process.cwd()
  process.chdir(tmp)
  try {
    const { t, paths } = make({ TELEGRAM_ASK_CONFIG: 'rel/c.json' })
    const rec = await t.install(base)
    const abs = join(tmp, 'rel', 'c.json')
    expect(rec.configFile).toBe(abs)
    expect(readFileSync(paths.systemdUnit, 'utf8')).toContain(
      `Environment="TELEGRAM_ASK_CONFIG=${abs}"`,
    )
    expect(readConfigFile(abs).botToken).toBe('t')
  } finally {
    process.chdir(cwd)
  }
})

test('readSecrets, clearOwner and purge use the recorded configFile, not the env', async () => {
  const recorded = join(tmp, 'recorded.json')
  writeFileSync(recorded, JSON.stringify({ botToken: 'rt', ownerId: 5 }))
  const recordedState = join(tmp, 'state.json')
  writeFileSync(recordedState, '{}')
  const { t, paths } = make({ TELEGRAM_ASK_CONFIG: join(tmp, 'other.json') })
  const rec = { target: 'systemd' as const, port: 1, version: 'v', configFile: recorded }
  expect(await t.readSecrets(rec)).toEqual({
    provider: 'telegram',
    settings: { botToken: 'rt', ownerId: 5 },
  })
  await t.clearOwner(rec)
  expect(readConfigFile(recorded)).toEqual({ botToken: 'rt' })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await t.remove(rec, true)
  expect(existsSync(recorded)).toBe(false)
  expect(existsSync(recordedState)).toBe(false)
  expect(existsSync(paths.configFile)).toBe(false)
})

test('readAuditLog reads both files next to the recorded configFile', async () => {
  const directory = join(tmp, 'recorded-dir')
  mkdirSync(directory)
  writeFileSync(join(directory, 'audit.jsonl.1'), 'old\n')
  writeFileSync(join(directory, 'audit.jsonl'), 'new\n')
  const { t } = make({ TELEGRAM_ASK_CONFIG: join(tmp, 'other.json') })
  const rec = {
    target: 'systemd' as const,
    port: 1,
    version: 'v',
    configFile: join(directory, 'config.json'),
  }
  expect(await t.readAuditLog(rec)).toBe('old\nnew\n')
  expect(await t.readAuditLog({ ...rec, configFile: join(tmp, 'empty', 'config.json') })).toBe('')
})

test('purge deletes audit.jsonl and audit.jsonl.1; remove without purge keeps them', async () => {
  const configFile = join(tmp, 'config.json')
  writeFileSync(configFile, '{}')
  const current = join(tmp, 'audit.jsonl')
  const rotated = join(tmp, 'audit.jsonl.1')
  writeFileSync(current, 'a\n')
  writeFileSync(rotated, 'b\n')
  const { t } = make()
  const rec = { target: 'systemd' as const, port: 1, version: 'v', configFile }
  await t.remove(rec, false)
  expect(existsSync(current)).toBe(true)
  expect(existsSync(rotated)).toBe(true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await t.remove(rec, true)
  expect(existsSync(current)).toBe(false)
  expect(existsSync(rotated)).toBe(false)
})

test('install without ownerId keeps a stored owner', async () => {
  const { t, paths } = make()
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ botToken: 'old', ownerId: 42 }))
  await t.install(base)
  expect(readConfigFile(paths.configFile)).toEqual({
    provider: 'telegram',
    botToken: 't',
    port: 8787,
    ownerId: 42,
  })
})

test("install drops another provider's keys", async () => {
  const { t, paths } = make()
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ provider: 'fake', fakeKey: 'k', extra: 1 }))
  await t.install(base)
  expect(readConfigFile(paths.configFile)).toEqual({
    provider: 'telegram',
    botToken: 't',
    port: 8787,
    extra: 1,
  })
})

test('readSecrets on an old config without provider reads as telegram', async () => {
  const { t, paths } = make()
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ botToken: 'old', port: 1, ownerId: 42 }))
  expect(await t.readSecrets({} as never)).toEqual({
    provider: 'telegram',
    settings: { botToken: 'old', ownerId: 42 },
  })
})

test('readSecrets reads the provider named in the config', async () => {
  const { t, paths } = make()
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ provider: 'fake', fakeKey: 'k', botToken: 'x' }))
  expect(await t.readSecrets({} as never)).toEqual({ provider: 'fake', settings: { fakeKey: 'k' } })
})

test('purge hint names the user prefix when the fallback was used', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const { t, paths } = make()
  const rec = await t.install(base)
  await t.remove(rec, true)
  expect(log).toHaveBeenCalledWith(
    `The npm package was left in place; remove it with: npm rm -g --prefix ${paths.userNpmPrefix} telegram-ask`,
  )
  log.mockClear()
  await t.remove({ ...rec, cliPath: '/usr/lib/node_modules/telegram-ask/dist/cli.js' }, true)
  expect(log).toHaveBeenCalledWith(
    'The npm package was left in place; remove it with: npm rm -g telegram-ask',
  )
  log.mockRestore()
})

test('findUnitConfigFile parses quoted and unquoted Environment lines', () => {
  expect(
    findUnitConfigFile('[Service]\nEnvironment="TELEGRAM_ASK_CONFIG=/a b/50%%/c.json"\n'),
  ).toBe('/a b/50%/c.json')
  expect(findUnitConfigFile('Environment="TELEGRAM_ASK_CONFIG=/x\\"q.json"\n')).toBe('/x"q.json')
  expect(findUnitConfigFile('Environment=TELEGRAM_ASK_CONFIG=/plain/c.json\n')).toBe(
    '/plain/c.json',
  )
  expect(findUnitConfigFile('Environment="FOO=bar"\nExecStart=x\n')).toBeUndefined()
  expect(findUnitConfigFile('[Unit]\n')).toBeUndefined()
})

test('install writes apiToken, and a later install without a token deletes it', async () => {
  const { t, paths } = make()
  await t.install({ ...base, auth: { kind: 'token', token: TOKEN } })
  expect(readConfigFile(paths.configFile).apiToken).toBe(TOKEN)
  await t.install({ ...base, auth: NO_AUTH })
  expect('apiToken' in readConfigFile(paths.configFile)).toBe(false)
})
