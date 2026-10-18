import { z } from 'zod'

export const installRecordSchema = z.object({
  target: z.enum(['systemd', 'compose', 'quadlet']),
  port: z.number(),
  version: z.string(),
  cliPath: z.string().optional(),
  /** Absolute config.json path the systemd unit was installed with. */
  configFile: z.string().optional(),
})
