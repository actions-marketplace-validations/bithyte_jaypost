import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { parse } from 'yaml'
import { main } from '../src/cli.ts'
import { VERSION } from '../src/config/index.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

test('unknown command returns 2', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['nope'])).toBe(2)
})

test('--version prints VERSION', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect(await main(['--version'])).toBe(0)
  expect(write).toHaveBeenCalledWith(`${VERSION}\n`)
})

test('init rejects bad port and unknown target with 2', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['init', '--port', 'abc'])).toBe(2)
  expect(await main(['init', '--port', '70000'])).toBe(2)
  expect(await main(['init', 'nope'])).toBe(2)
})

test('init --help lists --provider', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect(await main(['init', '--help'])).toBe(0)
  expect(write.mock.calls.map((call) => String(call[0])).join('')).toContain('--provider <name>')
})

test('init --help lists --token and --no-token', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect(await main(['init', '--help'])).toBe(0)
  const help = write.mock.calls.map((call) => String(call[0])).join('')
  expect(help).toContain('--token ')
  expect(help).toContain('--no-token')
})

test('mcp rejects a bad port with 2', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['mcp', '--port', 'abc'])).toBe(2)
})

test('send request requires options and timeout option, and rejects a bad timeout', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['send', 'request', 'Deploy?', '--timeout-option', 'No'])).toBe(2)
  expect(await main(['send', 'request', 'Deploy?', '-o', 'Yes', '-o', 'No'])).toBe(2)
  const ask = ['send', 'request', 'Deploy?', '-o', 'Yes', '--timeout-option', 'Yes']
  expect(await main([...ask, '--timeout', '0'])).toBe(2)
  expect(await main([...ask, '--timeout', 'soon'])).toBe(2)
})

test('send notify requires text', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['send', 'notify'])).toBe(2)
})

test('hook rejects a bad port, a bad timeout and positional arguments with 2', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['hook', '--port', 'abc'])).toBe(2)
  expect(await main(['hook', '--timeout', '0'])).toBe(2)
  expect(await main(['hook', 'extra'])).toBe(2)
})

test('send exits 1 with the message on an invalid TELEGRAM_ASK_TOKEN', async () => {
  vi.stubEnv('TELEGRAM_ASK_TOKEN', 'short-secret')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await main(['send', 'notify', 'hi', '--port', '1'])).toBe(1)
  expect(error).toHaveBeenCalledWith(
    "telegram-ask: TELEGRAM_ASK_TOKEN isn't a valid telegram-ask token",
  )
})

test('openapi writes the spec with the given port to a file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-ask-openapi-'))
  try {
    const file = join(directory, 'openapi.yaml')
    expect(await main(['openapi', '--port', '9999', file])).toBe(0)
    expect(parse(readFileSync(file, 'utf8')).servers).toEqual([{ url: 'http://127.0.0.1:9999' }])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('openapi prints the spec without a file', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect(await main(['openapi', '--port', '9999'])).toBe(0)
  expect(String(write.mock.calls[0]?.[0])).toMatch(/^openapi: 3\.1\.0\n/)
})

test('openapi returns 1 when the file cannot be written', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await main(['openapi', '/nonexistent-directory/openapi.yaml'])).toBe(1)
})
