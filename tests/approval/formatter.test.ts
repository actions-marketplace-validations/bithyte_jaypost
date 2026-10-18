import { expect, test } from 'vite-plus/test'
import { finalText, resultLine } from '../../src/approval/index.ts'

const at = new Date(2026, 9, 18, 9, 5)
test('answered', () =>
  expect(resultLine({ kind: 'answered', answer: 'Approve' }, at)).toBe('✅ Approve, 09:05'))
test('timed out', () =>
  expect(resultLine({ kind: 'timedOut', answer: 'Decline' }, at)).toBe(
    '⏱ Timed out, Decline, 09:05',
  ))
test('cancelled', () => expect(resultLine({ kind: 'cancelled' }, at)).toBe('🚫 Cancelled, 09:05'))
test('finalText appends line', () =>
  expect(finalText('Deploy?', { kind: 'answered', answer: 'Yes' }, at)).toBe(
    'Deploy?\n\n✅ Yes, 09:05',
  ))
