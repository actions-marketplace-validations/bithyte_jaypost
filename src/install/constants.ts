import type { TargetName } from './types.ts'

/** Preference order; the first available target is the default. */
export const TARGET_ORDER: readonly TargetName[] = ['quadlet', 'compose', 'systemd']
/** Name of the systemd unit and container. */
export const SERVICE_NAME = 'telegram-ask'
/** npm package name, also the container's command. */
export const PACKAGE_NAME = 'telegram-ask'
/** Podman volume holding /data (the config file). */
export const VOLUME_NAME = 'telegram-ask-data'
/** Keeps the .env file with the credentials out of the image build context. */
export const DOCKERIGNORE = '.env\n'
/** Quadlet needs podman 4.4 or newer (major part). */
export const MIN_PODMAN_MAJOR = 4
/** Quadlet needs podman 4.4 or newer (minor part). */
export const MIN_PODMAN_MINOR = 4
/** A carriage return or newline, which an env file value must not contain. */
export const LINE_BREAK_PATTERN = /[\r\n]/
/** podman stderr meaning the thing is already gone, which purge treats as success. */
export const NOT_FOUND_PATTERN = /no such|not found|does not exist/i
/** Captures major, minor and optional patch from `podman --version`. */
export const PODMAN_VERSION_PATTERN = /(\d+)\.(\d+)(?:\.(\d+))?/
/** Matches an `Environment=` line in a unit file. */
export const ENVIRONMENT_LINE_PATTERN = /^\s*Environment=(.*)$/
/** Matches a backslash escape inside a quoted unit value. */
export const ESCAPED_CHAR_PATTERN = /\\(.)/g
/** Variable the unit sets to pin the config file path. */
export const CONFIG_ENV_PREFIX = 'TELEGRAM_ASK_CONFIG='
/** Owner read/write only, for files that hold credentials. */
export const SECRET_FILE_MODE = 0o600
