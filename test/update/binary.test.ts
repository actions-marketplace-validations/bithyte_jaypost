import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import type { Exec } from '../../src/system/index.ts'
import { replaceBinary, type LatestRelease } from '../../src/update/index.ts'

const ASSET = 'telegram-ask-linux-x64.gz'
const NEW_BINARY = Buffer.from('#!/bin/sh\necho new\n')
const OLD_BINARY = 'old binary'
const GZIPPED = gzipSync(NEW_BINARY)

let server: Server | undefined
let directory = ''
let destination = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'update-binary-'))
  destination = join(directory, 'telegram-ask')
  writeFileSync(destination, OLD_BINARY, { mode: 0o644 })
})

afterEach(() => {
  server?.closeAllConnections()
  server?.close()
  server = undefined
  rmSync(directory, { recursive: true, force: true })
})

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const reportsVersion =
  (stdout: string): Exec =>
  async () => ({ code: 0, stdout, stderr: '' })

async function serve(
  files: Readonly<Record<string, Buffer | string>>,
  hang = false,
): Promise<string> {
  server = createServer((request, response) => {
    const body = files[request.url ?? '']
    if (hang || body === undefined) {
      if (!hang) {
        response.writeHead(404).end()
      }
      return
    }
    response.writeHead(200).end(body)
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function releaseAt(base: string, assets: readonly string[]): LatestRelease {
  return {
    version: '0.5.0',
    assets: Object.fromEntries(assets.map((name) => [name, `${base}/${name}`])),
  }
}

function assertUntouched(): void {
  expect(readFileSync(destination, 'utf8')).toBe(OLD_BINARY)
  expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([])
}

test('replaces the destination with the verified binary', async () => {
  const base = await serve({
    '/SHA256SUMS': `${sha256(GZIPPED)}  ${ASSET}\n`,
    [`/${ASSET}`]: GZIPPED,
  })
  const inodeBefore = statSync(destination).ino
  await replaceBinary({
    release: releaseAt(base, ['SHA256SUMS', ASSET]),
    assetName: ASSET,
    destination,
    exec: reportsVersion('0.5.0\n'),
  })
  expect(readFileSync(destination)).toEqual(NEW_BINARY)
  expect(statSync(destination).mode & 0o777).toBe(0o755)
  expect(statSync(destination).ino).not.toBe(inodeBefore)
  expect(readdirSync(directory)).toEqual(['telegram-ask'])
})

test('refuses a missing asset', async () => {
  const base = await serve({ '/SHA256SUMS': '' })
  await expect(
    replaceBinary({
      release: releaseAt(base, ['SHA256SUMS']),
      assetName: ASSET,
      destination,
      exec: reportsVersion('0.5.0\n'),
    }),
  ).rejects.toThrow('no telegram-ask-linux-x64.gz on release 0.5.0 yet')
  assertUntouched()
})

test('refuses a missing checksum entry', async () => {
  const base = await serve({
    '/SHA256SUMS': `${sha256(GZIPPED)}  other.gz\n`,
    [`/${ASSET}`]: GZIPPED,
  })
  await expect(
    replaceBinary({
      release: releaseAt(base, ['SHA256SUMS', ASSET]),
      assetName: ASSET,
      destination,
      exec: reportsVersion('0.5.0\n'),
    }),
  ).rejects.toThrow('checksum')
  assertUntouched()
})

test('refuses a checksum mismatch', async () => {
  const base = await serve({
    '/SHA256SUMS': `${sha256(Buffer.from('something else'))}  ${ASSET}\n`,
    [`/${ASSET}`]: GZIPPED,
  })
  await expect(
    replaceBinary({
      release: releaseAt(base, ['SHA256SUMS', ASSET]),
      assetName: ASSET,
      destination,
      exec: reportsVersion('0.5.0\n'),
    }),
  ).rejects.toThrow('checksum')
  assertUntouched()
})

test('refuses a binary that reports another version', async () => {
  const base = await serve({
    '/SHA256SUMS': `${sha256(GZIPPED)}  ${ASSET}\n`,
    [`/${ASSET}`]: GZIPPED,
  })
  await expect(
    replaceBinary({
      release: releaseAt(base, ['SHA256SUMS', ASSET]),
      assetName: ASSET,
      destination,
      exec: reportsVersion('0.4.0\n'),
    }),
  ).rejects.toThrow('0.4.0')
  assertUntouched()
})

test('stops when aborted', async () => {
  const base = await serve({}, true)
  const controller = new AbortController()
  const pending = replaceBinary({
    release: releaseAt(base, ['SHA256SUMS', ASSET]),
    assetName: ASSET,
    destination,
    exec: reportsVersion('0.5.0\n'),
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 50)
  await expect(pending).rejects.toThrow()
  assertUntouched()
})
