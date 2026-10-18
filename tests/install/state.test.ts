import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import { readInstall, removeInstall, writeInstall } from '../../src/install/state.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tab-state-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('roundtrip with mode 0600, creates parent dir', () => {
  const file = join(dir, 'sub', 'install.json')
  const rec = { target: 'systemd', port: 8787, version: '1.0.0', cliPath: '/x/cli' } as const
  writeInstall(file, rec)
  expect(readInstall(file)).toEqual(rec)
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('missing file is undefined', () => {
  expect(readInstall(join(dir, 'nope.json'))).toBeUndefined()
})

test('garbage or wrong-shape is undefined', () => {
  const file = join(dir, 'install.json')
  writeFileSync(file, '{not json')
  expect(readInstall(file)).toBeUndefined()
  writeFileSync(file, JSON.stringify({ target: 'bogus', port: 1, version: 'v' }))
  expect(readInstall(file)).toBeUndefined()
})

test('removeInstall deletes, tolerates missing', () => {
  const file = join(dir, 'install.json')
  writeInstall(file, { target: 'compose', port: 1, version: 'v' })
  removeInstall(file)
  expect(existsSync(file)).toBe(false)
  removeInstall(file)
})

test('configFile roundtrips and is optional', () => {
  const file = join(dir, 'install.json')
  const rec = { target: 'systemd', port: 1, version: 'v', configFile: '/abs/c.json' } as const
  writeInstall(file, rec)
  expect(readInstall(file)).toEqual(rec)
  writeFileSync(file, JSON.stringify({ target: 'systemd', port: 1, version: 'v' }))
  expect(readInstall(file)).toEqual({ target: 'systemd', port: 1, version: 'v' })
  writeFileSync(file, JSON.stringify({ target: 'systemd', port: 1, version: 'v', configFile: 3 }))
  expect(readInstall(file)).toBeUndefined()
})
