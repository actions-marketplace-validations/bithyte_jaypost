import { z } from 'zod'

export const statusInfoSchema = z.discriminatedUnion('paired', [
  z.object({ paired: z.literal(true), bot: z.string() }),
  z.object({ paired: z.literal(false), code: z.string(), bot: z.string() }),
])
