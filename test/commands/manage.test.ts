import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vite-plus/test'
import { runResetOwner, runStatus, runUninstall } from '../../src/commands/index.ts'
import { resolveInstallPaths, writeInstall } from '../../src/install/index.ts'
import type { InstallPaths, Target, TargetName } from '../../src/install/index.ts'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

let tmp: string
let paths: InstallPaths
let order: string[]
let out: string[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'manage-'))
  paths = resolveInstallPaths({ HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') })
  order = []
  out = []
})

function fake(name: TargetName, running = true): Mutable<Target> {
  return {
    name,
    available: vi.fn(),
    install: vi.fn(),
    readSecrets: vi.fn(),
    remove: vi.fn(async () => {
      order.push('remove')
    }),
    restart: vi.fn(async () => {
      order.push('restart')
    }),
    clearOwner: vi.fn(async () => {
      order.push('clearOwner')
    }),
    isRunning: vi.fn(async () => running),
    logsHint: vi.fn(() => 'logs hint'),
  } as unknown as Mutable<Target>
}

function targets(over: Partial<Record<TargetName, Target>> = {}) {
  return {
    quadlet: fake('quadlet'),
    compose: fake('compose'),
    systemd: fake('systemd'),
    ...over,
  }
}

function seed(target: TargetName = 'systemd') {
  writeInstall(paths.installFile, { target, port: 9000, version: '1.0.0' })
}

function base(over = {}) {
  return {
    targets: targets(),
    paths,
    print: (s: string) => out.push(s),
    confirm: vi.fn(async () => true),
    ...over,
  }
}

test('status not installed -> 1', async () => {
  expect(await runStatus({ ...base(), fetchStatus: vi.fn() })).toBe(1)
  expect(out.join('\n')).toContain('Not installed. Run "telegram-ask init".')
})

test('status running and paired -> 0', async () => {
  seed()
  const fetchStatus = vi.fn(async () => ({ paired: true as const, bot: 'b' }))
  expect(await runStatus({ ...base(), fetchStatus })).toBe(0)
  const s = out.join('\n')
  expect(s).toContain('systemd')
  expect(s).toContain('1.0.0')
  expect(s).toContain('9000')
  expect(s).toContain('yes')
  expect(s).toContain('paired')
  expect(fetchStatus).toHaveBeenCalledWith(9000)
})

test('status running, unpaired shows pairing line', async () => {
  seed()
  const fetchStatus = vi.fn(async () => ({
    paired: false as const,
    code: 'ABCD-EFGH',
    bot: 'mybot',
  }))
  expect(await runStatus({ ...base(), fetchStatus })).toBe(0)
  expect(out.join('\n')).toContain('/start ABCD-EFGH')
})

test('status prints old-shape pairing text', async () => {
  seed()
  const fetchStatus = vi.fn(async () => ({
    paired: false as const,
    code: 'ABCD-EFGH',
    bot: 'mybot',
  }))
  expect(await runStatus({ ...base(), fetchStatus })).toBe(0)
  expect(out.join('\n')).toContain(
    'Pairing: not paired\nPairing code: ABCD-EFGH\nSend "/start ABCD-EFGH" to @mybot, or open https://t.me/mybot?start=ABCDEFGH',
  )
})

test('status prints provider instructions as is', async () => {
  seed()
  const fetchStatus = vi.fn(async () => ({
    paired: false as const,
    provider: 'fake',
    displayName: 'fake',
    code: 'ABCD-EFGH',
    instructions: 'Say ABCDEFGH to fake',
  }))
  expect(await runStatus({ ...base(), fetchStatus })).toBe(0)
  expect(out.join('\n')).toContain(
    'Pairing: not paired\nPairing code: ABCD-EFGH\nSay ABCDEFGH to fake',
  )
})

test('status not running -> 1', async () => {
  seed()
  const t = targets({ systemd: fake('systemd', false) })
  expect(
    await runStatus({ ...base({ targets: t }), fetchStatus: vi.fn(async () => undefined) }),
  ).toBe(1)
  expect(out.join('\n')).toContain('no')
})

test('reset-owner not installed -> 1', async () => {
  expect(await runResetOwner({ ...base(), wait: vi.fn() })).toBe(1)
})

test('reset-owner declined: no clearOwner', async () => {
  seed()
  const d = { ...base({ confirm: vi.fn(async () => false) }), wait: vi.fn() }
  expect(await runResetOwner(d)).toBe(0)
  expect(d.targets.systemd.clearOwner).not.toHaveBeenCalled()
  expect(d.wait).not.toHaveBeenCalled()
})

