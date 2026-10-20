/** Package entry for `import { Client } from 'telegram-ask'`; the CLI lives in cli.ts. */
export { Client, TelegramAskError } from './client/index.ts'
export type { Answer, AskRequest, ClientOptions, Notification } from './client/index.ts'
export { escapeMarkdown, formatCodeBlock } from './format/index.ts'
export type { MessageFormat } from './format/index.ts'
