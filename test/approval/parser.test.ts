import { expect, test } from 'vite-plus/test'
import { parseApprovalRequest, parseWaitSeconds } from '../../src/approval/index.ts'

const base = { text: 'This is a test', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }
const expectedBase = {
  message: { text: 'This is a test', spans: [] },
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
}

test('valid, default timeout', () =>
  expect(parseApprovalRequest(base, 3900)).toEqual({
    ok: true,
    value: { ...expectedBase, question: base.text, allowText: false, timeoutSeconds: 300 },
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

test('request with a project keeps project and bare question, combined text for the chat', () => {
  expect(parseApprovalRequest({ ...base, text: 'Deploy?', project: '  api ' }, 3900)).toEqual({
    ok: true,
    value: {
      ...expectedBase,
      message: { text: '[api]\n\nDeploy?', spans: [] },
      question: 'Deploy?',
      project: 'api',
      allowText: false,
      timeoutSeconds: 300,
    },
  })
})

test('request without a project has no project key and question equals text', () => {
  const result = parseApprovalRequest({ ...base, text: 'Deploy?' }, 3900)
  expect(result.ok && Object.hasOwn(result.value, 'project')).toBe(false)
  expect(result.ok && result.value.question).toBe('Deploy?')
})

test('project goes on its own first line, trimmed', () =>
  expect(parseApprovalRequest({ ...base, project: ' api ' }, 3900)).toEqual({
    ok: true,
    value: {
      ...expectedBase,
      message: { text: '[api]\n\nThis is a test', spans: [] },
      question: base.text,
      project: 'api',
      allowText: false,
      timeoutSeconds: 300,
    },
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

const SPAN_CODE_7 = { kind: 'code', offset: 7, length: 2 } as const

test('plain is the default and keeps the text as is', () =>
  expect(parseApprovalRequest({ ...base, text: '  **a**  ' }, 3900)).toMatchObject({
    ok: true,
    value: { message: { text: '  **a**  ', spans: [] } },
  }))
test('bad format', () =>
  expect(parseApprovalRequest({ ...base, format: 'html' }, 3900)).toEqual({
    ok: false,
    error: 'format must be "plain" or "markdown"',
  }))
test.each(['```\n```', '`   `'])('blank after formatting: %j', (text) =>
  expect(parseApprovalRequest({ ...base, text, format: 'markdown' }, 3900)).toEqual({
    ok: false,
    error: 'text must not be blank after formatting',
  }),
)
test('markdown source over the limit that renders under it passes', () => {
  const result = parseApprovalRequest(
    { ...base, text: `\`${'x'.repeat(3899)}\``, format: 'markdown' },
    3900,
  )
  expect(result.ok && result.value.message.text.length).toBe(3899)
})
test('markdown rendered one over the limit fails', () =>
  expect(
    parseApprovalRequest({ ...base, text: `**${'x'.repeat(3901)}**`, format: 'markdown' }, 3900),
  ).toEqual({ ok: false, error: 'text must be at most 3900 characters after formatting' }))
test('plain over the limit keeps its message', () =>
  expect(parseApprovalRequest({ ...base, text: 'x'.repeat(3901) }, 3900)).toEqual({
    ok: false,
    error: 'text must be at most 3900 characters',
  }))
test('project shifts spans', () =>
  expect(
    parseApprovalRequest({ ...base, text: '`ls`', project: 'api', format: 'markdown' }, 3900),
  ).toMatchObject({
    ok: true,
    value: { message: { text: '[api]\n\nls', spans: [SPAN_CODE_7] } },
  }))
test('markup in project stays literal', () =>
  expect(
    parseApprovalRequest({ ...base, text: '**go**', project: '**x**', format: 'markdown' }, 3900),
  ).toMatchObject({
    ok: true,
    value: {
      message: { text: '[**x**]\n\ngo', spans: [{ kind: 'bold', offset: 9, length: 2 }] },
    },
  }))
test('markdown with project over the limit', () =>
  expect(
    parseApprovalRequest(
      { ...base, text: `**${'x'.repeat(3894)}**`, project: 'api', format: 'markdown' },
      3900,
    ),
  ).toEqual({ ok: false, error: 'text must be at most 3893 characters after formatting' }))

const text = { text: 'Which branch?', allowText: true, timeoutOption: 'main' }
const errorOf = (body: unknown) => {
  const r = parseApprovalRequest(body, 3900)
  return r.ok ? undefined : r.error
}

test('allowText without options is a text-only question', () =>
  expect(parseApprovalRequest(text, 3900)).toEqual({
    ok: true,
    value: {
      message: { text: text.text, spans: [] },
      question: text.text,
      allowText: true,
      options: [],
      timeoutOption: 'main',
      timeoutSeconds: 300,
    },
  }))
test('allowText with empty options', () =>
  expect(parseApprovalRequest({ ...text, options: [] }, 3900)).toMatchObject({
    ok: true,
    value: { options: [] },
  }))
test('allowText with options, timeoutOption not among them', () =>
  expect(parseApprovalRequest({ ...text, options: ['develop'] }, 3900)).toMatchObject({
    ok: true,
    value: { options: ['develop'], timeoutOption: 'main', allowText: true },
  }))
test.each([undefined, false])('allowText %s without options keeps the old error', (allowText) =>
  expect(errorOf({ ...text, allowText, options: undefined })).toBe(
    'options must be a non-empty array',
  ),
)
test('allowText false with empty options keeps the old error', () =>
  expect(errorOf({ ...base, allowText: false, options: [] })).toBe(
    'options must be a non-empty array',
  ))
test.each(['yes', 1, null])('allowText %s rejected', (allowText) =>
  expect(errorOf({ ...base, allowText })).toBe('allowText must be a boolean'),
)
test('allowText with non-array options', () =>
  expect(errorOf({ ...text, options: 'main' })).toBe('options must be an array'))
test('allowText keeps the option element and uniqueness rules', () => {
  expect(errorOf({ ...text, options: ['a', ''] })).toBe(
    'options must contain only non-empty strings of at most 64 characters',
  )
  expect(errorOf({ ...text, options: ['a', 'a'] })).toBe('options must be unique')
})
test.each(['', 'x'.repeat(65)])('allowText with bad timeoutOption %#', (timeoutOption) =>
  expect(errorOf({ ...text, timeoutOption })).toBe(
    'timeoutOption must be a non-empty string of at most 64 characters',
  ),
)
test('64-char timeoutOption accepted with allowText', () =>
  expect(parseApprovalRequest({ ...text, timeoutOption: 'x'.repeat(64) }, 3900).ok).toBe(true))
test('without allowText timeoutOption must still be one of options', () =>
  expect(errorOf({ ...base, timeoutOption: 'Maybe' })).toBe('timeoutOption must be one of options'))
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
