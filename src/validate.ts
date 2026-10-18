import type { ApprovalRequest } from './types.ts'

export const MAX_TIMEOUT_SECONDS = 300
export const MAX_TEXT_LENGTH = 3900 // leaves room for the appended result line under Telegram's 4096

export type ParseResult = { ok: true; value: ApprovalRequest } | { ok: false; error: string }

const fail = (error: string): ParseResult => ({ ok: false, error })

export function parseApprovalRequest(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('body must be a JSON object')
  }
  const { text, options, timeoutOption, timeout } = body as Record<string, unknown>

  if (typeof text !== 'string' || text.length === 0) return fail('text must be a non-empty string')
  if (text.length > MAX_TEXT_LENGTH) {
    return fail(`text must be at most ${MAX_TEXT_LENGTH} characters`)
  }

  if (!Array.isArray(options) || options.length === 0) {
    return fail('options must be a non-empty array')
  }
  if (!options.every((o): o is string => typeof o === 'string' && o.length > 0)) {
    return fail('options must contain only non-empty strings')
  }
  if (new Set(options).size !== options.length) return fail('options must be unique')

  if (typeof timeoutOption !== 'string') return fail('timeoutOption must be a string')
  if (!options.includes(timeoutOption)) return fail('timeoutOption must be one of options')

  let timeoutSeconds = MAX_TIMEOUT_SECONDS
  if (timeout !== undefined) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      return fail('timeout must be a finite positive number')
    }
    timeoutSeconds = Math.min(timeout, MAX_TIMEOUT_SECONDS)
  }

  return { ok: true, value: { text, options, timeoutOption, timeoutSeconds } }
}
