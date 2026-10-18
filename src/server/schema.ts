import { z } from 'zod'

/**
 * Shape of the /status response; `code` is present only while unpaired. `bot` is the Telegram
 * field older CLIs read; unknown fields are kept.
 */
export const statusInfoSchema = z.discriminatedUnion('paired', [
  z.looseObject({
    paired: z.literal(true),
    provider: z.string().optional(),
    displayName: z.string().optional(),
    bot: z.string().optional(),
  }),
  z.looseObject({
    paired: z.literal(false),
    code: z.string(),
    provider: z.string().optional(),
    displayName: z.string().optional(),
    instructions: z.string().optional(),
    bot: z.string().optional(),
  }),
])
