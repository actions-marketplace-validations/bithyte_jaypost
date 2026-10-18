import { z } from 'zod'

// Loose: unknown keys survive updateConfigFile's read-modify-write.
export const fileConfigSchema = z.looseObject({
  botToken: z.string().optional(),
  ownerId: z.number().optional(),
  port: z.number().optional(),
})
