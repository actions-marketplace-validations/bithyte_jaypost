import { z } from 'zod'
import { DEFAULT_FORMAT, MESSAGE_FORMATS, toFormattedText } from '../format/index.ts'
import type { FormattedText, MessageFormat } from '../format/index.ts'
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_OPTION_LENGTH,
  MAX_PROJECT_LENGTH,
  MAX_TIMEOUT_SECONDS,
  MAX_WAIT_SECONDS,
} from './constants.ts'
import { formatProjectText } from './formatter.ts'
import type { ParseResult, WaitParseResult } from './types.ts'

const TEXT_ERROR = 'text must be a non-empty string'
const OPTIONS_ERROR = 'options must be a non-empty array'
const OPTION_ERROR = `options must contain only non-empty strings of at most ${MAX_OPTION_LENGTH} characters`
const PROJECT_ERROR = 'project must be a non-empty string'
const FORMAT_ERROR = 'format must be "plain" or "markdown"'
export const BLANK_FORMATTED_ERROR = 'text must not be blank after formatting'
const TIMEOUT_ERROR = 'timeout must be a finite positive number'
const WAIT_ERROR = 'wait must be a non-negative number'

/** Non-empty (after trim) text; shared by /request and /notify. Length is checked by `checkProjectText`. */
export function createTextSchema() {
  return z.string({ error: TEXT_ERROR }).refine((text) => text.trim().length > 0, TEXT_ERROR)
}

/** Optional project name, trimmed, non-empty, at most `MAX_PROJECT_LENGTH` characters. */
export function createProjectSchema() {
  return z
    .string({ error: PROJECT_ERROR })
    .trim()
    .min(1, PROJECT_ERROR)
    .max(MAX_PROJECT_LENGTH, `project must be at most ${MAX_PROJECT_LENGTH} characters`)
    .optional()
}

/** Optional `format` of the text: `plain` (the default) or `markdown`; shared by /request and /notify. */
export function createFormatSchema() {
  return z.enum(MESSAGE_FORMATS, { error: FORMAT_ERROR }).optional()
}

/**
 * Applies the length limit to the rendered message text; with a project, checks the combined text
 * and returns it. Markdown limits say "after formatting", since the source may be longer. Never
 * throws.
 */
export function checkProjectText(
  message: FormattedText,
  project: string | undefined,
  maxTextLength: number,
  format: MessageFormat,
):
  | { readonly ok: true; readonly message: FormattedText }
  | { readonly ok: false; readonly error: string } {
  const suffix = format === 'markdown' ? ' after formatting' : ''
  if (project === undefined) {
    return message.text.length <= maxTextLength
      ? { ok: true, message }
      : { ok: false, error: `text must be at most ${maxTextLength} characters${suffix}` }
  }
  const combined = formatProjectText(project, message)
  if (combined.text.length > maxTextLength) {
    return {
      ok: false,
      error: `text must be at most ${maxTextLength - (project.length + 4)} characters${suffix}`,
    }
  }
  return { ok: true, message: combined }
}

/**
 * Schema of a /request body; also the source of the OpenAPI spec. Messages are part of the API
 * (README error table); only the first issue is reported.
 */
export function createApprovalRequestSchema(maxTextLength: number) {
  return z
    .object(
      {
        text: createTextSchema(),
        project: createProjectSchema(),
        format: createFormatSchema(),
        allowText: z.boolean({ error: 'allowText must be a boolean' }).optional(),
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
          .refine((options) => new Set(options).size === options.length, 'options must be unique')
          .optional(),
        timeoutOption: z.string({ error: 'timeoutOption must be a string' }),
        timeout: z.number({ error: TIMEOUT_ERROR }).positive(TIMEOUT_ERROR).optional(),
      },
      { error: 'body must be a JSON object' },
    )
    .superRefine((body, context) => {
      if (body.allowText !== true) {
        if (body.options === undefined || body.options.length === 0) {
          context.addIssue({ code: 'custom', message: OPTIONS_ERROR })
          return
        }
        if (!body.options.includes(body.timeoutOption)) {
          context.addIssue({ code: 'custom', message: 'timeoutOption must be one of options' })
        }
        return
      }
      if (body.timeoutOption.length < 1 || body.timeoutOption.length > MAX_OPTION_LENGTH) {
        context.addIssue({
          code: 'custom',
          message: `timeoutOption must be a non-empty string of at most ${MAX_OPTION_LENGTH} characters`,
        })
      }
    })
    .transform(({ text, project, format, allowText, options, timeoutOption, timeout }, context) => {
      const message = toFormattedText(text, format ?? DEFAULT_FORMAT)
      if (message.text.trim() === '') {
        context.addIssue({ code: 'custom', message: BLANK_FORMATTED_ERROR })
        return z.NEVER
      }
      const checked = checkProjectText(message, project, maxTextLength, format ?? DEFAULT_FORMAT)
      if (!checked.ok) {
        context.addIssue({ code: 'custom', message: checked.error })
        return z.NEVER
      }
      return {
        message: checked.message,
        question: text,
        ...(project === undefined ? {} : { project }),
        allowText: allowText ?? false,
        options: options ?? [],
        timeoutOption,
        timeoutSeconds: Math.min(timeout ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
      }
    })
}

/**
 * Validates a request body; never throws. Returns the first problem as `error`, and clamps
 * `timeout` to `MAX_TIMEOUT_SECONDS`; absent means `DEFAULT_TIMEOUT_SECONDS`. `text` may be up to
 * `maxTextLength`.
 */
export function parseApprovalRequest(body: unknown, maxTextLength: number): ParseResult {
  const result = createApprovalRequestSchema(maxTextLength).safeParse(body)
  if (result.success) {
    return { ok: true, value: result.data }
  }
  const issue = result.error.issues[0]
  // zod can't pick a field's type-error message from a sibling field
  if (
    issue?.code === 'invalid_type' &&
    issue.path.length === 1 &&
    issue.path[0] === 'options' &&
    typeof body === 'object' &&
    body !== null &&
    'allowText' in body &&
    body.allowText === true
  ) {
    return { ok: false, error: 'options must be an array' }
  }
  return { ok: false, error: issue?.message ?? 'invalid request' }
}

/**
 * Validates a `wait` query value in seconds; never throws. Absent means 0, values above
 * `MAX_WAIT_SECONDS` are clamped, and anything but a finite non-negative number string is an error.
 */
export function parseWaitSeconds(raw: unknown): WaitParseResult {
  if (raw === undefined) {
    return { ok: true, seconds: 0 }
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: WAIT_ERROR }
  }
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) {
    return { ok: false, error: WAIT_ERROR }
  }
  // Math.max turns '-0' into 0.
  return { ok: true, seconds: Math.max(0, Math.min(seconds, MAX_WAIT_SECONDS)) }
}
