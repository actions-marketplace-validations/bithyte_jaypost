import { expect, test } from 'vite-plus/test'
import { parseNotifyRequest } from '../../src/notify/index.ts'

test('valid body', () => {
  expect(parseNotifyRequest({ text: 'hi' }, 3900)).toEqual({ ok: true, value: { text: 'hi' } })
})

test('extra fields are dropped', () => {
  expect(parseNotifyRequest({ text: 'hi', foo: 1 }, 3900)).toEqual({
    ok: true,
    value: { text: 'hi' },
  })
})

test('text at the limit is accepted', () => {
  expect(parseNotifyRequest({ text: 'a'.repeat(3900) }, 3900).ok).toBe(true)
})

test('text over the limit', () => {
  expect(parseNotifyRequest({ text: 'a'.repeat(3901) }, 3900)).toEqual({
    ok: false,
    error: 'text must be at most 3900 characters',
  })
})

test.each([undefined, '', '   ', 5])('bad text %s', (text) => {
  expect(parseNotifyRequest({ text }, 3900)).toEqual({
    ok: false,
    error: 'text must be a non-empty string',
  })
})

test.each([null, [], 'x'])('non-object body %s', (body) => {
  expect(parseNotifyRequest(body, 3900)).toEqual({ ok: false, error: 'body must be a JSON object' })
})

test('text limit comes from the caller', () => {
  expect(parseNotifyRequest({ text: 'x'.repeat(11) }, 10)).toEqual({
    ok: false,
    error: 'text must be at most 10 characters',
  })
})

test('project goes on its own first line, trimmed', () => {
  expect(parseNotifyRequest({ text: 'hi', project: ' api ' }, 3900)).toEqual({
    ok: true,
    value: { text: '[api]\n\nhi' },
  })
})

test('project counts toward the text limit', () => {
  expect(parseNotifyRequest({ text: 'xxxx', project: 'ab' }, 10).ok).toBe(true)
  expect(parseNotifyRequest({ text: 'xxxxx', project: 'ab' }, 10)).toEqual({
    ok: false,
    error: 'text must be at most 4 characters',
  })
})

test.each([5, '', '   '])('bad project %s', (project) => {
  expect(parseNotifyRequest({ text: 'hi', project }, 3900)).toEqual({
    ok: false,
    error: 'project must be a non-empty string',
  })
})

test('project length limit', () => {
  expect(parseNotifyRequest({ text: 'hi', project: 'x'.repeat(100) }, 3900).ok).toBe(true)
  expect(parseNotifyRequest({ text: 'hi', project: 'x'.repeat(101) }, 3900)).toEqual({
    ok: false,
    error: 'project must be at most 100 characters',
  })
})
