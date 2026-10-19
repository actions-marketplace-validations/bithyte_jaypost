import { expect, test } from 'vite-plus/test'
import { parseApprovalRequest, parseWaitSeconds } from '../../src/approval/index.ts'

const base = { text: 'This is a test', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }

test('valid, default timeout', () =>
  expect(parseApprovalRequest(base, 3900)).toEqual({
    ok: true,
    value: { ...base, timeoutSeconds: 300 },
  }))
test('custom timeout', () =>
  expect(parseApprovalRequest({ ...base, timeout: 30 }, 3900)).toMatchObject({
    ok: true,
    value: { timeoutSeconds: 30 },
  }))
test.each([
  [undefined, 300],
  [900, 900],
  [86_400, 86_400],
  [100_000, 86_400],
])('timeout %s becomes %s (default 300, clamped to 24 h)', (timeout, expected) => {
  const result = parseApprovalRequest(
    { ...base, ...(timeout === undefined ? {} : { timeout }) },
    3900,
  )
  expect(result.ok && result.value.timeoutSeconds).toBe(expected)
})
test.each([0, -5, '30', null, Number.NaN, Infinity])('bad timeout %s', (t) => {
  const r = parseApprovalRequest({ ...base, timeout: t }, 3900)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.error).toContain('timeout')
  }
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
  const r = parseApprovalRequest(body, 3900)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.error.length).toBeGreaterThan(0)
  }
})

test('64-char option label accepted', () => {
  const long = 'x'.repeat(64)
  expect(
    parseApprovalRequest({ ...base, options: ['Approve', long], timeoutOption: long }, 3900).ok,
  ).toBe(true)
})

test('text limit comes from the caller', () => {
  expect(parseApprovalRequest({ ...base, text: 'x'.repeat(11) }, 10)).toEqual({
    ok: false,
    error: 'text must be at most 10 characters',
  })
})

test('project goes on its own first line, trimmed', () =>
  expect(parseApprovalRequest({ ...base, project: ' api ' }, 3900)).toEqual({
    ok: true,
    value: { ...base, text: '[api]\n\nThis is a test', timeoutSeconds: 300 },
  }))
test('project counts toward the text limit', () => {
  expect(parseApprovalRequest({ ...base, text: 'xxxx', project: 'ab' }, 10).ok).toBe(true)
  expect(parseApprovalRequest({ ...base, text: 'xxxxx', project: 'ab' }, 10)).toEqual({
    ok: false,
    error: 'text must be at most 4 characters',
  })
})
test.each([5, '', '   '])('bad project %s', (project) =>
  expect(parseApprovalRequest({ ...base, project }, 3900)).toEqual({
    ok: false,
    error: 'project must be a non-empty string',
  }),
)
test('project length limit', () => {
  expect(parseApprovalRequest({ ...base, project: 'x'.repeat(100) }, 3900).ok).toBe(true)
  expect(parseApprovalRequest({ ...base, project: 'x'.repeat(101) }, 3900)).toEqual({
    ok: false,
    error: 'project must be at most 100 characters',
  })
})

test.each([
  [undefined, 0],
  ['0', 0],
  ['-0', 0],
  ['2.5', 2.5],
  ['120', 120],
  ['500', 120],
])('wait %s becomes %s seconds (clamped to 120)', (raw, seconds) =>
  expect(parseWaitSeconds(raw)).toEqual({ ok: true, seconds }),
)
test.each([[''], ['   '], ['-1'], ['abc'], ['Infinity'], ['1e999'], [['1', '2']], [5], [null]])(
  'bad wait %j',
  (raw: unknown) =>
    expect(parseWaitSeconds(raw)).toEqual({
      ok: false,
      error: 'wait must be a non-negative number',
    }),
)
