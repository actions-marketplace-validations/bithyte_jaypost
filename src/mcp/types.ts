import type { ClientToken } from '../auth/index.ts'

/** Where the service listens and how to find the token; `readToken` runs once per tool call. */
export type ServiceAddress = {
  readonly port: number
  readonly readToken: () => ClientToken
}
