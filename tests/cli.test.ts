import { expect, test, vi } from 'vitest'
import { main } from '../src/cli.ts'
import { VERSION } from '../src/version.ts'

test('unknown command returns 2', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await main(['nope'])).toBe(2)
})

test('--version prints VERSION', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(await main(['--version'])).toBe(0)
  expect(log).toHaveBeenCalledWith(VERSION)
})

test('unbuilt subcommand returns 1', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await main(['status'])).toBe(1)
})

test('init rejects bad port and unknown target with 2', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await main(['init', '--port', 'abc'])).toBe(2)
  expect(await main(['init', '--port', '70000'])).toBe(2)
  expect(await main(['init', 'nope'])).toBe(2)
})
