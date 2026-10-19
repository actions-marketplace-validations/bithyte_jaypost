import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vite-plus/test'
import { NO_AUTH } from '../../src/auth/index.ts'
import {
  DEFAULT_PORT,
  resolveConfigDirectory,
  resolveConfigPath,
  loadConfig,
  readConfigFile,
  updateConfigFile,
} from '../../src/config/index.ts'
import { PROVIDERS } from '../../src/provider/index.ts'
import { createFakeProvider } from '../provider/fake.ts'

const TELEGRAM = PROVIDERS[0]
const FILE_TOKEN = 'f'.repeat(43)
const ENV_TOKEN = 'e'.repeat(43)

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tab-config-'))
  file = join(dir, 'nested', 'config.json')
})

test('resolveConfigPath precedence: TELEGRAM_ASK_CONFIG > XDG_CONFIG_HOME > HOME', () => {
  expect(
    resolveConfigPath({ TELEGRAM_ASK_CONFIG: '/x/c.json', XDG_CONFIG_HOME: '/xdg', HOME: '/h' }),
  ).toBe('/x/c.json')
  expect(resolveConfigPath({ XDG_CONFIG_HOME: '/xdg', HOME: '/h' })).toBe(
    '/xdg/telegram-ask/config.json',
  )
  expect(resolveConfigPath({ HOME: '/h' })).toBe('/h/.config/telegram-ask/config.json')
  expect(resolveConfigPath({ TELEGRAM_ASK_CONFIG: '', XDG_CONFIG_HOME: '', HOME: '/h' })).toBe(
    '/h/.config/telegram-ask/config.json',
  )
})

test('save then load roundtrip, host defaults to 127.0.0.1', () => {
  updateConfigFile(file, { botToken: 'tok', ownerId: 7, port: 9000 })
  expect(loadConfig({ TELEGRAM_ASK_CONFIG: file })).toEqual({
    provider: TELEGRAM,
    settings: { botToken: 'tok', ownerId: 7 },
    port: 9000,
    host: '127.0.0.1',
    auth: NO_AUTH,
  })
})

test('port defaults to DEFAULT_PORT', () => {
  updateConfigFile(file, { botToken: 'tok', ownerId: 7, port: DEFAULT_PORT })
  expect(loadConfig({ TELEGRAM_ASK_CONFIG: file }).port).toBe(8787)
  expect(
    loadConfig({ BOT_TOKEN: 't', OWNER_ID: '1', TELEGRAM_ASK_CONFIG: join(dir, 'no') }).port,
  ).toBe(8787)
})

test('saved file has mode 0o600, including when it already existed', () => {
  updateConfigFile(file, { botToken: 'tok', ownerId: 7, port: 9000 })
  expect(statSync(file).mode & 0o777).toBe(0o600)
  const loose = join(dir, 'loose.json')
  writeFileSync(loose, '{}', { mode: 0o644 })
  updateConfigFile(loose, { botToken: 'tok', ownerId: 7, port: 9000 })
  expect(statSync(loose).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(loose, 'utf8')).botToken).toBe('tok')
})

test('env overrides file values; env-only config works with no file', () => {
  updateConfigFile(file, { botToken: 'filetok', ownerId: 1, port: 1111 })
  expect(
    loadConfig({
      TELEGRAM_ASK_CONFIG: file,
      BOT_TOKEN: 'envtok',
      OWNER_ID: '42',
      PORT: '2222',
      HOST: '0.0.0.0',
    }),
  ).toEqual({
    provider: TELEGRAM,
    settings: { botToken: 'envtok', ownerId: 42 },
    port: 2222,
    host: '0.0.0.0',
    auth: NO_AUTH,
  })
  expect(
    loadConfig({ TELEGRAM_ASK_CONFIG: join(dir, 'missing.json'), BOT_TOKEN: 't', OWNER_ID: '42' }),
  ).toEqual({
    provider: TELEGRAM,
    settings: { botToken: 't', ownerId: 42 },
    port: 8787,
    host: '127.0.0.1',
    auth: NO_AUTH,
  })
})

test('empty-string env vars count as unset', () => {
  updateConfigFile(file, { botToken: 'filetok', ownerId: 1, port: 1111 })
  expect(
    loadConfig({ TELEGRAM_ASK_CONFIG: file, BOT_TOKEN: '', OWNER_ID: '', PORT: '', HOST: '' }),
  ).toEqual({
    provider: TELEGRAM,
    settings: { botToken: 'filetok', ownerId: 1 },
    port: 1111,
    host: '127.0.0.1',
    auth: NO_AUTH,
  })
})

test('empty string in the file counts as missing', () => {
  const file = join(dir, 'empty.json')
  writeFileSync(file, JSON.stringify({ botToken: '' }))
  expect(() => loadConfig({ TELEGRAM_ASK_CONFIG: file, OWNER_ID: '1' })).toThrow(
    'missing bot token; run `telegram-ask init` to set up the bot (or set BOT_TOKEN)',
  )
})

test('missing token or non-integer OWNER_ID throws mentioning init', () => {
  const none = join(dir, 'none.json')
  expect(() => loadConfig({ TELEGRAM_ASK_CONFIG: none, OWNER_ID: '1' })).toThrow(
    'missing bot token; run `telegram-ask init` to set up the bot (or set BOT_TOKEN)',
  )
  expect(() => loadConfig({ TELEGRAM_ASK_CONFIG: none, BOT_TOKEN: 't', OWNER_ID: 'abc' })).toThrow(
    'invalid owner id; run `telegram-ask init` to set up the bot (or set OWNER_ID)',
  )
  expect(() => loadConfig({ TELEGRAM_ASK_CONFIG: none, BOT_TOKEN: 't', OWNER_ID: '1.5' })).toThrow(
    /telegram-ask init/,
  )
})

