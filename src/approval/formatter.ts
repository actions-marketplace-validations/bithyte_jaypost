import type { Settlement } from './types.ts'

function formatTime(at: Date): string {
  const hours = String(at.getHours()).padStart(2, '0')
  const minutes = String(at.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

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

export function formatFinalText(original: string, settlement: Settlement, at: Date): string {
  return `${original}\n\n${formatResultLine(settlement, at)}`
}
