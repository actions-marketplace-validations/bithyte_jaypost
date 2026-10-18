import { expect, test } from 'vite-plus/test'
import { parseApprovalRequest } from '../../src/approval/index.ts'

const base = { text: 'This is a test', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }

test('valid, default timeout', () =>
  expect(parseApprovalRequest(base)).toEqual({ ok: true, value: { ...base, timeoutSeconds: 300 } }))
test('custom timeout', () =>
  expect(parseApprovalRequest({ ...base, timeout: 30 })).toMatchObject({
    ok: true,
    value: { timeoutSeconds: 30 },
  }))
test('timeout clamped', () =>
  expect(parseApprovalRequest({ ...base, timeout: 900 })).toMatchObject({
    ok: true,
    value: { timeoutSeconds: 300 },
  }))
test.each([0, -5, '30', null, Number.NaN, Infinity])('bad timeout %s', (t) => {
  const r = parseApprovalRequest({ ...base, timeout: t })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toContain('timeout')
})
test.each([
  ['not object', 'hi'],
  ['null', null],
  ['array', []],
  ['missing text', { ...base, text: undefined }],
  ['empty text', { ...base, text: '' }],
  ['whitespace-only text', { ...base, text: '  \n\t ' }],
  ['text too long', { ...base, text: 'x'.repeat(3901) }],
  ['options not array', { ...base, options: 'Approve' }],
  ['empty options', { ...base, options: [], timeoutOption: 'x' }],
  ['non-string option', { ...base, options: ['Approve', 1] }],
  ['empty option label', { ...base, options: ['Approve', ''] }],
  ['65-char option label', { ...base, options: ['Approve', 'x'.repeat(65)] }],
  ['duplicate options', { ...base, options: ['Approve', 'Approve'], timeoutOption: 'Approve' }],
  ['missing timeoutOption', { ...base, timeoutOption: undefined }],
  ['timeoutOption not in options', { ...base, timeoutOption: 'Maybe' }],
])('%s rejected', (_n, body) => {
  const r = parseApprovalRequest(body)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
})

test('64-char option label accepted', () => {
  const long = 'x'.repeat(64)
  expect(
    parseApprovalRequest({ ...base, options: ['Approve', long], timeoutOption: long }).ok,
  ).toBe(true)
})
