import type { z } from 'zod'
import type { ApiAuth } from '../auth/index.ts'
import type { NotificationService } from '../notify/index.ts'
import type { statusInfoSchema } from './schema.ts'

/** Body of /status: paired, or the pairing code to send to the bot. */
export type StatusInfo = Readonly<z.infer<typeof statusInfoSchema>>

/** Per-provider settings of the HTTP API. */
export type ApiServerOptions = {
  readonly maxTextLength: number
  readonly providerName: string
  /** With a token, /request, /notify and /status answer 401 unless it is presented. */
  readonly auth: ApiAuth
  readonly notifications?: Pick<NotificationService, 'notify'>
}

/** What varies between installs in the OpenAPI document. */
export type OpenApiOptions = {
  readonly port: number
  readonly maxTextLength: number
}
