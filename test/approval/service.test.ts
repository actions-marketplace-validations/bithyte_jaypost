import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { ApprovalService, SendError } from '../../src/approval/index.ts'
import type {
  ApprovalRequest,
  MessageReference,
  Messenger,
  Settlement,
} from '../../src/approval/index.ts'

const at = new Date(2026, 0, 1, 9, 5)

const req: ApprovalRequest = {
  text: 'Deploy?',
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
  timeoutSeconds: 30,
}

class FakeMessenger implements Messenger {
  ref: MessageReference = { chatId: 1, messageId: 2 }
  sent: { id: string; text: string; options: readonly string[] }[] = []
  finalized: { ref: MessageReference; text: string; settlement: Settlement }[] = []
  sendError: Error | undefined
  finalizeError: Error | undefined

  async sendRequest(
    id: string,
    text: string,
    options: readonly string[],
  ): Promise<MessageReference> {
    if (this.sendError) {
      throw this.sendError
    }
    this.sent.push({ id, text, options })
    return this.ref
  }

  async finalize(ref: MessageReference, text: string, settlement: Settlement): Promise<void> {
    this.finalized.push({ ref, text, settlement })
    if (this.finalizeError) {
      throw this.finalizeError
    }
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
  await expect(r).resolves.toEqual({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  })
  expect(m.finalized).toEqual([
    {
      ref: m.ref,
      text: 'Deploy?\n\n✅ Approve, 09:05',
      settlement: { kind: 'answered', answer: 'Approve' },
    },
  ])
})

test('final text keeps the project line', async () => {
  const { m, svc } = setup()
  const r = svc.request({ ...req, text: '[api]\n\nDeploy?' })
  await flush()
  expect(svc.tap('id1', 0)).toBe('accepted')
  await r
  expect(m.finalized[0]?.text.startsWith('[api]\n\nDeploy?\n\n')).toBe(true)
})

test('timeout returns timeoutOption, timedOut true', async () => {
  const { m, svc } = setup()
  const r = svc.request(req)
  await flush()
  await vi.advanceTimersByTimeAsync(30_000)
  await expect(r).resolves.toEqual({
    kind: 'completed',
    outcome: { answer: 'Decline', timedOut: true },
  })
  expect(m.finalized).toEqual([
    {
      ref: m.ref,
      text: 'Deploy?\n\n⏱ Timed out, Decline, 09:05',
      settlement: { kind: 'timedOut', answer: 'Decline' },
    },
  ])
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

test('abort cancels: returns cancelled, finalizes with Cancelled, later tap expired', async () => {
  const { m, svc } = setup()
  const ctrl = new AbortController()
  const r = svc.request(req, ctrl.signal)
  await flush()
  ctrl.abort()
  await expect(r).resolves.toEqual({ kind: 'cancelled' })
  expect(m.finalized).toEqual([
    {
      ref: m.ref,
      text: 'Deploy?\n\n🚫 Cancelled, 09:05',
      settlement: { kind: 'cancelled' },
    },
  ])
  expect(svc.tap('id1', 0)).toBe('expired')
  expect(vi.getTimerCount()).toBe(0)
})

test('already-aborted signal cancels right after send', async () => {
  const { m, svc } = setup()
  const r = svc.request(req, AbortSignal.abort())
  await expect(r).resolves.toEqual({ kind: 'cancelled' })
  expect(m.sent).toHaveLength(1)
  expect(m.finalized).toEqual([
    {
      ref: m.ref,
      text: 'Deploy?\n\n🚫 Cancelled, 09:05',
      settlement: { kind: 'cancelled' },
    },
  ])
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
  await expect(r).resolves.toEqual({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  })
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy.mock.calls[0]).toContain(err)
})

test('no finalize part: request still settles', async () => {
  const sendRequest = vi.fn(async () => ({ n: 1 }))
  const svc = new ApprovalService(
    { sendRequest },
    () => at,
    () => 'id1',
  )
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const r = svc.request(req)
  await flush()
  expect(svc.tap('id1', 1)).toBe('accepted')
  await expect(r).resolves.toEqual({
    kind: 'completed',
    outcome: { answer: 'Decline', timedOut: false },
  })
  expect(spy).not.toHaveBeenCalled()
})
