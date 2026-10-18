import { z } from 'zod'
import { checkProjectText, createProjectSchema, createTextSchema } from '../approval/index.ts'
import type { NotifyParseResult } from './types.ts'

/** Validates a /notify body; never throws. Returns the first problem as `error`. */
export function parseNotifyRequest(body: unknown, maxTextLength: number): NotifyParseResult {
  const schema = z
    .object(
      { text: createTextSchema(), project: createProjectSchema() },
      { error: 'body must be a JSON object' },
    )
    .transform(({ text, project }, context) => {
      const checked = checkProjectText(text, project, maxTextLength)
      if (!checked.ok) {
        context.addIssue({ code: 'custom', message: checked.error })
        return z.NEVER
      }
      return { text: checked.text }
    })
  const result = schema.safeParse(body)
  if (result.success) {
    return { ok: true, value: result.data }
  }
  return { ok: false, error: result.error.issues[0]?.message ?? 'invalid request' }
}
