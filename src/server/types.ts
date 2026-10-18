import type { z } from 'zod'
import type { statusInfoSchema } from './schema.ts'

export type StatusInfo = Readonly<z.infer<typeof statusInfoSchema>>
