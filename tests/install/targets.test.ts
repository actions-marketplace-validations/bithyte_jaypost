import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, expect, test } from 'vite-plus/test'
import { installPaths } from '../../src/install/paths.ts'
import { writeInstall } from '../../src/install/state.ts'
import type { TargetName } from '../../src/install/state.ts'
import type { Target } from '../../src/install/target.ts'
import {
  defaultTarget,
  detect,
  findExisting,
  findLeftoverSecrets,
  TARGET_ORDER,
} from '../../src/install/targets.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'targets-'))
})

function fake(name: TargetName, ok: boolean): Target {
  return {
    name,
    available: async () => (ok ? { ok: true } : { ok: false, reason: `${name} missing` }),
  } as Target
}

function fakes(ok: Record<TargetName, boolean>): Record<TargetName, Target> {
  return {
    systemd: fake('systemd', ok.systemd),
    compose: fake('compose', ok.compose),
    quadlet: fake('quadlet', ok.quadlet),
  }
}

test('order is quadlet, compose, systemd', () => {
  expect(TARGET_ORDER).toEqual(['quadlet', 'compose', 'systemd'])
})

test('default is quadlet when all ok', async () => {
  const d = await detect(fakes({ systemd: true, compose: true, quadlet: true }))
  expect(d.map((x) => x.name)).toEqual(['quadlet', 'compose', 'systemd'])
  expect(defaultTarget(d)).toBe('quadlet')
})

test('default is compose when podman missing', async () => {
  const d = await detect(fakes({ systemd: true, compose: true, quadlet: false }))
  expect(d[0]).toEqual({ name: 'quadlet', ok: false, reason: 'quadlet missing' })
  expect(defaultTarget(d)).toBe('compose')
})

test('default undefined when none ok', async () => {
  const d = await detect(fakes({ systemd: false, compose: false, quadlet: false }))
  expect(defaultTarget(d)).toBeUndefined()
})

test('legacy unit with no install.json', () => {
  const paths = installPaths({ HOME: tmp })
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Unit]\n')
  mkdirSync(paths.configDir, { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ port: 9000 }))
  const found = findExisting(paths, fakes({ systemd: true, compose: true, quadlet: true }), {
    HOME: tmp,
  })
  expect(found).toEqual({
    rec: { target: 'systemd', port: 9000, version: 'legacy', configFile: paths.configFile },
    legacy: true,
  })
})

test('legacy port defaults to 8787', () => {
  const paths = installPaths({ HOME: tmp })
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Unit]\n')
  const found = findExisting(paths, fakes({ systemd: true, compose: true, quadlet: true }), {
    HOME: tmp,
  })
  expect(found?.rec.port).toBe(8787)
})

test('legacy port honors APPROVAL_BOT_CONFIG', () => {
  const env = { HOME: tmp, APPROVAL_BOT_CONFIG: join(tmp, 'other.json') }
  writeFileSync(env.APPROVAL_BOT_CONFIG, JSON.stringify({ port: 9100 }))
  const paths = installPaths(env)
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Unit]\n')
  expect(
    findExisting(paths, fakes({ systemd: true, compose: true, quadlet: true }), env)?.rec.port,
  ).toBe(9100)
})

test('nothing found', () => {
  const paths = installPaths({ HOME: tmp })
  expect(
    findExisting(paths, fakes({ systemd: true, compose: true, quadlet: true }), { HOME: tmp }),
  ).toBeUndefined()
})

test('install.json wins over legacy unit', () => {
  const paths = installPaths({ HOME: tmp })
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Unit]\n')
  writeInstall(paths.installFile, { target: 'compose', port: 8800, version: '1.2.3' })
  const found = findExisting(paths, fakes({ systemd: true, compose: true, quadlet: true }), {
    HOME: tmp,
  })
  expect(found).toEqual({
    rec: { target: 'compose', port: 8800, version: '1.2.3' },
    legacy: false,
  })
})

test('legacy unit Environment=APPROVAL_BOT_CONFIG wins over the env', () => {
  const env = { HOME: tmp, APPROVAL_BOT_CONFIG: join(tmp, 'env.json') }
  const paths = installPaths(env)
  const pinned = join(tmp, 'pin ned.json')
  writeFileSync(pinned, JSON.stringify({ port: 9200 }))
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(
    paths.systemdUnit,
    `[Service]\nEnvironment="APPROVAL_BOT_CONFIG=${pinned}"\nExecStart=/n /c start\n`,
  )
  expect(findExisting(paths, fakes({ systemd: true, compose: true, quadlet: true }), env)).toEqual({
    rec: { target: 'systemd', port: 9200, version: 'legacy', configFile: pinned },
    legacy: true,
  })
})

test('leftover secrets: none', () => {
  expect(findLeftoverSecrets(installPaths({ HOME: tmp }), { HOME: tmp })).toEqual({})
})

test('leftover secrets from config.json (honoring APPROVAL_BOT_CONFIG)', () => {
  const env = { HOME: tmp, APPROVAL_BOT_CONFIG: join(tmp, 'c.json') }
  writeFileSync(env.APPROVAL_BOT_CONFIG, JSON.stringify({ botToken: 'ct', ownerId: 3 }))
  expect(findLeftoverSecrets(installPaths(env), env)).toEqual({ token: 'ct', ownerId: 3 })
})

test('leftover secrets from a container .env', () => {
  const paths = installPaths({ HOME: tmp })
  mkdirSync(paths.composeDir, { recursive: true })
  writeFileSync(join(paths.composeDir, '.env'), 'BOT_TOKEN=et\nPORT=1\nOWNER_ID=8\n')
  expect(findLeftoverSecrets(paths, { HOME: tmp })).toEqual({ token: 'et', ownerId: 8 })
  mkdirSync(paths.quadletDir, { recursive: true })
  writeFileSync(join(paths.quadletDir, '.env'), 'BOT_TOKEN=qt\nPORT=1\n')
  expect(findLeftoverSecrets(paths, { HOME: tmp })).toEqual({ token: 'qt' })
})

test('leftover secrets ignore corrupt config and token-less files', () => {
  const paths = installPaths({ HOME: tmp })
  mkdirSync(paths.configDir, { recursive: true })
  writeFileSync(paths.configFile, '{oops')
  mkdirSync(paths.quadletDir, { recursive: true })
  writeFileSync(join(paths.quadletDir, '.env'), 'PORT=1\nOWNER_ID=2\n')
  expect(findLeftoverSecrets(paths, { HOME: tmp })).toEqual({})
})
