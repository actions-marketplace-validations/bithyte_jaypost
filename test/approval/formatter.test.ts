import { expect, test } from 'vite-plus/test'
import { formatFinalText, formatResultLine } from '../../src/approval/index.ts'

const at = new Date(2026, 9, 18, 9, 5)
test('answered', () =>
  expect(formatResultLine({ kind: 'answered', answer: 'Approve' }, at)).toBe('✅ Approve, 09:05'))
test('timed out', () =>
  expect(formatResultLine({ kind: 'timedOut', answer: 'Decline' }, at)).toBe(
    '⏱ Timed out, Decline, 09:05',
  ))
test('cancelled', () =>
  expect(formatResultLine({ kind: 'cancelled' }, at)).toBe('🚫 Cancelled, 09:05'))
test('formatFinalText appends line', () =>
  expect(formatFinalText('Deploy?', { kind: 'answered', answer: 'Yes' }, at)).toBe(
    'Deploy?\n\n✅ Yes, 09:05',
  ))
