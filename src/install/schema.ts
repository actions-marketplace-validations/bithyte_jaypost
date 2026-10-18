import { z } from 'zod'

/** Shape of install.json. */
export const installRecordSchema = z.object({
  target: z.enum(['systemd', 'compose', 'quadlet']),
  port: z.number(),
  version: z.string(),
  /** Absent in installs from 0.1.x, which are Telegram. */
  provider: z.string().optional(),
  cliPath: z.string().optional(),
  /** Absolute config.json path the systemd unit was installed with. */
  configFile: z.string().optional(),
})
