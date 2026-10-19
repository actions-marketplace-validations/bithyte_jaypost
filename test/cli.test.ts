import { expect, test, vi } from 'vitest'
import { main } from '../src/cli.ts'
import { VERSION } from '../src/config/index.ts'

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
