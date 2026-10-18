import { z } from 'zod'
import type { ApprovalRequest } from './types.ts'

export const MAX_TIMEOUT_SECONDS = 300
export const MAX_OPTION_LENGTH = 64
export const MAX_TEXT_LENGTH = 3900 // leaves room for the appended result line under Telegram's 4096

export type ParseResult = { ok: true; value: ApprovalRequest } | { ok: false; error: string }

const TEXT_ERROR = 'text must be a non-empty string'
const OPTIONS_ERROR = 'options must be a non-empty array'
const OPTION_ERROR = `options must contain only non-empty strings of at most ${MAX_OPTION_LENGTH} characters`
const TIMEOUT_ERROR = 'timeout must be a finite positive number'

// Messages are part of the API (README error table); only the first issue is reported.
const approvalRequestSchema = z
  .object(
    {
      text: z
        .string({ error: TEXT_ERROR })
        .refine((t) => t.trim().length > 0, TEXT_ERROR)
        .refine(
          (t) => t.length <= MAX_TEXT_LENGTH,
          `text must be at most ${MAX_TEXT_LENGTH} characters`,
        ),
      options: z
        .array(
          z
            .string({ error: OPTION_ERROR })
            .min(1, OPTION_ERROR)
            .max(MAX_OPTION_LENGTH, OPTION_ERROR),
          {
            error: OPTIONS_ERROR,
          },
        )
        .min(1, OPTIONS_ERROR)
        .refine((o) => new Set(o).size === o.length, 'options must be unique'),
      timeoutOption: z.string({ error: 'timeoutOption must be a string' }),
      timeout: z.number({ error: TIMEOUT_ERROR }).positive(TIMEOUT_ERROR).optional(),
    },
    { error: 'body must be a JSON object' },
  )
  .refine((b) => b.options.includes(b.timeoutOption), 'timeoutOption must be one of options')
  .transform(({ text, options, timeoutOption, timeout }) => ({
    text,
    options,
    timeoutOption,
    timeoutSeconds: Math.min(timeout ?? MAX_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
  }))

export function parseApprovalRequest(body: unknown): ParseResult {
  const r = approvalRequestSchema.safeParse(body)
  if (r.success) return { ok: true, value: r.data }
  return { ok: false, error: r.error.issues[0]?.message ?? 'invalid request' }
}
