import { z } from 'zod'
import { STATE_VERSION } from './constants.ts'

// z.unknown() accepts a missing key, so reject undefined explicitly.
const referenceSchema = z.unknown().refine((value) => value !== undefined)

export const stateFileSchema = z.object({
  version: z.literal(STATE_VERSION),
  provider: z.string(),
  requests: z.array(z.object({ id: z.string(), reference: referenceSchema, text: z.string() })),
  notifications: z.array(
    z.object({ id: z.string(), reference: referenceSchema, expiresAtMs: z.number().finite() }),
  ),
})
