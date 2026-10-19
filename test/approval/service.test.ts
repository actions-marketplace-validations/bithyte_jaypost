import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { ApprovalService, RESULT_TTL_MS, SendError } from '../../src/approval/index.ts'
import type { RequestRecord } from '../../src/state/index.ts'
import type {
  ApprovalRequest,
  MessageEnding,
  MessageReference,
  Messenger,
  RequestState,
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
  finalized: { ref: MessageReference; text: string; settlement: MessageEnding }[] = []
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

  async finalize(ref: MessageReference, text: string, settlement: MessageEnding): Promise<void> {
    this.finalized.push({ ref, text, settlement })
    if (this.finalizeError) {
      throw this.finalizeError
    }
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

const expiresAt = new Date(at.getTime() + 30_000)
const PENDING_STATE: RequestState = { kind: 'pending', expiresAt }
const APPROVED_STATE: RequestState = {
  kind: 'done',
  outcome: { answer: 'Approve', timedOut: false },
}

function setup() {
  const m = new FakeMessenger()
  const svc = new ApprovalService(
    m,
    () => at,
    () => 'id1',
  )
  return { m, svc }
}

function createStore() {
  const added: RequestRecord[] = []
  const removed: string[] = []
  return {
    added,
    removed,
    addRequest: (record: RequestRecord) => {
      added.push(record)
    },
    removeRequest: (id: string) => {
      removed.push(id)
    },
  }
}

function setupWithStore() {
  const m = new FakeMessenger()
  const store = createStore()
  const svc = new ApprovalService(
    m,
    () => at,
    () => 'id1',
    { store },
  )
  return { m, svc, store }
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

test('rejectAll resolves completed with timedOut false and finalizes with the rejected line', async () => {
  const { m, svc } = setup()
  const r = svc.request(req)
  await flush()
  expect(svc.rejectAll().map((summary) => summary.id)).toEqual(['id1'])
  await expect(r).resolves.toEqual({
    kind: 'completed',
    outcome: { answer: 'Decline', timedOut: false },
  })
  expect(m.finalized[0]?.text).toBe('Deploy?\n\n⛔ Rejected, Decline, 09:05')
})

test('listPending shows open requests with openedAt', async () => {
  const { svc } = setup()
  void svc.request(req)
  await flush()
  expect(svc.listPending()).toEqual([{ id: 'id1', request: req, openedAt: at }])
})

test('history records every kind newest first', async () => {
  const m = new FakeMessenger()
  let counter = 0
  const svc = new ApprovalService(
    m,
    () => at,
    () => `id${(counter += 1)}`,
  )
  const answered = svc.request(req)
  await flush()
  svc.tap('id1', 0)
  await answered
  const timedOut = svc.request(req)
  await flush()
  await vi.advanceTimersByTimeAsync(30_000)
  await timedOut
  const rejected = svc.request(req)
  await flush()
  svc.rejectAll()
  await rejected
  const controller = new AbortController()
  const cancelled = svc.request(req, controller.signal)
  await flush()
  controller.abort()
  await cancelled
  expect(svc.history(10).map((entry) => entry.settlement.kind)).toEqual([
    'cancelled',
    'rejected',
    'timedOut',
    'answered',
  ])
  expect(svc.history(10)[0]).toEqual({
    text: 'Deploy?',
    settlement: { kind: 'cancelled' },
    settledAt: at,
  })
})

test('history keeps the last 20 and honours count', async () => {
  const m = new FakeMessenger()
  let counter = 0
  const svc = new ApprovalService(
    m,
    () => at,
    () => `id${(counter += 1)}`,
  )
  for (let index = 0; index <= 20; index += 1) {
    const result = svc.request({ ...req, text: `q${index}` })
    await flush()
    svc.tap(`id${index + 1}`, 0)
    await result
  }
  const entries = svc.history(50)
  expect(entries).toHaveLength(20)
  expect(entries[0]?.text).toBe('q20')
  expect(entries.at(-1)?.text).toBe('q1')
  expect(svc.history(2).map((entry) => entry.text)).toEqual(['q20', 'q19'])
  expect(svc.history(0)).toEqual([])
})

test('history entry and final text share one clock read', async () => {
  const m = new FakeMessenger()
  let calls = 0
  const svc = new ApprovalService(
    m,
    () => new Date(2026, 0, 1, 9, (calls += 1)),
    () => 'id1',
  )
  const result = svc.request(req)
  await flush()
  svc.tap('id1', 0)
  await result
  const [entry] = svc.history(1)
  expect(entry?.settledAt).toEqual(new Date(2026, 0, 1, 9, 2))
  expect(m.finalized[0]?.text).toBe('Deploy?\n\n✅ Approve, 09:02')
  expect(calls).toBe(2)
})

test('history is recorded even when there is no finalize', async () => {
  const svc = new ApprovalService(
    { sendRequest: async () => ({}) },
    () => at,
    () => 'id1',
  )
  const result = svc.request(req)
  await flush()
  svc.tap('id1', 1)
  await result
  expect(svc.history(1)).toEqual([
    { text: 'Deploy?', settlement: { kind: 'answered', answer: 'Decline' }, settledAt: at },
  ])
})

test('records the request after send and removes it after the answer', async () => {
  const { svc, store } = setupWithStore()
  const r = svc.request(req)
  await flush()
  expect(store.added).toEqual([
    { id: 'id1', reference: { chatId: 1, messageId: 2 }, text: 'Deploy?' },
  ])
  expect(store.removed).toEqual([])
  expect(svc.tap('id1', 0)).toBe('accepted')
  await r
  expect(store.removed).toEqual(['id1'])
})

test('removes the record after a timeout', async () => {
  const { svc, store } = setupWithStore()
  const r = svc.request(req)
  await flush()
  await vi.advanceTimersByTimeAsync(30_000)
  await r
  expect(store.removed).toEqual(['id1'])
})

test('removes the record after a cancel, even when finalize throws', async () => {
  const { m, svc, store } = setupWithStore()
  m.finalizeError = new Error('boom')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const controller = new AbortController()
  const r = svc.request(req, controller.signal)
  await flush()
  controller.abort()
  await r
  expect(store.removed).toEqual(['id1'])
})

test('records nothing when sendRequest throws', async () => {
  const { m, svc, store } = setupWithStore()
  m.sendError = new Error('down')
  await expect(svc.request(req)).rejects.toBeInstanceOf(SendError)
  expect(store.added).toEqual([])
  expect(store.removed).toEqual([])
})

test('records nothing without finalize', async () => {
  const store = createStore()
  const svc = new ApprovalService(
    { sendRequest: async () => ({ n: 1 }) },
    () => at,
    () => 'id1',
    { store },
  )
  const r = svc.request(req)
  await flush()
  expect(svc.tap('id1', 0)).toBe('accepted')
  await r
  expect(store.added).toEqual([])
})

const ORPHANS: readonly RequestRecord[] = [
  { id: 'a', reference: { n: 1 }, text: 'Old?' },
  { id: 'b', reference: { n: 2 }, text: 'Older?' },
]

test('expireOrphans finalizes each orphan as expired and removes it', async () => {
  const { m, svc, store } = setupWithStore()
  await svc.expireOrphans(ORPHANS)
  expect(m.finalized).toEqual([
    {
      ref: { n: 1 },
      text: 'Old?\n\n⌛ Expired (service restarted), 09:05',
      settlement: { kind: 'expired' },
    },
    {
      ref: { n: 2 },
      text: 'Older?\n\n⌛ Expired (service restarted), 09:05',
      settlement: { kind: 'expired' },
    },
  ])
  expect(store.removed).toEqual(['a', 'b'])
})

test('expireOrphans removes the record when finalize throws', async () => {
  const { m, svc, store } = setupWithStore()
  m.finalizeError = new Error('boom')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(svc.expireOrphans(ORPHANS.slice(0, 1))).resolves.toBeUndefined()
  expect(store.removed).toEqual(['a'])
})

test('expireOrphans without finalize drops the records', async () => {
  const store = createStore()
  const svc = new ApprovalService({ sendRequest: async () => ({}) }, () => at, undefined, {
    store,
  })
  await svc.expireOrphans(ORPHANS)
  expect(store.removed).toEqual(['a', 'b'])
})

test('start sends and returns the id and expiry without waiting', async () => {
  const { m, svc } = setup()
  await expect(svc.start(req)).resolves.toEqual({ id: 'id1', expiresAt })
  expect(m.sent).toHaveLength(1)
  expect(svc.get('id1')).toEqual(PENDING_STATE)
})

test('a tap settles a started request as done', async () => {
  const { m, svc } = setup()
  await svc.start(req)
  expect(svc.tap('id1', 0)).toBe('accepted')
  await flush()
  expect(svc.get('id1')).toEqual(APPROVED_STATE)
  expect(m.finalized).toEqual([
    {
      ref: m.ref,
      text: 'Deploy?\n\n✅ Approve, 09:05',
      settlement: { kind: 'answered', answer: 'Approve' },
    },
  ])
})

test('a started request times out as done with timedOut', async () => {
  const { m, svc } = setup()
  await svc.start(req)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(svc.get('id1')).toEqual({
    kind: 'done',
    outcome: { answer: 'Decline', timedOut: true },
  })
  expect(m.finalized[0]?.settlement).toEqual({ kind: 'timedOut', answer: 'Decline' })
})

test('waitFor resolves when the request settles', async () => {
  const { svc } = setup()
  await svc.start(req)
  const waiting = svc.waitFor('id1', 60_000)
  svc.tap('id1', 0)
  expect(await waiting).toEqual(APPROVED_STATE)
})

test('waitFor resolves pending after waitMs', async () => {
  const { svc } = setup()
  await svc.start(req)
  const waiting = svc.waitFor('id1', 5_000)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await waiting).toEqual(PENDING_STATE)
  // only the question's own timeout is left
  expect(vi.getTimerCount()).toBe(1)
})

test('waitFor on a settled request resolves its state at once', async () => {
  const { svc } = setup()
  await svc.start(req)
  svc.tap('id1', 0)
  await flush()
  expect(await svc.waitFor('id1', 60_000)).toEqual(APPROVED_STATE)
})

test('an aborted waitFor leaves the request pending', async () => {
  const { m, svc } = setup()
  await svc.start(req)
  const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  const waiting = svc.waitFor('id1', 60_000, controller.signal)
  controller.abort()
  expect(await waiting).toEqual(PENDING_STATE)
  expect(svc.get('id1')).toEqual(PENDING_STATE)
  expect(m.finalized).toEqual([])
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  expect(vi.getTimerCount()).toBe(1)
  expect(await svc.waitFor('id1', 60_000, AbortSignal.abort())).toEqual(PENDING_STATE)
})

test('cancel settles a pending request and get sees it at once', async () => {
  const { m, svc } = setup()
  await svc.start(req)
  await expect(svc.cancel('id1')).resolves.toEqual({ kind: 'cancelled' })
  expect(svc.get('id1')).toEqual({ kind: 'cancelled' })
  await flush()
  expect(m.finalized).toEqual([
    {
      ref: m.ref,
      text: 'Deploy?\n\n🚫 Cancelled, 09:05',
      settlement: { kind: 'cancelled' },
    },
  ])
})

test('cancel resolves and get stays known while the final edit is in flight', async () => {
  const { m, svc } = setup()
  let finishEdit = () => {}
  m.finalize = (reference, text, settlement) => {
    m.finalized.push({ ref: reference, text, settlement })
    return new Promise((resolve) => {
      finishEdit = resolve
    })
  }
  await svc.start(req)
  await expect(svc.cancel('id1')).resolves.toEqual({ kind: 'cancelled' })
  expect(m.finalized).toHaveLength(1)
  expect(svc.get('id1')).toEqual({ kind: 'cancelled' })
  expect(svc.history(1)).toHaveLength(1)
  finishEdit()
  await flush()
  expect(svc.get('id1')).toEqual({ kind: 'cancelled' })
})

test('cancel on a settled request changes nothing', async () => {
  const { m, svc } = setup()
  await svc.start(req)
  svc.tap('id1', 0)
  await flush()
  await expect(svc.cancel('id1')).resolves.toEqual(APPROVED_STATE)
  expect(svc.get('id1')).toEqual(APPROVED_STATE)
  expect(m.finalized).toHaveLength(1)
})

test('cancel and get on an unknown id return undefined', async () => {
  const { svc } = setup()
  expect(svc.get('nope')).toBeUndefined()
  await expect(svc.cancel('nope')).resolves.toBeUndefined()
  await expect(svc.waitFor('nope', 1_000)).resolves.toBeUndefined()
})

test('blocking requests are not readable by id', async () => {
  const { svc } = setup()
  const result = svc.request(req)
  await flush()
  expect(svc.get('id1')).toBeUndefined()
  await expect(svc.cancel('id1')).resolves.toBeUndefined()
  await expect(svc.waitFor('id1', 1_000)).resolves.toBeUndefined()
  expect(svc.tap('id1', 0)).toBe('accepted')
  await result
  expect(svc.get('id1')).toBeUndefined()
})

test('settled results are forgotten after 24 h', async () => {
  const { svc } = setup()
  await svc.start(req)
  svc.tap('id1', 0)
  await flush()
  await vi.advanceTimersByTimeAsync(RESULT_TTL_MS - 1)
  expect(svc.get('id1')).toEqual(APPROVED_STATE)
  await vi.advanceTimersByTimeAsync(1)
  expect(svc.get('id1')).toBeUndefined()
  await expect(svc.cancel('id1')).resolves.toBeUndefined()
})

test('rejectAll settles a started request with the timeout option', async () => {
  const { m, svc } = setup()
  await svc.start(req)
  expect(svc.listPending()).toEqual([{ id: 'id1', request: req, openedAt: at }])
  expect(svc.rejectAll().map((summary) => summary.id)).toEqual(['id1'])
  await flush()
  expect(svc.get('id1')).toEqual({
    kind: 'done',
    outcome: { answer: 'Decline', timedOut: false },
  })
  expect(svc.listPending()).toEqual([])
  expect(svc.history(1)).toEqual([
    { text: 'Deploy?', settlement: { kind: 'rejected', answer: 'Decline' }, settledAt: at },
  ])
  expect(m.finalized[0]?.text).toBe('Deploy?\n\n⛔ Rejected, Decline, 09:05')
})

test('start records the request in the store and removes it once settled', async () => {
  const { svc, store } = setupWithStore()
  await svc.start(req)
  expect(store.added).toEqual([
    { id: 'id1', reference: { chatId: 1, messageId: 2 }, text: 'Deploy?' },
  ])
  expect(store.removed).toEqual([])
  svc.tap('id1', 0)
  await flush()
  expect(store.removed).toEqual(['id1'])
})

test('start send failure throws SendError and leaves nothing pending', async () => {
  const { m, svc, store } = setupWithStore()
  m.sendError = new Error('network down')
  await expect(svc.start(req)).rejects.toBeInstanceOf(SendError)
  expect(svc.get('id1')).toBeUndefined()
  expect(svc.listPending()).toEqual([])
  expect(store.added).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})
