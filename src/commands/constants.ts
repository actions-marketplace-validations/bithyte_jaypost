import type { TargetName } from '../install/index.ts'

/** Display names for the install target prompt. */
export const TARGET_LABELS: Readonly<Record<TargetName, string>> = {
  quadlet: 'Podman Quadlet (user service)',
  compose: 'Docker Compose',
  systemd: 'systemd user service (npm)',
}
/** How long to wait for the service to answer /status for the first time. */
export const DEFAULT_START_TIMEOUT_MS = 60_000
/** Delay between /status polls while waiting for pairing. */
export const POLL_INTERVAL_MS = 1000
/** Per-request timeout for one /status call. */
export const STATUS_TIMEOUT_MS = 2000
/** Strips the dash from a displayed pairing code to build the t.me deep link. */
export const CODE_DASH_PATTERN = /-/g
