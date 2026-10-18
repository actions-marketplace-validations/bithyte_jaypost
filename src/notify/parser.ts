import { z } from 'zod'
import { createTextSchema } from '../approval/index.ts'
import type { NotifyParseResult } from './types.ts'

/** Validates a /notify body; never throws. Returns the first problem as `error`. */
export function parseNotifyRequest(body: unknown, maxTextLength: number): NotifyParseResult {
  const schema = z.object(
    { text: createTextSchema(maxTextLength) },
    { error: 'body must be a JSON object' },
  )
  const result = schema.safeParse(body)
  if (result.success) {
    return { ok: true, value: result.data }
  }
  return { ok: false, error: result.error.issues[0]?.message ?? 'invalid request' }
}
