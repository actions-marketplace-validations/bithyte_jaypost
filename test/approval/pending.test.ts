import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { PendingRequests } from '../../src/approval/index.ts'

const req = {
  text: 't',
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
  timeoutSeconds: 10,
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('answer settles with option label', async () => {
  const p = new PendingRequests()
  const s = p.open('a', req)
  expect(p.answer('a', 0)).toBe(true)
  await expect(s).resolves.toEqual({ kind: 'answered', answer: 'Approve' })
  expect(p.size).toBe(0)
})

test('timeout settles with timeoutOption', async () => {
  const p = new PendingRequests()
  const s = p.open('a', req)
  vi.advanceTimersByTime(9999)
  expect(p.size).toBe(1)
  vi.advanceTimersByTime(1)
  await expect(s).resolves.toEqual({ kind: 'timedOut', answer: 'Decline' })
  expect(p.size).toBe(0)
})

test('second answer and answer after timeout return false', () => {
  const p = new PendingRequests()
  p.open('a', req)
  p.answer('a', 1)
  expect(p.answer('a', 0)).toBe(false)
  p.open('b', req)
  vi.advanceTimersByTime(10_000)
  expect(p.answer('b', 0)).toBe(false)
})

test('out of range index returns false and keeps pending', () => {
  const p = new PendingRequests()
  p.open('a', req)
  expect(p.answer('a', 2)).toBe(false)
  expect(p.answer('a', -1)).toBe(false)
  expect(p.size).toBe(1)
})

test('cancel settles cancelled, then answer is false', async () => {
  const p = new PendingRequests()
  const s = p.open('a', req)
  expect(p.cancel('a')).toBe(true)
  await expect(s).resolves.toEqual({ kind: 'cancelled' })
  expect(p.answer('a', 0)).toBe(false)
  expect(p.cancel('a')).toBe(false)
})

test('answer clears the timer', async () => {
  const p = new PendingRequests()
  const s = p.open('a', req)
  p.answer('a', 0)
  expect(vi.getTimerCount()).toBe(0)
  await expect(s).resolves.toEqual({ kind: 'answered', answer: 'Approve' })
})

test('independent concurrent requests', async () => {
  const p = new PendingRequests()
  const a = p.open('a', req)
  const b = p.open('b', { ...req, timeoutSeconds: 5 })
  vi.advanceTimersByTime(5000)
  p.answer('a', 0)
  await expect(b).resolves.toMatchObject({ kind: 'timedOut' })
  await expect(a).resolves.toMatchObject({ kind: 'answered' })
})
