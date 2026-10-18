import { z } from 'zod'

/** Shape of the /status response; `code` is present only while unpaired. */
export const statusInfoSchema = z.discriminatedUnion('paired', [
  z.object({ paired: z.literal(true), bot: z.string() }),
  z.object({ paired: z.literal(false), code: z.string(), bot: z.string() }),
])
