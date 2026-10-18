import type { TargetName } from '../install/index.ts'

export const TARGET_LABELS: Readonly<Record<TargetName, string>> = {
  quadlet: 'Podman Quadlet (user service)',
  compose: 'Docker Compose',
  systemd: 'systemd user service (npm)',
}
export const DEFAULT_START_TIMEOUT_MS = 60_000
export const POLL_INTERVAL_MS = 1000
export const STATUS_TIMEOUT_MS = 2000
export const CODE_DASH_PATTERN = /-/g
