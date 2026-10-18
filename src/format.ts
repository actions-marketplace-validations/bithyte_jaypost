import type { Settlement } from './types.ts'

function hhmm(at: Date): string {
  const h = String(at.getHours()).padStart(2, '0')
  const m = String(at.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

export function resultLine(s: Settlement, at: Date): string {
  const time = hhmm(at)
  switch (s.kind) {
    case 'answered':
      return `✅ ${s.answer}, ${time}`
    case 'timedOut':
      return `⏱ Timed out, ${s.answer}, ${time}`
    case 'cancelled':
      return `🚫 Cancelled, ${time}`
  }
}

export function finalText(original: string, s: Settlement, at: Date): string {
  return `${original}\n\n${resultLine(s, at)}`
}
