import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vite-plus/test'
import { runInit } from '../../src/commands/init.ts'
import type { InitDeps } from '../../src/commands/init.ts'
import { PromptAborted } from '../../src/install/prompt.ts'
import { installPaths } from '../../src/install/paths.ts'
import type { InstallPaths } from '../../src/install/paths.ts'
import { readInstall, writeInstall } from '../../src/install/state.ts'
import type { TargetName } from '../../src/install/state.ts'
import type { Target } from '../../src/install/target.ts'

let tmp: string
let paths: InstallPaths
let order: string[]
let out: string[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'init-'))
  paths = installPaths({ HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') })
  order = []
  out = []
})

function fake(name: TargetName, ok = true, secrets = {}): Target {
  return {
    name,
    available: vi.fn(async () =>
      ok ? { ok: true as const } : { ok: false as const, reason: `${name} missing` },
    ),
    install: vi.fn(async (o) => {
      order.push(`install:${name}`)
      return { target: name, port: o.port, version: o.version }
    }),
    readSecrets: vi.fn(async () => secrets),
    remove: vi.fn(async () => {
      order.push('remove')
    }),
    restart: vi.fn(),
    clearOwner: vi.fn(),
    isRunning: vi.fn(async () => true),
    logsHint: vi.fn(() => `logs for ${name}`),
  } as unknown as Target
}

function deps(over: Partial<InitDeps> & { targets?: Record<TargetName, Target> } = {}): InitDeps {
  return {
    targets: { quadlet: fake('quadlet'), compose: fake('compose'), systemd: fake('systemd') },
    paths,
    prompt: {
      ask: vi.fn(async () => 'y'),
      askSecret: vi.fn(async () => 'good-token'),
      choose: vi.fn(async (_q, _o, def) => def),
    },
    validateToken: vi.fn(async () => 'mybot'),
    portFree: vi.fn(async () => {
      order.push('port')
      return true
    }),
    wait: vi.fn(async () => 'paired' as const),
    print: (s) => out.push(s),
    version: '1.2.3',
    ...over,
  }
}

function seed(target: TargetName, port = 9000) {
  writeInstall(paths.installFile, { target, port, version: '1.0.0' })
}

test('fresh install: default target, default port, writes install record', async () => {
  const d = deps()
  expect(await runInit({}, d)).toBe(0)
  expect(d.prompt.choose).toHaveBeenCalled()
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ port: 8787, token: 'good-token', version: '1.2.3' }),
  )
  expect(readInstall(paths.installFile)?.target).toBe('quadlet')
  expect(out.join('\n')).toContain('Done. Try it: telegram-approval-bot test')
})

test('replace: reads secrets, removes old without purge, checks port after removal, reuses token and owner', async () => {
  seed('compose')
  const old = fake('compose', true, { token: 't', ownerId: 42 })
  const d = deps({
    targets: { quadlet: fake('quadlet'), compose: old, systemd: fake('systemd') },
  })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(0)
  expect(order).toEqual(['remove', 'port', 'install:quadlet'])
  expect(old.remove).toHaveBeenCalledWith(expect.objectContaining({ target: 'compose' }), false)
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ token: 't', ownerId: 42, port: 9000 }),
  )
  expect(d.prompt.askSecret).not.toHaveBeenCalled()
  expect(d.validateToken).toHaveBeenCalledWith('t')
})

test('declining replace changes nothing', async () => {
  seed('compose')
  const old = fake('compose', true, { token: 't' })
  const d = deps({
    targets: { quadlet: fake('quadlet'), compose: old, systemd: fake('systemd') },
  })
  d.prompt.ask = vi.fn(async () => 'n')
  expect(await runInit({}, d)).toBe(0)
  expect(old.remove).not.toHaveBeenCalled()
  expect(old.readSecrets).not.toHaveBeenCalled()
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
  expect(readInstall(paths.installFile)?.target).toBe('compose')
})

test('requested target unavailable returns 1 with the reason', async () => {
  const d = deps({
    targets: {
      quadlet: fake('quadlet', false),
      compose: fake('compose'),
      systemd: fake('systemd'),
    },
  })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(1)
  expect(out.join('\n')).toContain('quadlet missing')
  expect(d.targets.compose.install).not.toHaveBeenCalled()
})

test('no target available returns 1 with reasons', async () => {
  const d = deps({
    targets: {
      quadlet: fake('quadlet', false),
      compose: fake('compose', false),
      systemd: fake('systemd', false),
    },
  })
  expect(await runInit({}, d)).toBe(1)
  expect(out.join('\n')).toContain('compose missing')
})

test('invalid token reprompts without echoing Telegram errors', async () => {
  const validate = vi
    .fn()
    .mockRejectedValueOnce(new Error('ECONNREFUSED api.telegram.org SECRET-ERR'))
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce('mybot')
  const secret = vi
    .fn()
    .mockResolvedValueOnce('bad-token-1')
    .mockResolvedValueOnce('bad-token-2')
    .mockResolvedValueOnce('good-token')
  const d = deps({ validateToken: validate })
  d.prompt.askSecret = secret
  // first call rejects: validateToken is documented to never throw, but be safe
  expect(await runInit({}, d)).toBe(0)
  expect(secret).toHaveBeenCalledTimes(3)
  const text = out.join('\n')
  expect(text).toContain('Telegram rejected that token (or could not be reached). Try again.')
  expect(text).not.toContain('SECRET-ERR')
  expect(text).not.toContain('ECONNREFUSED')
  for (const t of ['bad-token-1', 'bad-token-2', 'good-token']) expect(text).not.toContain(t)
})

