import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { MAX_OPTION_LENGTH, MAX_PROJECT_LENGTH, MAX_TIMEOUT_SECONDS } from '../approval/index.ts'
import { FETCH_GRACE_MS, isOutcome, postApi, toFetchTimeoutMs } from '../client/index.ts'
import { VERSION } from '../config/constants.ts'
import type { ServiceAddress } from './types.ts'

const ASK_DESCRIPTION = [
  'Ask the user a question on their phone and wait for them to tap one of the options.',
  'Use short button labels. Blocks until the user answers or the timeout passes;',
  'on timeout it returns timeout_option, so make that the safe choice.',
].join(' ')

const NOTIFY_DESCRIPTION = [
  "Tell the user something they don't need to answer, for example that a task finished",
  "or that you're stuck and need help. Returns once sent; doesn't wait for the user.",
].join(' ')

const projectNameSchema = z
  .string()
  .min(1)
  .max(MAX_PROJECT_LENGTH)
  .describe('Short name of the project you are working in, shown as [name] above the message')

const textSchema = z.string().min(1).describe('Message to show the user')

/** MCP server with ask_for_permission and notify_user; aborting `signal` cancels every call. */
export function createMcpServer(address: ServiceAddress, signal: AbortSignal): McpServer {
  const server = new McpServer({ name: 'telegram-ask', version: VERSION })
  server.registerTool(
    'ask_for_permission',
    {
      description: ASK_DESCRIPTION,
      inputSchema: {
        project_name: projectNameSchema,
        text: textSchema,
        options: z
          .array(z.string().min(1).max(MAX_OPTION_LENGTH))
          .min(1)
          .describe('Button labels, unique'),
        timeout_option: z
          .string()
          .describe('Option returned if the user does not answer in time; one of options'),
        timeout_seconds: z
          .number()
          .positive()
          .optional()
          .describe(
            `Seconds to wait for an answer; default and max ${MAX_TIMEOUT_SECONDS}, longer values are capped`,
          ),
      },
      outputSchema: { answer: z.string(), timed_out: z.boolean() },
    },
    async (args, extra): Promise<CallToolResult> => {
      const token = address.readToken()
      if (token.kind === 'unusable') {
        return toErrorResult(token.message)
      }
      const result = await postApi(
        address.port,
        '/request',
        {
          project: args.project_name,
          text: args.text,
          options: args.options,
          timeoutOption: args.timeout_option,
          ...(args.timeout_seconds === undefined ? {} : { timeout: args.timeout_seconds }),
        },
        {
          signal: AbortSignal.any([extra.signal, signal]),
          timeoutMs: toFetchTimeoutMs(args.timeout_seconds),
          ...(token.kind === 'token' ? { token: token.token } : {}),
        },
      )
      if (result.kind === 'failed') {
        return toErrorResult(result.message)
      }
      if (!isOutcome(result.body)) {
        return toErrorResult(
          `telegram-ask service sent an unreadable answer: ${JSON.stringify(result.body)}`,
        )
      }
      const { answer, timedOut } = result.body
      return {
        content: [
          {
            type: 'text',
            text: timedOut ? `${answer} (timed out, no answer from the user)` : answer,
          },
        ],
        structuredContent: { answer, timed_out: timedOut },
      }
    },
  )
  server.registerTool(
    'notify_user',
    {
      description: NOTIFY_DESCRIPTION,
      inputSchema: { project_name: projectNameSchema, text: textSchema },
    },
    async (args, extra): Promise<CallToolResult> => {
      const token = address.readToken()
      if (token.kind === 'unusable') {
        return toErrorResult(token.message)
      }
      const result = await postApi(
        address.port,
        '/notify',
        { project: args.project_name, text: args.text },
        {
          signal: AbortSignal.any([extra.signal, signal]),
          timeoutMs: FETCH_GRACE_MS,
          ...(token.kind === 'token' ? { token: token.token } : {}),
        },
      )
      if (result.kind === 'failed') {
        return toErrorResult(result.message)
      }
      return { content: [{ type: 'text', text: 'sent' }] }
    },
  )
  return server
}

/**
 * Serves MCP on stdin/stdout until stdin ends or closes, then cancels in-flight calls and closes.
 * Resolves 0. Writes nothing to stdout but JSON-RPC.
 */
export async function runMcp(address: ServiceAddress): Promise<number> {
  const controller = new AbortController()
  const server = createMcpServer(address, controller.signal)
  // The SDK transport doesn't notice the end of stdin by itself.
  const stdinDone = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve)
    process.stdin.once('close', resolve)
  })
  await server.connect(new StdioServerTransport())
  await stdinDone
  controller.abort()
  await server.close()
  return 0
}

function toErrorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}
