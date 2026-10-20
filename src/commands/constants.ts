import type { TargetName } from '../install/index.ts'
import type { StatusFetch } from './types.ts'

/** Display names for the install target prompt. */
export const TARGET_LABELS: Readonly<Record<TargetName, string>> = {
  quadlet: 'Podman Quadlet (user service)',
  compose: 'Docker Compose',
  systemd: 'systemd user service (npm)',
  launchd: 'launchd user agent (macOS)',
}
/** How long to wait for the service to answer /status for the first time. */
export const DEFAULT_START_TIMEOUT_MS = 60_000
/** Delay between /status polls while waiting for pairing. */
export const POLL_INTERVAL_MS = 1000
/** Per-request timeout for one /status call. */
export const STATUS_TIMEOUT_MS = 2000

/** The service answered /status with 401. */
export const UNAUTHORIZED_STATUS = { kind: 'unauthorized' } as const satisfies StatusFetch
/** No usable /status answer: not up yet, a network error or an unexpected body. */
export const UNREACHABLE_STATUS = { kind: 'unreachable' } as const satisfies StatusFetch
