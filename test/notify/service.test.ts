import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { SendError } from '../../src/approval/index.ts'
import type { MessageReference } from '../../src/approval/index.ts'
import { NOTIFICATION_TTL_MS, NotificationService } from '../../src/notify/index.ts'
import type { Notifier } from '../../src/notify/index.ts'

class FakeNotifier implements Notifier {
  sent: { id: string; text: string }[] = []
  deleted: MessageReference[] = []
  sendError: Error | undefined
  deleteError: Error | undefined
  #nextMessageId = 1

  async sendNotification(id: string, text: string): Promise<MessageReference> {
    if (this.sendError) {
      throw this.sendError
    }
    this.sent.push({ id, text })
    const messageId = this.#nextMessageId
    this.#nextMessageId += 1
    return { chatId: 1, messageId }
  }

  async deleteMessage(ref: MessageReference): Promise<void> {
    if (this.deleteError) {
      throw this.deleteError
    }
    this.deleted.push(ref)
  }
}

function setup(m: Notifier = new FakeNotifier()) {
  let count = 0
  const log = vi.fn()
  const svc = new NotificationService(
    m,
    () => {
      count += 1
      return `id${count}`
    },
    log,
  )
  return { svc, log }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('notify sends and starts the expiry', async () => {
  const m = new FakeNotifier()
  const { svc } = setup(m)
  await svc.notify({ text: 'hi' })
  expect(m.sent).toEqual([{ id: 'id1', text: 'hi' }])
  expect(svc.size).toBe(1)
  expect(m.deleted).toEqual([])
})

test('deletes at exactly 8 hours', async () => {
  const m = new FakeNotifier()
  const { svc } = setup(m)
  await svc.notify({ text: 'hi' })
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS - 1)
  expect(m.deleted).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect(m.deleted).toEqual([{ chatId: 1, messageId: 1 }])
  expect(svc.size).toBe(0)
})

test('dismiss clears the expiry', async () => {
  const m = new FakeNotifier()
  const { svc } = setup(m)
  await svc.notify({ text: 'hi' })
  expect(svc.dismiss('id1')).toBe(true)
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS)
  expect(m.deleted).toEqual([])
  expect(svc.size).toBe(0)
})

test('dismissing one notification leaves the others', async () => {
  const m = new FakeNotifier()
  const { svc } = setup(m)
  await svc.notify({ text: 'a' })
  await svc.notify({ text: 'b' })
  svc.dismiss('id1')
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS)
  expect(m.deleted).toEqual([{ chatId: 1, messageId: 2 }])
})

test('dismiss for an unknown or expired id returns false', async () => {
  const { svc } = setup()
  expect(svc.dismiss('nope')).toBe(false)
  await svc.notify({ text: 'hi' })
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS)
  expect(svc.dismiss('id1')).toBe(false)
})

test('expiry delete failure is logged and not thrown', async () => {
  const m = new FakeNotifier()
  const { svc, log } = setup(m)
  m.deleteError = new Error('message to delete not found')
  await svc.notify({ text: 'hi' })
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS)
  expect(log).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenCalledWith('failed to delete notification: message to delete not found')
  expect(svc.size).toBe(0)
})

test('send failure throws SendError with cause and starts no timer', async () => {
  const m = new FakeNotifier()
  const { svc } = setup(m)
  const boom = new Error('boom')
  m.sendError = boom
  const error = await svc.notify({ text: 'hi' }).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(SendError)
  expect((error as SendError).cause).toBe(boom)
  expect(svc.size).toBe(0)
})

test('without deleteMessage no timer is started', async () => {
  const sendNotification = vi.fn(async () => ({ chatId: 1, messageId: 1 }))
  const { svc } = setup({ sendNotification })
  await svc.notify({ text: 'hi' })
  expect(sendNotification).toHaveBeenCalledWith('id1', 'hi')
  expect(svc.size).toBe(0)
})
