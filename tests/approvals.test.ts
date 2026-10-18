import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { ApprovalService, SendError } from '../src/approvals.ts'
import type { MessageRef, Messenger } from '../src/messenger.ts'
import type { ApprovalRequest } from '../src/types.ts'

const at = new Date(2026, 0, 1, 9, 5)

const req: ApprovalRequest = {
  text: 'Deploy?',
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
  timeoutSeconds: 30,
}

class FakeMessenger implements Messenger {
  ref: MessageRef = { chatId: 1, messageId: 2 }
  sent: { id: string; text: string; options: string[] }[] = []
  finalized: { ref: MessageRef; text: string }[] = []
  sendError: Error | undefined
  finalizeError: Error | undefined

  async sendRequest(id: string, text: string, options: string[]): Promise<MessageRef> {
    if (this.sendError) throw this.sendError
    this.sent.push({ id, text, options })
    return this.ref
  }

  async finalize(ref: MessageRef, text: string): Promise<void> {
    this.finalized.push({ ref, text })
    if (this.finalizeError) throw this.finalizeError
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

function setup() {
  const m = new FakeMessenger()
  const svc = new ApprovalService(
    m,
    () => at,
    () => 'id1',
  )
  return { m, svc }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('tap resolves request and finalizes message', async () => {
  const { m, svc } = setup()
  const r = svc.request(req)
  await flush()
  expect(m.sent).toEqual([{ id: 'id1', text: 'Deploy?', options: ['Approve', 'Decline'] }])
  expect(svc.tap('id1', 0)).toBe('accepted')
  await expect(r).resolves.toEqual({ answer: 'Approve', timedOut: false })
  expect(m.finalized).toEqual([{ ref: m.ref, text: 'Deploy?\n\n✅ Approve, 09:05' }])
})

test('timeout returns timeoutOption, timedOut true', async () => {
  const { m, svc } = setup()
  const r = svc.request(req)
  await flush()
  await vi.advanceTimersByTimeAsync(30_000)
  await expect(r).resolves.toEqual({ answer: 'Decline', timedOut: true })
  expect(m.finalized).toEqual([{ ref: m.ref, text: 'Deploy?\n\n⏱ Timed out, Decline, 09:05' }])
  expect(svc.tap('id1', 0)).toBe('expired')
})

test('tap on unknown or settled id returns expired', async () => {
  const { m, svc } = setup()
  expect(svc.tap('nope', 0)).toBe('expired')
  const r = svc.request(req)
  await flush()
  expect(svc.tap('other', 0)).toBe('expired')
  expect(svc.tap('id1', 1)).toBe('accepted')
  await r
  expect(svc.tap('id1', 0)).toBe('expired')
  expect(m.finalized).toHaveLength(1)
})

test('send failure throws SendError and leaves nothing pending', async () => {
  const { m, svc } = setup()
  m.sendError = new Error('network down')
  const r = svc.request(req)
  const assertion = expect(r).rejects.toBeInstanceOf(SendError)
  await flush()
  await assertion
  expect(svc.tap('id1', 0)).toBe('expired')
  expect(m.finalized).toEqual([])
  // no timer left behind that could fire later
  expect(vi.getTimerCount()).toBe(0)
})

test('abort cancels: returns null, finalizes with Cancelled, later tap expired', async () => {
  const { m, svc } = setup()
  const ctrl = new AbortController()
  const r = svc.request(req, ctrl.signal)
  await flush()
  ctrl.abort()
  await expect(r).resolves.toBeNull()
  expect(m.finalized).toEqual([{ ref: m.ref, text: 'Deploy?\n\n🚫 Cancelled, 09:05' }])
  expect(svc.tap('id1', 0)).toBe('expired')
  expect(vi.getTimerCount()).toBe(0)
})

test('already-aborted signal cancels right after send', async () => {
  const { m, svc } = setup()
  const r = svc.request(req, AbortSignal.abort())
  await expect(r).resolves.toBeNull()
  expect(m.sent).toHaveLength(1)
  expect(m.finalized).toEqual([{ ref: m.ref, text: 'Deploy?\n\n🚫 Cancelled, 09:05' }])
  expect(svc.tap('id1', 0)).toBe('expired')
})

test('abort listener is removed after settlement', async () => {
  const { svc } = setup()
  const ctrl = new AbortController()
  const remove = vi.spyOn(ctrl.signal, 'removeEventListener')
  const r = svc.request(req, ctrl.signal)
  await flush()
  svc.tap('id1', 0)
  await r
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
})

test('finalize failure still returns the answer', async () => {
  const { m, svc } = setup()
  const err = new Error('edit failed')
  m.finalizeError = err
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const r = svc.request(req)
  await flush()
  svc.tap('id1', 0)
  await expect(r).resolves.toEqual({ answer: 'Approve', timedOut: false })
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy.mock.calls[0]).toContain(err)
})
