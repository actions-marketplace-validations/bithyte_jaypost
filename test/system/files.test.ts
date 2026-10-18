import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vite-plus/test'
import { writeFileAtomic } from '../../src/system/index.ts'

function createTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'files-test-'))
}

test('writeFileAtomic creates parent directories and writes the content with the given mode', () => {
  const root = createTempDirectory()
  const path = join(root, 'nested', 'deeper', 'secret.json')
  writeFileAtomic(path, 'hello\n', 0o600)
  expect(readFileSync(path, 'utf8')).toBe('hello\n')
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('replacing a file gives it a new inode and leaves no temp file behind', () => {
  const root = createTempDirectory()
  const path = join(root, 'secret.json')
  writeFileAtomic(path, 'first', 0o600)
  const inodeBefore = statSync(path).ino
  writeFileAtomic(path, 'second', 0o600)
  expect(statSync(path).ino).not.toBe(inodeBefore)
  expect(readFileSync(path, 'utf8')).toBe('second')
  expect(readdirSync(root)).toEqual(['secret.json'])
})

test('a failed rename throws, keeps the old target and removes the temp file', () => {
  const root = createTempDirectory()
  const path = join(root, 'target')
  mkdirSync(path)
  writeFileSync(join(path, 'marker'), 'keep')
  expect(() => writeFileAtomic(path, 'new', 0o600)).toThrow()
  expect(statSync(path).isDirectory()).toBe(true)
  expect(readFileSync(join(path, 'marker'), 'utf8')).toBe('keep')
  expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
})
