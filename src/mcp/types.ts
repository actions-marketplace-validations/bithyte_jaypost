import type { ClientToken } from '../auth/index.ts'
import type { StateBody } from '../client/index.ts'
import type { MessageFormat } from '../format/index.ts'
import type { OpenQuestions } from './questions.ts'

/** Where the service listens and how to find the token; `readToken` runs once per tool call. */
export type ServiceAddress = {
  readonly port: number
  readonly readToken: () => ClientToken
}

/** Tuning for `createMcpServer`; every field is optional. */
export type McpServerOptions = {
  readonly progressIntervalMs?: number
  /** Where background questions are recorded for the shutdown cancel; default a fresh set. */
  readonly openQuestions?: OpenQuestions
}

/** The `attachment` input of the ask and notify tools: a file path or literal text. */
export type AttachmentArgument =
  | { readonly path: string; readonly name?: string | undefined }
  | { readonly text: string; readonly name?: string | undefined }

/** Arguments of the two ask tools, as the MCP SDK hands them over. */
export type AskArguments = {
  readonly project_name: string
  readonly text: string
  readonly format?: MessageFormat | undefined
  readonly options?: readonly string[] | undefined
  readonly allow_text?: boolean | undefined
  readonly timeout_option: string
  readonly timeout_seconds?: number | undefined
  readonly attachment?: AttachmentArgument | undefined
}

/** Outcome of polling a background question; `message` is ready to show the agent. */
export type PollResult =
  | { readonly kind: 'ok'; readonly state: StateBody }
  | { readonly kind: 'failed'; readonly message: string }
