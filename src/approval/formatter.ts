import { SUMMARY_MAX_LENGTH } from './constants.ts'
import type { HistoryEntry, MessageEnding, PendingSummary } from './types.ts'

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
    case 'rejected':
      return `⛔ Rejected, ${ending.answer}, ${time}`
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

const HIGH_SURROGATE_START = 0xd800
const HIGH_SURROGATE_END = 0xdbff

function truncate(text: string): string {
  if (text.length <= SUMMARY_MAX_LENGTH) {
    return text
  }
  const lastKept = text.charCodeAt(SUMMARY_MAX_LENGTH - 2)
  const isSplittingPair = lastKept >= HIGH_SURROGATE_START && lastKept <= HIGH_SURROGATE_END
  const keep = isSplittingPair ? SUMMARY_MAX_LENGTH - 2 : SUMMARY_MAX_LENGTH - 1
  return `${text.slice(0, keep)}…`
}

function formatTimeLeft(summary: PendingSummary, now: Date): string {
  const remainingMs =
    summary.openedAt.getTime() + summary.request.timeoutSeconds * 1000 - now.getTime()
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000))
  if (seconds < 60) {
    return `${seconds} s`
  }
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) {
    return `${minutes} min`
  }
  const rest = minutes % 60
  return rest === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${rest} min`
}

function capReply(header: string, entries: readonly string[], maxTextLength: number): string {
  const full = [header, ...entries].join('\n\n')
  if (full.length <= maxTextLength) {
    return full
  }
  const formatTrailer = (left: number): string => `\n\n…and ${left} more`
  const limit = maxTextLength - formatTrailer(entries.length).length
  let text = header
  let shownCount = 0
  for (const entry of entries) {
    const next = `${text}\n\n${entry}`
    if (next.length > limit) {
      break
    }
    text = next
    shownCount += 1
  }
  return `${text}${formatTrailer(entries.length - shownCount)}`
}

/** One line of a request's text: whitespace collapsed, cut to 80 characters with an ellipsis. */
export function formatSummary(text: string): string {
  return truncate(text.replace(/\s+/g, ' ').trim())
}

/**
 * The `/pending` reply: each open request with its options, time left and timeout answer. Fits in
 * `maxTextLength`, dropping trailing entries for an "and N more" line. Never throws.
 */
export function formatPendingReply(
  pending: readonly PendingSummary[],
  now: Date,
  maxTextLength: number,
): string {
  if (pending.length === 0) {
    return 'Nothing pending.'
  }
  const entries = pending.map((summary) => {
    const options = truncate(summary.request.options.join(', '))
    const timeLeft = formatTimeLeft(summary, now)
    return `${formatSummary(summary.request.text)}\n${options}. ${timeLeft} left, then ${summary.request.timeoutOption}`
  })
  return capReply(`${pending.length} pending`, entries, maxTextLength)
}

/** The `/cancel` reply: what was rejected and with which answer. Never throws. */
export function formatRejectedReply(
  rejected: readonly PendingSummary[],
  maxTextLength: number,
): string {
  if (rejected.length === 0) {
    return 'Nothing pending.'
  }
  const entries = rejected.map(
    (summary) => `${formatSummary(summary.request.text)}\n→ ${summary.request.timeoutOption}`,
  )
  return capReply(`Rejected ${rejected.length}`, entries, maxTextLength)
}

/** The `/history` reply for `entries` (newest first), each with its result line. Never throws. */
export function formatHistoryReply(
  entries: readonly HistoryEntry[],
  maxTextLength: number,
): string {
  if (entries.length === 0) {
    return 'No answers since the service started.'
  }
  const lines = entries.map(
    (entry) =>
      `${formatSummary(entry.text)}\n${formatResultLine(entry.settlement, entry.settledAt)}`,
  )
  return capReply(`Last ${entries.length}`, lines, maxTextLength)
}
