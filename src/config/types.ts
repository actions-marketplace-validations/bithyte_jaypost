import type { z } from 'zod'
import type { fileConfigSchema } from './schema.ts'

export type Config = {
  readonly botToken: string
  readonly ownerId: number | undefined
  readonly port: number
  readonly host: string
}

export type FileConfig = Readonly<z.infer<typeof fileConfigSchema>>

/** Keys to merge into the config file; `null` deletes the key. */
export type ConfigPatch = { readonly [K in keyof FileConfig]?: FileConfig[K] | null }