test('stored token invalid falls back to prompt', async () => {
  seed('compose')
  const old = fake('compose', true, { token: 'stale' })
  const validate = vi.fn(async (t: string) => (t === 'stale' ? undefined : 'mybot'))
  const d = deps({
    targets: { quadlet: fake('quadlet'), compose: old, systemd: fake('systemd') },
    validateToken: validate,
  })
  expect(await runInit({}, d)).toBe(0)
  expect(d.prompt.askSecret).toHaveBeenCalledTimes(1)
  expect(out.join('\n')).not.toContain('stale')
})

test('port in use returns 1 before install', async () => {
  const d = deps({ portFree: vi.fn(async () => false) })
  expect(await runInit({ port: 9999 }, d)).toBe(1)
  expect(out.join('\n')).toContain('Port 9999 is in use. Pick another with --port.')
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('interrupted wait returns 130 and leaves the service', async () => {
  const d = deps({ wait: vi.fn(async () => 'interrupted' as const) })
  expect(await runInit({}, d)).toBe(130)
  expect(order).toEqual(['port', 'install:quadlet'])
  expect(d.targets.quadlet.remove).not.toHaveBeenCalled()
  expect(readInstall(paths.installFile)?.target).toBe('quadlet')
})

test('not-started and stopped return 1 with logs hint', async () => {
  for (const r of ['not-started', 'stopped'] as const) {
    out = []
    const d = deps({ wait: vi.fn(async () => r) })
    expect(await runInit({}, d)).toBe(1)
    expect(out.join('\n')).toContain('logs for quadlet')
  }
})

test('legacy systemd unit is replaced and its config reused', async () => {
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Service]\n')
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ port: 9123 }))
  const old = fake('systemd', true, { token: 'lt', ownerId: 7 })
  const d = deps({
    targets: { quadlet: fake('quadlet'), compose: fake('compose'), systemd: old },
  })
  expect(await runInit({ target: 'systemd' }, d)).toBe(0)
  expect(out.join('\n').toLowerCase()).toContain('legacy')
  expect(order).toEqual(['remove', 'port', 'install:systemd'])
  expect(old.install).toHaveBeenCalledWith(
    expect.objectContaining({ token: 'lt', ownerId: 7, port: 9123 }),
  )
  expect(existsSync(paths.installFile)).toBe(true)
})

test('passes tarball and signal through', async () => {
  const ac = new AbortController()
  const d = deps({ signal: ac.signal })
  await runInit({ tarball: '/x/y.tgz' }, d)
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ tarball: '/x/y.tgz' }),
  )
  expect(d.wait).toHaveBeenCalledWith(expect.objectContaining({ signal: ac.signal, port: 8787 }))
})

test('Ctrl-C at target choose returns 130, nothing installed', async () => {
  const d = deps()
  d.prompt.choose = vi.fn(async () => {
    throw new PromptAborted()
  })
  expect(await runInit({}, d)).toBe(130)
  expect(order).toEqual([])
})

test('Ctrl-C at Replace prompt returns 130 before any remove', async () => {
  seed('compose')
  const old = fake('compose', true, { token: 't' })
  const d = deps({ targets: { quadlet: fake('quadlet'), compose: old, systemd: fake('systemd') } })
  d.prompt.ask = vi.fn(async () => {
    throw new PromptAborted()
  })
  expect(await runInit({}, d)).toBe(130)
  expect(old.remove).not.toHaveBeenCalled()
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('Ctrl-C at token prompt returns 130, no install', async () => {
  const d = deps()
  d.prompt.askSecret = vi.fn(async () => {
    throw new PromptAborted()
  })
  expect(await runInit({}, d)).toBe(130)
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('EOF in token loop terminates', async () => {
  const d = deps({ validateToken: vi.fn(async () => undefined) })
  let n = 0
  d.prompt.askSecret = vi.fn(async () => {
    if (++n > 1) throw new PromptAborted()
    return 'bad'
  })
  expect(await runInit({}, d)).toBe(130)
  expect(n).toBe(2)
})

test('aborted signal stops the token loop before prompting', async () => {
  const ac = new AbortController()
  ac.abort()
  const d = deps({ signal: ac.signal })
  expect(await runInit({}, d)).toBe(130)
  expect(d.prompt.askSecret).not.toHaveBeenCalled()
})

test('install throwing returns 1 with generic message, no secrets', async () => {
  const d = deps()
  d.targets.quadlet.install = vi.fn(async () => {
    throw new Error('boom good-token')
  })
  expect(await runInit({}, d)).toBe(1)
  const text = out.join('\n')
  expect(text).toContain('run telegram-approval-bot init again')
  expect(text).not.toContain('good-token')
})

test('old remove throwing returns 1, no install', async () => {
  seed('compose')
  const old = fake('compose', true, { token: 't' })
  old.remove = vi.fn(async () => {
    throw new Error('nope')
  })
  const d = deps({ targets: { quadlet: fake('quadlet'), compose: old, systemd: fake('systemd') } })
  expect(await runInit({}, d)).toBe(1)
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})
