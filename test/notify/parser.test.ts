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
