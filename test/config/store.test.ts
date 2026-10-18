import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vite-plus/test'
import {
  DEFAULT_PORT,
  resolveConfigDirectory,
  resolveConfigPath,
  loadConfig,
  readConfigFile,
  updateConfigFile,
} from '../../src/config/index.ts'

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
    botToken: 'tok',
    ownerId: 7,
    port: 9000,
    host: '127.0.0.1',
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
  ).toEqual({ botToken: 'envtok', ownerId: 42, port: 2222, host: '0.0.0.0' })
  expect(
    loadConfig({ TELEGRAM_ASK_CONFIG: join(dir, 'missing.json'), BOT_TOKEN: 't', OWNER_ID: '42' }),
  ).toEqual({ botToken: 't', ownerId: 42, port: 8787, host: '127.0.0.1' })
})

test('empty-string env vars count as unset', () => {
  updateConfigFile(file, { botToken: 'filetok', ownerId: 1, port: 1111 })
  expect(
    loadConfig({ TELEGRAM_ASK_CONFIG: file, BOT_TOKEN: '', OWNER_ID: '', PORT: '', HOST: '' }),
  ).toEqual({ botToken: 'filetok', ownerId: 1, port: 1111, host: '127.0.0.1' })
})

test('missing token or non-integer OWNER_ID throws mentioning init', () => {
  const none = join(dir, 'none.json')
  expect(() => loadConfig({ TELEGRAM_ASK_CONFIG: none, OWNER_ID: '1' })).toThrow(
    /telegram-ask init/,
  )
  expect(() => loadConfig({ TELEGRAM_ASK_CONFIG: none, BOT_TOKEN: 't', OWNER_ID: 'abc' })).toThrow(
    /telegram-ask init/,
  )
  expect(() => loadConfig({ TELEGRAM_ASK_CONFIG: none, BOT_TOKEN: 't', OWNER_ID: '1.5' })).toThrow(
    /telegram-ask init/,
  )
})

test('missing owner is undefined, not an error', () => {
  const none = join(dir, 'none.json')
  expect(loadConfig({ TELEGRAM_ASK_CONFIG: none, BOT_TOKEN: 't' }).ownerId).toBeUndefined()
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

test('readConfigFile rethrows read errors other than a missing file', () => {
  expect(() => readConfigFile(dir)).toThrow(/EISDIR/)
})
