import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vite-plus/test'
import { PromptAborted, runInit } from '../../src/commands/index.ts'
import type { InitDeps } from '../../src/commands/index.ts'
import { resolveInstallPaths, readInstall, writeInstall } from '../../src/install/index.ts'
import type { InstallPaths, Secrets, Target, TargetName } from '../../src/install/index.ts'
import type { CredentialCheck, Provider, SettingValues } from '../../src/provider/index.ts'
import { telegramProvider } from '../../src/telegram/index.ts'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

let tmp: string
let paths: InstallPaths
let order: string[]
let out: string[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'init-'))
  paths = resolveInstallPaths({ HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') })
  order = []
  out = []
})

const ACCEPTED: CredentialCheck = { ok: true, displayName: '@mybot' }
const REJECTED: CredentialCheck = { ok: false, reason: 'rejected' }
const NO_SECRETS: Secrets = { provider: 'telegram', settings: {} }

function telegram(
  checkCredentials: (settings: SettingValues) => Promise<CredentialCheck> = vi.fn(
    async () => ACCEPTED,
  ),
): Provider {
  return { ...telegramProvider, setup: { ...telegramProvider.setup, checkCredentials } }
}

function checkOf(d: InitDeps) {
  return d.providers[0]!.setup.checkCredentials
}

function saved(settings: SettingValues): Secrets {
  return { provider: 'telegram', settings }
}

function fake(name: TargetName, ok = true, secrets: Secrets = NO_SECRETS): Mutable<Target> {
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
  } as unknown as Mutable<Target>
}

function deps(over: Partial<InitDeps> & { targets?: Record<TargetName, Target> } = {}): InitDeps {
  return {
    targets: { quadlet: fake('quadlet'), compose: fake('compose'), systemd: fake('systemd') },
    paths,
    prompt: {
      confirm: vi.fn(async () => true),
      password: vi.fn(async () => 'good-token'),
      select: vi.fn(async (_q, _o, initialValue) => initialValue),
    },
    providers: [telegram()],
    isPortFree: vi.fn(async () => {
      order.push('port')
      return true
    }),
    wait: vi.fn(async () => 'paired' as const),
    print: (s) => out.push(s),
    version: '1.2.3',
    env: {},
    ...over,
  }
}

function seed(target: TargetName, port = 9000) {
  writeInstall(paths.installFile, { target, port, version: '1.0.0' })
}

test('fresh install: default target, default port, writes install record', async () => {
  const d = deps()
  expect(await runInit({}, d)).toBe(0)
  expect(d.prompt.select).toHaveBeenCalled()
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ port: 8787, settings: { botToken: 'good-token' }, version: '1.2.3' }),
  )
  expect(readInstall(paths.installFile)?.target).toBe('quadlet')
  expect(out.join('\n')).toContain('Done. Try it: telegram-ask test')
})

test('replace: reads secrets, removes old without purge, checks port after removal, reuses token and owner', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 't', ownerId: 42 }))
  const d = deps({
    targets: { quadlet: fake('quadlet'), compose: old, systemd: fake('systemd') },
  })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(0)
  expect(order).toEqual(['remove', 'port', 'install:quadlet'])
  expect(old.remove).toHaveBeenCalledWith(expect.objectContaining({ target: 'compose' }), false)
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { botToken: 't', ownerId: 42 }, port: 9000 }),
  )
  expect(d.prompt.password).not.toHaveBeenCalled()
  expect(checkOf(d)).toHaveBeenCalledWith({ botToken: 't', ownerId: 42 })
})

