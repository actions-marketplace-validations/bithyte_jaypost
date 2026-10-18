import type { TargetName } from './types.ts'

export const TARGET_ORDER: TargetName[] = ['quadlet', 'compose', 'systemd']
export const SERVICE_NAME = 'telegram-approval-bot'
export const PACKAGE_NAME = 'telegram-approval-bot'
export const VOLUME_NAME = 'telegram-approval-bot-data'
export const DOCKERIGNORE = '.env\n'
export const MIN_PODMAN_MAJOR = 4
export const MIN_PODMAN_MINOR = 4
export const INTEGER_PATTERN = /^-?\d+$/
export const NOT_FOUND_PATTERN = /no such|not found|does not exist/i
export const PODMAN_VERSION_PATTERN = /(\d+)\.(\d+)(?:\.(\d+))?/
export const ENVIRONMENT_LINE_PATTERN = /^\s*Environment=(.*)$/
export const ESCAPED_CHAR_PATTERN = /\\(.)/g
