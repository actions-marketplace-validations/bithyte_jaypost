import type { Settlement } from './types.ts'

function formatTime(at: Date): string {
  const hours = String(at.getHours()).padStart(2, '0')
  const minutes = String(at.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * One-line outcome shown under the request: answer, timeout or cancellation, with the local time as
 * HH:MM.
 */
export function formatResultLine(settlement: Settlement, at: Date): string {
  const time = formatTime(at)
  switch (settlement.kind) {
    case 'answered':
      return `✅ ${settlement.answer}, ${time}`
    case 'timedOut':
      return `⏱ Timed out, ${settlement.answer}, ${time}`
    case 'cancelled':
      return `🚫 Cancelled, ${time}`
  }
}

/**
 * The original request text, a blank line, then the result line; this replaces the message once
 * settled.
 */
export function formatFinalText(original: string, settlement: Settlement, at: Date): string {
  return `${original}\n\n${formatResultLine(settlement, at)}`
}

/** The project name in brackets on its own first line, a blank line, then the text. */
export function formatProjectText(project: string, text: string): string {
  return `[${project}]\n\n${text}`
}
