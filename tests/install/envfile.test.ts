import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vite-plus/test'
import { readEnvFile, removeEnvKey, writeEnvFile } from '../../src/install/envfile.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'env-'))

test('roundtrip with mode 0600', () => {
  const f = join(dir(), '.env')
  writeEnvFile(f, 'BOT_TOKEN=a=b\nPORT=1\n')
  expect(readEnvFile(f)).toEqual({ BOT_TOKEN: 'a=b', PORT: '1' })
  expect(statSync(f).mode & 0o777).toBe(0o600)
})

test('missing file reads as empty', () => {
  expect(readEnvFile(join(dir(), 'nope'))).toEqual({})
})

test('removeEnvKey keeps other lines and mode', () => {
  const f = join(dir(), '.env')
  writeEnvFile(f, 'BOT_TOKEN=t\nOWNER_ID=5\nPORT=1\n')
  removeEnvKey(f, 'OWNER_ID')
  expect(readFileSync(f, 'utf8')).toBe('BOT_TOKEN=t\nPORT=1\n')
  expect(statSync(f).mode & 0o777).toBe(0o600)
})

test('removeEnvKey on missing file is a no-op', () => {
  removeEnvKey(join(dir(), 'nope'), 'X')
})

test('ignores comments and blanks', () => {
  const f = join(dir(), '.env')
  writeFileSync(f, '# c\n\nA=1\n')
  expect(readEnvFile(f)).toEqual({ A: '1' })
})
