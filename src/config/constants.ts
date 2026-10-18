import packageJson from '../../package.json' with { type: 'json' }

export const VERSION: string = packageJson.version
export const DEFAULT_PORT = 8787
export const DEFAULT_HOST = '127.0.0.1'
export const INIT_HINT = 'run `telegram-approval-bot init` to set up the bot'
export const INTEGER_PATTERN = /^-?\d+$/
export const SECRET_FILE_MODE = 0o600