test('declining replace changes nothing', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 't' }))
  const d = deps({
    targets: { quadlet: fake('quadlet'), compose: old, systemd: fake('systemd') },
  })
  vi.mocked(d.prompt.confirm).mockImplementation(async () => false)
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
    .mockResolvedValueOnce(REJECTED)
    .mockResolvedValueOnce(ACCEPTED)
  const secret = vi
    .fn()
    .mockResolvedValueOnce('bad-token-1')
    .mockResolvedValueOnce('bad-token-2')
    .mockResolvedValueOnce('good-token')
  const d = deps({ providers: [telegram(validate)] })
  vi.mocked(d.prompt.password).mockImplementation(secret)
  // first call rejects: checkCredentials is documented to never throw, but be safe
  expect(await runInit({}, d)).toBe(0)
  expect(secret).toHaveBeenCalledTimes(3)
  const text = out.join('\n')
  expect(text).toContain('Telegram rejected that token (or could not be reached). Try again.')
  expect(text).not.toContain('SECRET-ERR')
  expect(text).not.toContain('ECONNREFUSED')
  for (const t of ['bad-token-1', 'bad-token-2', 'good-token']) {
    expect(text).not.toContain(t)
  }
})

test('stored token invalid falls back to prompt', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 'stale' }))
  const validate = vi.fn(async (settings: SettingValues) =>
    settings.botToken === 'stale' ? REJECTED : ACCEPTED,
  )
  const d = deps({
    targets: { quadlet: fake('quadlet'), compose: old, systemd: fake('systemd') },
    providers: [telegram(validate)],
  })
  expect(await runInit({}, d)).toBe(0)
  expect(d.prompt.password).toHaveBeenCalledTimes(1)
  expect(out.join('\n')).not.toContain('stale')
})

test('port in use returns 1 before install', async () => {
  const d = deps({ isPortFree: vi.fn(async () => false) })
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
  for (const r of ['notStarted', 'stopped'] as const) {
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
  const old = fake('systemd', true, saved({ botToken: 'lt', ownerId: 7 }))
  const d = deps({
    targets: { quadlet: fake('quadlet'), compose: fake('compose'), systemd: old },
  })
  expect(await runInit({ target: 'systemd' }, d)).toBe(0)
  expect(out.join('\n').toLowerCase()).toContain('legacy')
  expect(order).toEqual(['remove', 'port', 'install:systemd'])
  expect(old.install).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { botToken: 'lt', ownerId: 7 }, port: 9123 }),
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

test('Ctrl-C at target select returns 130, nothing installed', async () => {
  const d = deps()
  vi.mocked(d.prompt.select).mockImplementation(async () => {
    throw new PromptAborted()
  })
  expect(await runInit({}, d)).toBe(130)
  expect(order).toEqual([])
})

test('Ctrl-C at Replace prompt returns 130 before any remove', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 't' }))
  const d = deps({ targets: { quadlet: fake('quadlet'), compose: old, systemd: fake('systemd') } })
  vi.mocked(d.prompt.confirm).mockImplementation(async () => {
    throw new PromptAborted()
  })
  expect(await runInit({}, d)).toBe(130)
  expect(old.remove).not.toHaveBeenCalled()
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('Ctrl-C at token prompt returns 130, no install', async () => {
  const d = deps()
  vi.mocked(d.prompt.password).mockImplementation(async () => {
    throw new PromptAborted()
  })
  expect(await runInit({}, d)).toBe(130)
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('EOF in token loop terminates', async () => {
  const d = deps({ providers: [telegram(vi.fn(async () => REJECTED))] })
  let n = 0
  vi.mocked(d.prompt.password).mockImplementation(async () => {
    if (++n > 1) {
      throw new PromptAborted()
    }
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
  expect(d.prompt.password).not.toHaveBeenCalled()
})

test('install throwing returns 1 with generic message, no secrets', async () => {
  const d = deps()
  vi.mocked(d.targets.quadlet.install).mockImplementation(async () => {
    throw new Error('boom good-token')
  })
  expect(await runInit({}, d)).toBe(1)
  const text = out.join('\n')
  expect(text).toContain('Install failed: boom ***')
  expect(text).toContain('Run telegram-ask init again')
  expect(text).not.toContain('good-token')
})

test('old remove throwing returns 1, no install', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 't' }))
  old.remove = vi.fn(async () => {
    throw new Error('nope')
  })
  const d = deps({ targets: { quadlet: fake('quadlet'), compose: old, systemd: fake('systemd') } })
  expect(await runInit({}, d)).toBe(1)
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('target error message is shown with a reused token redacted', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: '123:SECRET' }))
  const d = deps({ targets: { quadlet: fake('quadlet'), compose: old, systemd: fake('systemd') } })
  vi.mocked(d.targets.quadlet.install).mockImplementation(async () => {
    throw new Error('npm install failed: bad url https://x/bot123:SECRET/getMe')
  })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(1)
  const text = out.join('\n')
  expect(text).toContain('npm install failed: bad url https://x/bot***/getMe')
  expect(text).not.toContain('123:SECRET')
})

