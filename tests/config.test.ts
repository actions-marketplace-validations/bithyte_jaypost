import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vite-plus/test'
import { DEFAULT_PORT, configPath, loadConfig, saveConfig } from '../src/config.ts'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tab-config-'))
  file = join(dir, 'nested', 'config.json')
})

test('configPath precedence: APPROVAL_BOT_CONFIG > XDG_CONFIG_HOME > HOME', () => {
  expect(
    configPath({ APPROVAL_BOT_CONFIG: '/x/c.json', XDG_CONFIG_HOME: '/xdg', HOME: '/h' }),
  ).toBe('/x/c.json')
  expect(configPath({ XDG_CONFIG_HOME: '/xdg', HOME: '/h' })).toBe(
    '/xdg/telegram-approval-bot/config.json',
  )
  expect(configPath({ HOME: '/h' })).toBe('/h/.config/telegram-approval-bot/config.json')
  expect(configPath({ APPROVAL_BOT_CONFIG: '', XDG_CONFIG_HOME: '', HOME: '/h' })).toBe(
    '/h/.config/telegram-approval-bot/config.json',
  )
})

test('save then load roundtrip, host defaults to 127.0.0.1', () => {
  saveConfig(file, { botToken: 'tok', ownerId: 7, port: 9000 })
  expect(loadConfig({ APPROVAL_BOT_CONFIG: file })).toEqual({
    botToken: 'tok',
    ownerId: 7,
    port: 9000,
    host: '127.0.0.1',
  })
})

test('port defaults to DEFAULT_PORT', () => {
  saveConfig(file, { botToken: 'tok', ownerId: 7, port: DEFAULT_PORT })
  expect(loadConfig({ APPROVAL_BOT_CONFIG: file }).port).toBe(8787)
  expect(
    loadConfig({ BOT_TOKEN: 't', OWNER_ID: '1', APPROVAL_BOT_CONFIG: join(dir, 'no') }).port,
  ).toBe(8787)
})

test('saved file has mode 0o600, including when it already existed', () => {
  saveConfig(file, { botToken: 'tok', ownerId: 7, port: 9000 })
  expect(statSync(file).mode & 0o777).toBe(0o600)
  const loose = join(dir, 'loose.json')
  writeFileSync(loose, '{}', { mode: 0o644 })
  saveConfig(loose, { botToken: 'tok', ownerId: 7, port: 9000 })
  expect(statSync(loose).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(loose, 'utf8')).botToken).toBe('tok')
})

test('env overrides file values; env-only config works with no file', () => {
  saveConfig(file, { botToken: 'filetok', ownerId: 1, port: 1111 })
  expect(
    loadConfig({
      APPROVAL_BOT_CONFIG: file,
      BOT_TOKEN: 'envtok',
      OWNER_ID: '42',
      PORT: '2222',
      HOST: '0.0.0.0',
    }),
  ).toEqual({ botToken: 'envtok', ownerId: 42, port: 2222, host: '0.0.0.0' })
  expect(
    loadConfig({ APPROVAL_BOT_CONFIG: join(dir, 'missing.json'), BOT_TOKEN: 't', OWNER_ID: '42' }),
  ).toEqual({ botToken: 't', ownerId: 42, port: 8787, host: '127.0.0.1' })
})

test('empty-string env vars count as unset', () => {
  saveConfig(file, { botToken: 'filetok', ownerId: 1, port: 1111 })
  expect(
    loadConfig({ APPROVAL_BOT_CONFIG: file, BOT_TOKEN: '', OWNER_ID: '', PORT: '', HOST: '' }),
  ).toEqual({ botToken: 'filetok', ownerId: 1, port: 1111, host: '127.0.0.1' })
})

test('missing token or non-numeric OWNER_ID throws mentioning onboard', () => {
  const none = join(dir, 'none.json')
  expect(() => loadConfig({ APPROVAL_BOT_CONFIG: none, OWNER_ID: '1' })).toThrow(/npm run onboard/)
  expect(() => loadConfig({ APPROVAL_BOT_CONFIG: none, BOT_TOKEN: 't' })).toThrow(/npm run onboard/)
  expect(() => loadConfig({ APPROVAL_BOT_CONFIG: none, BOT_TOKEN: 't', OWNER_ID: 'abc' })).toThrow(
    /npm run onboard/,
  )
  expect(() => loadConfig({ APPROVAL_BOT_CONFIG: none, BOT_TOKEN: 't', OWNER_ID: '1.5' })).toThrow(
    /npm run onboard/,
  )
})

test.each(['0', '65536', '-1', 'abc', '80.5'])('invalid port %s throws', (p) => {
  expect(() =>
    loadConfig({
      APPROVAL_BOT_CONFIG: join(dir, 'none.json'),
      BOT_TOKEN: 't',
      OWNER_ID: '1',
      PORT: p,
    }),
  ).toThrow(/port/i)
})

test('malformed config file gives readable error with path', () => {
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{not json')
  expect(() => loadConfig({ APPROVAL_BOT_CONFIG: bad })).toThrow(bad)
})
