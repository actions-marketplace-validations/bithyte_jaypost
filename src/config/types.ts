import type { z } from 'zod'
import type { fileConfigSchema } from './schema.ts'

export interface Config {
  botToken: string
  ownerId: number | undefined
  port: number
  host: string
}

export type FileConfig = z.infer<typeof fileConfigSchema>