test('failure after removing the old target keeps install.json so a re-run reuses secrets', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 'TOK1', ownerId: 42 }))
  const targets = { quadlet: fake('quadlet'), compose: old, systemd: fake('systemd') }
  const d1 = deps({ targets, isPortFree: vi.fn(async () => false) })
  expect(await runInit({ target: 'quadlet' }, d1)).toBe(1)
  expect(old.remove).toHaveBeenCalledTimes(1)
  expect(readInstall(paths.installFile)).toEqual({
    target: 'compose',
    port: 9000,
    version: '1.0.0',
  })

  targets.quadlet.install = vi.fn(async () => {
    throw new Error('podman build failed (exit 1)')
  })
  expect(await runInit({ target: 'quadlet' }, deps({ targets }))).toBe(1)
  expect(out.join('\n')).toContain('podman build failed (exit 1)')
  expect(readInstall(paths.installFile)?.target).toBe('compose')

  targets.quadlet.install = fake('quadlet').install
  const d3 = deps({ targets })
  expect(await runInit({ target: 'quadlet' }, d3)).toBe(0)
  expect(old.remove).toHaveBeenCalledTimes(3)
  expect(targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { botToken: 'TOK1', ownerId: 42 } }),
  )
  expect(d3.prompt.password).not.toHaveBeenCalled()
  expect(readInstall(paths.installFile)?.target).toBe('quadlet')
})

test('legacy install is recorded before removal so a failed run can be retried', async () => {
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Service]\n')
  const d = deps({ isPortFree: vi.fn(async () => false) })
  expect(await runInit({ target: 'systemd' }, d)).toBe(1)
  expect(readInstall(paths.installFile)).toEqual({
    target: 'systemd',
    port: 8787,
    version: 'legacy',
    configFile: paths.configFile,
  })
})

test('no install record: reuses a token and owner kept by uninstall, no replace prompt', async () => {
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ botToken: 'KTOK', ownerId: 11 }))
  const d = deps()
  expect(await runInit({ target: 'compose' }, d)).toBe(0)
  expect(d.prompt.confirm).not.toHaveBeenCalled()
  expect(d.prompt.password).not.toHaveBeenCalled()
  expect(checkOf(d)).toHaveBeenCalledWith({ botToken: 'KTOK', ownerId: 11 })
  expect(d.targets.compose.install).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { botToken: 'KTOK', ownerId: 11 } }),
  )
  expect(out.join('\n')).toContain('Reusing the saved bot token (@mybot).')
  expect(out.join('\n')).not.toContain('KTOK')
})

test('no install record: leftover token from a container .env, rejected token prompts', async () => {
  mkdirSync(paths.quadletDirectory, { recursive: true })
  writeFileSync(join(paths.quadletDirectory, '.env'), 'BOT_TOKEN=stale\nPORT=1\nOWNER_ID=4\n')
  const validate = vi.fn(async (settings: SettingValues) =>
    settings.botToken === 'stale' ? REJECTED : ACCEPTED,
  )
  const d = deps({ providers: [telegram(validate)] })
  expect(await runInit({}, d)).toBe(0)
  expect(d.prompt.password).toHaveBeenCalledTimes(1)
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { botToken: 'good-token', ownerId: 4 } }),
  )
})

test('a reused secret is masked when removing the old install fails', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 'TOK1', ownerId: 42 }))
  old.remove = vi.fn(async () => {
    throw new Error('down failed: TOK1')
  })
  const d = deps({ targets: { quadlet: fake('quadlet'), compose: old, systemd: fake('systemd') } })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(1)
  const text = out.join('\n')
  expect(text).toContain('Install failed: down failed: ***')
  expect(text).not.toContain('TOK1')
})