test('missing owner is undefined, not an error', () => {
  const none = join(dir, 'none.json')
  expect(loadConfig({ TELEGRAM_ASK_CONFIG: none, BOT_TOKEN: 't' }).settings).toEqual({
    botToken: 't',
  })
})

test('updateConfigFile merges, null deletes, keeps 0600', () => {
  updateConfigFile(file, { botToken: 'tok', port: 9000 })
  updateConfigFile(file, { ownerId: 42 })
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    botToken: 'tok',
    port: 9000,
    ownerId: 42,
  })
  updateConfigFile(file, { ownerId: null })
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ botToken: 'tok', port: 9000 })
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('updateConfigFile does not copy env values into the file', () => {
  updateConfigFile(file, { ownerId: 1 })
  loadConfig({ TELEGRAM_ASK_CONFIG: file, BOT_TOKEN: 'envtok' })
  expect(readConfigFile(file)).toEqual({ ownerId: 1 })
})

test('configDir is the directory of the default config path', () => {
  expect(resolveConfigDirectory({ XDG_CONFIG_HOME: '/xdg', HOME: '/h' })).toBe('/xdg/telegram-ask')
  expect(resolveConfigDirectory({ HOME: '/h' })).toBe('/h/.config/telegram-ask')
})

test.each(['0', '65536', '-1', 'abc', '80.5'])('invalid port %s throws', (p) => {
  expect(() =>
    loadConfig({
      TELEGRAM_ASK_CONFIG: join(dir, 'none.json'),
      BOT_TOKEN: 't',
      OWNER_ID: '1',
      PORT: p,
    }),
  ).toThrow(/port/i)
})

test('malformed config file gives readable error with path', () => {
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{"botToken": "SECRET123" oops')
  expect(() => loadConfig({ TELEGRAM_ASK_CONFIG: bad })).toThrow(bad)
  expect(() => loadConfig({ TELEGRAM_ASK_CONFIG: bad })).toThrow(/invalid JSON/)
  expect(() => loadConfig({ TELEGRAM_ASK_CONFIG: bad })).not.toThrow(/SECRET123/)
})

test('old config without provider loads as telegram', () => {
  updateConfigFile(file, { botToken: 't', ownerId: 42 })
  const config = loadConfig({ TELEGRAM_ASK_CONFIG: file })
  expect(config.provider.name).toBe('telegram')
  expect(config.settings).toEqual({ botToken: 't', ownerId: 42 })
})

test('PROVIDER env overrides the file provider', () => {
  const fake = createFakeProvider()
  updateConfigFile(file, { provider: 'telegram', fakeKey: 'k' })
  const config = loadConfig({ TELEGRAM_ASK_CONFIG: file, PROVIDER: 'fake' }, [TELEGRAM!, fake])
  expect(config.provider.name).toBe('fake')
})

test('unknown provider fails with the init hint', () => {
  updateConfigFile(file, { provider: 'nope' })
  expect(() => loadConfig({ TELEGRAM_ASK_CONFIG: file })).toThrow(
    'unknown provider "nope"; run `telegram-ask init`',
  )
})

test('fake provider settings load from env and file', () => {
  const fake = createFakeProvider()
  updateConfigFile(file, { provider: 'fake', fakeKey: 'filekey' })
  expect(loadConfig({ TELEGRAM_ASK_CONFIG: file }, [fake]).settings).toEqual({ fakeKey: 'filekey' })
  expect(loadConfig({ TELEGRAM_ASK_CONFIG: file, FAKE_KEY: 'envkey' }, [fake]).settings).toEqual({
    fakeKey: 'envkey',
  })
})

test('readConfigFile rethrows read errors other than a missing file', () => {
  expect(() => readConfigFile(dir)).toThrow(/EISDIR/)
})

test('api token comes from TELEGRAM_ASK_TOKEN, then apiToken in the file, else none', () => {
  updateConfigFile(file, { botToken: 'tok', apiToken: FILE_TOKEN })
  expect(loadConfig({ TELEGRAM_ASK_CONFIG: file, TELEGRAM_ASK_TOKEN: ENV_TOKEN }).auth).toEqual({
    kind: 'token',
    token: ENV_TOKEN,
  })
  expect(loadConfig({ TELEGRAM_ASK_CONFIG: file, TELEGRAM_ASK_TOKEN: '' }).auth).toEqual({
    kind: 'token',
    token: FILE_TOKEN,
  })
  updateConfigFile(file, { apiToken: null })
  expect(loadConfig({ TELEGRAM_ASK_CONFIG: file }).auth).toEqual(NO_AUTH)
})

test('an invalid api token throws without quoting it', () => {
  const message =
    'invalid api token; run `telegram-ask init` to set up the bot (or set TELEGRAM_ASK_TOKEN)'
  updateConfigFile(file, { botToken: 'tok' })
  const fromEnv = () =>
    loadConfig({ TELEGRAM_ASK_CONFIG: file, TELEGRAM_ASK_TOKEN: 'short-secret' })
  expect(fromEnv).toThrow(message)
  expect(fromEnv).not.toThrow(/short-secret/)
  updateConfigFile(file, { apiToken: 'short-secret' })
  const fromFile = () => loadConfig({ TELEGRAM_ASK_CONFIG: file })
  expect(fromFile).toThrow(message)
  expect(fromFile).not.toThrow(/short-secret/)
})
