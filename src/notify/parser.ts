import { z } from 'zod'
import { requestTextSchema } from '../approval/index.ts'
import type { NotifyParseResult } from './types.ts'

const notifyRequestSchema = z.object(
  { text: requestTextSchema },
  { error: 'body must be a JSON object' },
)

/** Validates a /notify body; never throws. Returns the first problem as `error`. */
export function parseNotifyRequest(body: unknown): NotifyParseResult {
  const result = notifyRequestSchema.safeParse(body)
  if (result.success) {
    return { ok: true, value: result.data }
  }
  return { ok: false, error: result.error.issues[0]?.message ?? 'invalid request' }
}
