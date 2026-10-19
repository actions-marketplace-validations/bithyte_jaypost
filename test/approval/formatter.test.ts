import { expect, test } from 'vite-plus/test'
import {
  formatFinalText,
  formatHistoryReply,
  formatPendingReply,
  formatRejectedReply,
  formatResultLine,
  formatSummary,
} from '../../src/approval/index.ts'
import type { HistoryEntry } from '../../src/approval/index.ts'

const at = new Date(2026, 9, 18, 9, 5)
test('answered', () =>
  expect(formatResultLine({ kind: 'answered', answer: 'Approve' }, at)).toBe('✅ Approve, 09:05'))
test('timed out', () =>
  expect(formatResultLine({ kind: 'timedOut', answer: 'Decline' }, at)).toBe(
    '⏱ Timed out, Decline, 09:05',
  ))
test('cancelled', () =>
  expect(formatResultLine({ kind: 'cancelled' }, at)).toBe('🚫 Cancelled, 09:05'))
test('rejected', () =>
  expect(formatResultLine({ kind: 'rejected', answer: 'No' }, at)).toBe('⛔ Rejected, No, 09:05'))
test('formatFinalText appends line', () =>
  expect(formatFinalText('Deploy?', { kind: 'answered', answer: 'Yes' }, at)).toBe(
    'Deploy?\n\n✅ Yes, 09:05',
  ))
test('expired', () =>
  expect(formatResultLine({ kind: 'expired' }, at)).toBe('⌛ Expired (service restarted), 09:05'))

const OPENED_AT = new Date(2026, 9, 18, 9, 0, 0)
const pendingOf = (text: string, timeoutSeconds = 300, options = ['Approve', 'Decline']) => ({
  id: text,
  request: { text, options, timeoutOption: options.at(-1) ?? '', timeoutSeconds },
  openedAt: OPENED_AT,
})
const after = (ms: number) => new Date(OPENED_AT.getTime() + ms)
const secondLine = (reply: string) => reply.split('\n')[3]

test('pending reply matches the spec shape', () =>
  expect(
    formatPendingReply(
      [
        pendingOf('[deploy]\n\nDeploy to prod?', 240),
        pendingOf('Force-push main?', 40, ['Yes', 'No']),
      ],
      OPENED_AT,
      3900,
    ),
  ).toBe(
    '2 pending\n\n[deploy] Deploy to prod?\nApprove, Decline. 4 min left, then Decline\n\nForce-push main?\nYes, No. 40 s left, then No',
  ))

test('pending header for one request is singular count', () =>
  expect(formatPendingReply([pendingOf('q')], OPENED_AT, 3900).startsWith('1 pending\n\n')).toBe(
    true,
  ))

test('summary collapses whitespace and trims', () =>
  expect(formatSummary('  [ci]\n\n Retry\tflaky   job? ')).toBe('[ci] Retry flaky job?'))

test('summary of 80 characters is kept, 81 is cut to 80 with an ellipsis', () => {
  expect(formatSummary('a'.repeat(80))).toBe('a'.repeat(80))
  expect(formatSummary('a'.repeat(81))).toBe(`${'a'.repeat(79)}…`)
})

test('summary cut never splits a surrogate pair', () => {
  expect(formatSummary(`${'a'.repeat(78)}😀tail`)).toBe(`${'a'.repeat(78)}…`)
})

test('time left rounds up', () => {
  const cases = [
    [1, '1 s'],
    [59, '59 s'],
    [60, '1 min'],
    [61, '2 min'],
    [300, '5 min'],
  ] as const
  for (const [seconds, expected] of cases) {
    const reply = formatPendingReply([pendingOf('q')], after(300_000 - seconds * 1000), 3900)
    expect(secondLine(reply)).toBe(`Approve, Decline. ${expected} left, then Decline`)
  }
  expect(secondLine(formatPendingReply([pendingOf('q')], after(299_500), 3900))).toContain(
    '. 1 s left',
  )
})

test('time left past the deadline shows 1 s', () => {
  expect(secondLine(formatPendingReply([pendingOf('q')], after(301_000), 3900))).toContain(
    '. 1 s left',
  )
  expect(secondLine(formatPendingReply([pendingOf('q')], after(300_000), 3900))).toContain(
    '. 1 s left',
  )
})

test('options line is cut at 80', () => {
  const options = Array.from(
    { length: 10 },
    (_, index) => `Option ${String(index).padStart(2, '0')}`,
  )
  const line = secondLine(formatPendingReply([pendingOf('q', 300, options)], OPENED_AT, 3900))
  expect(line?.startsWith(`${options.join(', ').slice(0, 79)}…. `)).toBe(true)
})

test('rejected reply matches the spec shape', () =>
  expect(
    formatRejectedReply(
      [pendingOf('[deploy]\n\nDeploy to prod?'), pendingOf('Force-push main?', 40, ['Yes', 'No'])],
      3900,
    ),
  ).toBe('Rejected 2\n\n[deploy] Deploy to prod?\n→ Decline\n\nForce-push main?\n→ No'))

test('history reply matches the spec shape', () => {
  const entries: readonly HistoryEntry[] = [
    {
      text: '[deploy]\n\nDeploy to prod?',
      settlement: { kind: 'answered', answer: 'Approve' },
      settledAt: new Date(2026, 9, 18, 14, 5),
    },
    {
      text: 'Force-push main?',
      settlement: { kind: 'rejected', answer: 'No' },
      settledAt: new Date(2026, 9, 18, 14, 1),
    },
    {
      text: '[ci]\n\nRetry flaky job?',
      settlement: { kind: 'timedOut', answer: 'Skip' },
      settledAt: new Date(2026, 9, 18, 13, 50),
    },
  ]
  expect(formatHistoryReply(entries, 3900)).toBe(
    'Last 3\n\n[deploy] Deploy to prod?\n✅ Approve, 14:05\n\nForce-push main?\n⛔ Rejected, No, 14:01\n\n[ci] Retry flaky job?\n⏱ Timed out, Skip, 13:50',
  )
})

test('empty replies', () => {
  expect(formatPendingReply([], OPENED_AT, 3900)).toBe('Nothing pending.')
  expect(formatRejectedReply([], 3900)).toBe('Nothing pending.')
  expect(formatHistoryReply([], 3900)).toBe('No answers since the service started.')
})

test('length cap lists whole entries and the trailer within the limit', () => {
  const pending = Array.from({ length: 30 }, (_, index) => pendingOf(`q${index}`, 300, ['Ok']))
  const reply = formatPendingReply(pending, OPENED_AT, 120)
  expect(reply.length).toBeLessThanOrEqual(120)
  expect(reply.startsWith('30 pending\n\nq0\n')).toBe(true)
  const shown = reply.split('\n\n').slice(1, -1)
  expect(shown.length).toBeGreaterThan(0)
  expect(reply.endsWith(`\n\n…and ${30 - shown.length} more`)).toBe(true)
  for (const entry of shown) {
    expect(entry).toMatch(/^q\d+\nOk\. 5 min left, then Ok$/)
  }
})

test('length cap leaves a reply that fits untouched', () => {
  const pending = [pendingOf('q0', 300, ['Ok']), pendingOf('q1', 300, ['Ok'])]
  const full = formatPendingReply(pending, OPENED_AT, 3900)
  expect(formatPendingReply(pending, OPENED_AT, full.length)).toBe(full)
  expect(formatPendingReply(pending, OPENED_AT, full.length - 1)).toMatch(/…and 1 more$/)
})
