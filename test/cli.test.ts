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
