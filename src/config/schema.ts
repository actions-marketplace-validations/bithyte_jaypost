import { z } from 'zod'

/** Loose so unknown keys survive `updateConfigFile`'s read-modify-write. */
export const fileConfigSchema = z.looseObject({
  provider: z.string().optional(),
  port: z.number().optional(),
})
