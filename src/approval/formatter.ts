import type { MessageEnding } from './types.ts'

function formatTime(at: Date): string {
  const hours = String(at.getHours()).padStart(2, '0')
  const minutes = String(at.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * One-line outcome shown under the request: answer, timeout, cancellation or expiry (service
 * restarted), with the local time as HH:MM.
 */
export function formatResultLine(ending: MessageEnding, at: Date): string {
  const time = formatTime(at)
  switch (ending.kind) {
    case 'answered':
      return `✅ ${ending.answer}, ${time}`
    case 'timedOut':
      return `⏱ Timed out, ${ending.answer}, ${time}`
    case 'cancelled':
      return `🚫 Cancelled, ${time}`
    case 'expired':
      return `⌛ Expired (service restarted), ${time}`
  }
}

/**
 * The original request text, a blank line, then the result line (see `formatResultLine`, including
 * the expired line); this replaces the message once ended.
 */
export function formatFinalText(original: string, ending: MessageEnding, at: Date): string {
  return `${original}\n\n${formatResultLine(ending, at)}`
}

/** The project name in brackets on its own first line, a blank line, then the text. */
export function formatProjectText(project: string, text: string): string {
  return `[${project}]\n\n${text}`
}
