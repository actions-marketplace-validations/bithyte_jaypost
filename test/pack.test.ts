import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vite-plus/test'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('cjs build exposes the client to require()', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-ask-pack-'))
  directories.push(directory)
  const result = spawnSync(join('node_modules', '.bin', 'vp'), ['pack', '--out-dir', directory], {
    encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(directory, 'index.d.cts'))).toBe(true)
  expect(readFileSync(join(directory, 'index.cjs'), 'utf8')).not.toMatch(
    /grammy|@clack|commander|fastify/,
  )
  const library = createRequire(import.meta.url)(join(directory, 'index.cjs'))
  expect(Object.keys(library).toSorted()).toEqual([
    'Client',
    'TelegramAskError',
    'escapeMarkdown',
    'formatCodeBlock',
  ])
  expect(new library.Client({ port: 9 })).toBeInstanceOf(library.Client)
  expect(new library.TelegramAskError('boom')).toBeInstanceOf(Error)
}, 30_000)
