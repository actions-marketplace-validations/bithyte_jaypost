import { z } from 'zod'
import { MAX_OPTION_LENGTH, MAX_TEXT_LENGTH, MAX_TIMEOUT_SECONDS } from './constants.ts'
import type { ParseResult } from './types.ts'

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
        .refine((text) => text.trim().length > 0, TEXT_ERROR)
        .refine(
          (text) => text.length <= MAX_TEXT_LENGTH,
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
        .refine((options) => new Set(options).size === options.length, 'options must be unique'),
      timeoutOption: z.string({ error: 'timeoutOption must be a string' }),
      timeout: z.number({ error: TIMEOUT_ERROR }).positive(TIMEOUT_ERROR).optional(),
    },
    { error: 'body must be a JSON object' },
  )
  .refine(
    (body) => body.options.includes(body.timeoutOption),
    'timeoutOption must be one of options',
  )
  .transform(({ text, options, timeoutOption, timeout }) => ({
    text,
    options,
    timeoutOption,
    timeoutSeconds: Math.min(timeout ?? MAX_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
  }))

export function parseApprovalRequest(body: unknown): ParseResult {
  const result = approvalRequestSchema.safeParse(body)
  if (result.success) {
    return { ok: true, value: result.data }
  }
  return { ok: false, error: result.error.issues[0]?.message ?? 'invalid request' }
}