test('reset-owner yes: clearOwner, restart, wait', async () => {
  seed()
  const wait = vi.fn(async () => {
    order.push('wait')
    return 'paired' as const
  })
  const d = { ...base(), wait }
  expect(await runResetOwner(d)).toBe(0)
  expect(d.confirm).toHaveBeenCalledWith('This unlinks your Telegram account. Continue?', false)
  expect(order).toEqual(['clearOwner', 'restart', 'wait'])
})

test('reset-owner wait exit codes', async () => {
  seed()
  for (const [r, code] of [
    ['interrupted', 130],
    ['notStarted', 1],
    ['stopped', 1],
  ] as const) {
    expect(await runResetOwner({ ...base(), wait: vi.fn(async () => r) })).toBe(code)
  }
})

test('reset-owner failure prints generic error and returns 1', async () => {
  seed()
  const t = fake('systemd')
  t.clearOwner = vi.fn(async () => {
    throw new Error('secret-token-123')
  })
  const d = { ...base({ targets: targets({ systemd: t }) }), wait: vi.fn() }
  expect(await runResetOwner(d)).toBe(1)
  expect(out.join('\n')).not.toContain('secret-token-123')
  expect(d.wait).not.toHaveBeenCalled()
})

test('reset-owner prompt abort -> 130', async () => {
  seed()
  const { PromptAborted } = await import('../../src/commands/index.ts')
  const d = {
    ...base({
      confirm: vi.fn(async () => {
        throw new PromptAborted()
      }),
    }),
    wait: vi.fn(),
  }
  expect(await runResetOwner(d)).toBe(130)
})

test('uninstall not installed -> 0', async () => {
  expect(await runUninstall(base())).toBe(0)
  expect(out.join('\n')).toContain('Not installed')
})

test('uninstall passes purge answer through and removes install.json', async () => {
  for (const [ans, purge] of [
    [true, true],
    [false, false],
  ] as const) {
    seed('compose')
    const d = base({ confirm: vi.fn(async () => ans) })
    expect(await runUninstall(d)).toBe(0)
    expect(d.confirm).toHaveBeenCalledWith('Also delete the bot token and paired owner?', false)
    expect(d.targets.compose.remove).toHaveBeenCalledWith(
      { target: 'compose', port: 9000, version: '1.0.0' },
      purge,
    )
    expect(existsSync(paths.installFile)).toBe(false)
  }
})

test('uninstall works on legacy install', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Unit]\n')
  const d = base()
  expect(await runUninstall(d)).toBe(0)
  expect(d.targets.systemd.remove).toHaveBeenCalled()
})

test('uninstall failure: generic error, 1, install.json kept', async () => {
  seed()
  const t = fake('systemd')
  t.remove = vi.fn(async () => {
    throw new Error('secret-token-123')
  })
  const d = base({ targets: targets({ systemd: t }) })
  expect(await runUninstall(d)).toBe(1)
  expect(out.join('\n')).not.toContain('secret-token-123')
  expect(existsSync(paths.installFile)).toBe(true)
})

test('test command takes port from install.json first', async () => {
  const { runTest } = await import('../../src/commands/index.ts')
  seed()
  const f = vi.fn(async (_url: string) => new Response('ok', { status: 200 }))
  vi.stubGlobal('fetch', f)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(await runTest(1234, paths.installFile)).toBe(0)
  expect(f.mock.calls[0]![0]).toBe('http://127.0.0.1:9000/request')
  vi.unstubAllGlobals()
})

test('reset-owner restart failure reports Reset failed, not Paired', async () => {
  seed()
  const t = fake('systemd')
  t.restart = vi.fn(async () => {
    throw new Error('systemctl restart failed (exit 1)')
  })
  const d = { ...base({ targets: targets({ systemd: t }) }), wait: vi.fn() }
  expect(await runResetOwner(d)).toBe(1)
  expect(out.join('\n')).toContain('Reset failed. logs hint')
  expect(out.join('\n')).not.toContain('Paired')
  expect(d.wait).not.toHaveBeenCalled()
})

test('reset-owner wait throwing prints a generic error and returns 1', async () => {
  seed()
  const wait = vi.fn(async () => {
    throw new Error('secret-token-123')
  })
  expect(await runResetOwner({ ...base(), wait })).toBe(1)
  const text = out.join('\n')
  expect(text).toContain('Waiting for pairing failed. logs hint')
  expect(text).not.toContain('secret-token-123')
})
