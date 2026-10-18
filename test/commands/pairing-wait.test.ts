import { expect, test, vi } from 'vite-plus/test'
import type { StatusInfo } from '../../src/server/index.ts'
import { waitForPairing } from '../../src/commands/index.ts'

const base = { port: 1, isRunning: async () => true, logsHint: 'L', sleep: async () => {} }

test('prints code once, resolves paired', async () => {
  const seq: (StatusInfo | undefined)[] = [
    undefined,
    { paired: false, code: 'K7QM-4XPD', bot: 'b' },
    { paired: false, code: 'K7QM-4XPD', bot: 'b' },
    { paired: true, bot: 'b' },
  ]
  const print = vi.fn()
  const r = await waitForPairing({ ...base, fetchStatus: async () => seq.shift(), print })
  expect(r).toBe('paired')
  const hits = print.mock.calls.filter(([s]) => s.includes('K7QM-4XPD'))
  expect(hits).toHaveLength(1)
  expect(print.mock.calls.flat().join('\n')).toContain('https://t.me/b?start=K7QM4XPD')
})

test('abort returns interrupted and says the service is still running', async () => {
  const ac = new AbortController()
  ac.abort()
  const print = vi.fn()
  const r = await waitForPairing({
    ...base,
    signal: ac.signal,
    fetchStatus: async () => undefined,
    print,
  })
  expect(r).toBe('interrupted')
  expect(print.mock.calls.flat().join('\n')).toBe(
    'Service is still running and waiting for pairing. Run "telegram-ask status" to see the code again.',
  )
})

test('abort during the wait (after code shown) returns interrupted', async () => {
  const ac = new AbortController()
  const print = vi.fn()
  const r = await waitForPairing({
    ...base,
    signal: ac.signal,
    fetchStatus: async () => ({ paired: false, code: 'AAAA-BBBB', bot: 'b' }),
    sleep: async () => ac.abort(),
    print,
  })
  expect(r).toBe('interrupted')
  expect(print.mock.calls.flat().join('\n')).toMatch(/telegram-ask status/)
})

test('abort interrupts a real sleep promptly', async () => {
  const ac = new AbortController()
  const print = vi.fn()
  setTimeout(() => ac.abort(), 20)
  const t = Date.now()
  const r = await waitForPairing({
    port: 1,
    isRunning: async () => true,
    logsHint: 'L',
    signal: ac.signal,
    fetchStatus: async () => ({ paired: false, code: 'AAAA-BBBB', bot: 'b' }),
    print,
  })
  expect(r).toBe('interrupted')
  expect(Date.now() - t).toBeLessThan(500)
})

test('service died returns stopped', async () => {
  const print = vi.fn()
  const r = await waitForPairing({
    ...base,
    isRunning: async () => false,
    fetchStatus: async () => undefined,
    print,
  })
  expect(r).toBe('stopped')
  expect(print.mock.calls.flat().join('\n')).toContain('L')
})

test('never answers returns not-started', async () => {
  const r = await waitForPairing({
    ...base,
    startTimeoutMs: 0,
    fetchStatus: async () => undefined,
    print: () => {},
  })
  expect(r).toBe('notStarted')
})
