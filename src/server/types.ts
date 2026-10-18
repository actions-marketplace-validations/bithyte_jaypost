import type { z } from 'zod'
import type { NotificationService } from '../notify/index.ts'
import type { statusInfoSchema } from './schema.ts'

/** Body of /status: paired, or the pairing code to send to the bot. */
export type StatusInfo = Readonly<z.infer<typeof statusInfoSchema>>

/** Per-provider settings of the HTTP API. */
export type ApiServerOptions = {
  readonly maxTextLength: number
  readonly providerName: string
  readonly notifications?: Pick<NotificationService, 'notify'>
}
