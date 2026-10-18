import type { z } from 'zod'
import type { statusInfoSchema } from './schema.ts'

export type StatusInfo = z.infer<typeof statusInfoSchema>
