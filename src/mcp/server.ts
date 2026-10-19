import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_OPTION_LENGTH,
  MAX_PROJECT_LENGTH,
  MAX_TIMEOUT_SECONDS,
  MAX_WAIT_SECONDS,
} from '../approval/index.ts'
import {
  callApi,
  describeUnknownRequest,
  FETCH_GRACE_MS,
  isStateBody,
  postApi,
  requestApi,
} from '../client/index.ts'
import type { ApiOptions, AskBody, StateBody } from '../client/index.ts'
import { VERSION } from '../config/constants.ts'
import {
  CANCELLED_QUESTION_TEXT,
  PROGRESS_INTERVAL_MS,
  PROGRESS_MESSAGE,
  STILL_WAITING_TEXT,
} from './constants.ts'
import { OpenQuestions } from './questions.ts'
import type { AskArguments, McpServerOptions, PollResult, ServiceAddress } from './types.ts'

const ASK_DESCRIPTION = [
  'Ask the user a question on their phone and wait for them to tap one of the options.',
  'Use short button labels. Blocks until the user answers or the timeout passes;',
  'on timeout it returns timeout_option, so make that the safe choice.',
  `Default wait ${DEFAULT_TIMEOUT_SECONDS} s, max ${MAX_TIMEOUT_SECONDS} s (24 h).`,
].join(' ')

const ASK_IN_BACKGROUND_DESCRIPTION = [
  'Ask the user a question on their phone and return at once with a request_id;',
  'call wait_for_answer with it when you need the answer.',
  'Use this when you have other work to do before you need the answer, or when a long blocking',
  'call is not possible; otherwise use ask_for_permission.',
  'On timeout the answer is timeout_option, so make that the safe choice.',
  `Default timeout ${DEFAULT_TIMEOUT_SECONDS} s, max ${MAX_TIMEOUT_SECONDS} s (24 h).`,
  'Questions still open when this session ends are cancelled.',
].join(' ')

const WAIT_DESCRIPTION = [
  'Wait for the answer to a question asked with ask_for_permission_in_background.',
  'Without wait_seconds it waits until the user answers or the question times out;',
  'wait_seconds 0 checks once. Results stay readable for 24 h after the question settles.',
  'Cancelling this call stops waiting but leaves the question open.',
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

const askInputSchema = {
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
      `Seconds to wait for an answer; default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS} (24 h); longer values are capped`,
    ),
}

/**
 * MCP server with ask_for_permission, ask_for_permission_in_background, wait_for_answer and
 * notify_user; aborting `signal` cancels every call. Background questions it asks go into
 * `options.openQuestions`.
 */
export function createMcpServer(
  address: ServiceAddress,
  signal: AbortSignal,
  options: McpServerOptions = {},
): McpServer {
  const progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS
  const openQuestions = options.openQuestions ?? new OpenQuestions()
  const server = new McpServer({ name: 'telegram-ask', version: VERSION })
  server.registerTool(
    'ask_for_permission',
    {
      description: ASK_DESCRIPTION,
      inputSchema: askInputSchema,
      outputSchema: { answer: z.string(), timed_out: z.boolean() },
    },
    async (args, extra): Promise<CallToolResult> => {
      const token = address.readToken()
      if (token.kind === 'unusable') {
        return toErrorResult(token.message)
      }
      const stopProgress = startProgress(
        extra,
        Math.min(args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
        progressIntervalMs,
      )
      const result = await requestApi(address.port, toAskBody(args), {
        signal: AbortSignal.any([extra.signal, signal]),
        ...(token.kind === 'token' ? { token: token.token } : {}),
      }).finally(stopProgress)
      if (result.kind === 'failed') {
        return toErrorResult(result.message)
      }
      const { answer, timedOut } = result.outcome
      return {
        content: [{ type: 'text', text: formatAnswer(answer, timedOut) }],
        structuredContent: { answer, timed_out: timedOut },
      }
    },
  )
  server.registerTool(
    'ask_for_permission_in_background',
    {
      description: ASK_IN_BACKGROUND_DESCRIPTION,
      inputSchema: askInputSchema,
      outputSchema: { request_id: z.string(), expires_at: z.string() },
    },
    async (args, extra): Promise<CallToolResult> => {
      const token = address.readToken()
      if (token.kind === 'unusable') {
        return toErrorResult(token.message)
      }
      const result = await callApi(address.port, 'POST', '/request/async', toAskBody(args), {
        signal: AbortSignal.any([extra.signal, signal]),
        timeoutMs: FETCH_GRACE_MS,
        ...(token.kind === 'token' ? { token: token.token } : {}),
      })
      if (result.kind === 'failed') {
        return toErrorResult(result.message)
      }
      if (!isStateBody(result.body) || result.body.state !== 'pending') {
        return toErrorResult(describeUnreadable(result.body))
      }
      const { id, expiresAt } = result.body
      openQuestions.add(id)
      return {
        content: [
          {
            type: 'text',
            text: `Asked. Call wait_for_answer with request_id ${id} when you need the answer (expires ${expiresAt}).`,
          },
        ],
        structuredContent: { request_id: id, expires_at: expiresAt },
      }
    },
  )
  server.registerTool(
    'wait_for_answer',
    {
      description: WAIT_DESCRIPTION,
      inputSchema: {
        request_id: z
          .string()
          .min(1)
          .describe('The request_id from ask_for_permission_in_background'),
        wait_seconds: z
          .number()
          .min(0)
          .optional()
          .describe(
            `Seconds to wait at most; omit to wait until the question settles, 0 checks once; max ${MAX_TIMEOUT_SECONDS} (24 h), longer values are capped`,
          ),
      },
      outputSchema: {
        state: z.enum(['pending', 'done', 'cancelled']),
        answer: z.string().optional(),
        timed_out: z.boolean().optional(),
      },
    },
    async (args, extra): Promise<CallToolResult> => {
      const token = address.readToken()
      if (token.kind === 'unusable') {
        return toErrorResult(token.message)
      }
      const waitSeconds =
        args.wait_seconds === undefined
          ? undefined
          : Math.min(args.wait_seconds, MAX_TIMEOUT_SECONDS)
      const path = `/request/${encodeURIComponent(args.request_id)}` as const
      const stopProgress = startProgress(extra, waitSeconds, progressIntervalMs)
      const result = await pollState(
        address.port,
        path,
        waitSeconds === undefined ? undefined : performance.now() + waitSeconds * 1000,
        {
          signal: AbortSignal.any([extra.signal, signal]),
          ...(token.kind === 'token' ? { token: token.token } : {}),
        },
      ).finally(stopProgress)
      if (result.kind === 'failed') {
        if (result.message === describeUnknownRequest(path.slice('/request/'.length))) {
          openQuestions.settle(args.request_id)
        }
        return toErrorResult(result.message)
      }
      if (result.state.state !== 'pending') {
        openQuestions.settle(args.request_id)
      }
      return toWaitResult(result.state)
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
 * Serves MCP on stdin/stdout until stdin ends or closes, then cancels in-flight calls, cancels the
 * background questions it asked that haven't settled (best effort, bounded by
 * `CANCEL_TIMEOUT_MS`), and closes. Resolves 0. Writes nothing to stdout but JSON-RPC.
 */
export async function runMcp(address: ServiceAddress): Promise<number> {
  const controller = new AbortController()
  const openQuestions = new OpenQuestions()
  const server = createMcpServer(address, controller.signal, { openQuestions })
  // The SDK transport doesn't notice the end of stdin by itself.
  const stdinDone = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve)
    process.stdin.once('close', resolve)
  })
  await server.connect(new StdioServerTransport())
  await stdinDone
  controller.abort()
  await openQuestions.cancelAll(address)
  await server.close()
  return 0
}

// Keeps the client's idle timeout from firing; does nothing without a progress token.
function startProgress(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  totalSeconds: number | undefined,
  intervalMs: number,
): () => void {
  const progressToken = extra._meta?.progressToken
  if (progressToken === undefined) {
    return () => {}
  }
  const startedAt = performance.now()
  const timer = setInterval(() => {
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: Math.floor((performance.now() - startedAt) / 1000),
          ...(totalSeconds === undefined ? {} : { total: totalSeconds }),
          message: PROGRESS_MESSAGE,
        },
      })
      .catch(() => {
        // The connection is closing; the call is being cancelled anyway.
      })
  }, intervalMs)
  return () => clearInterval(timer)
}

/**
 * Long-polls a background question until it settles, or until `deadlineMs` (`performance.now()`
 * time) passes; no deadline waits until it settles. Polls once when the deadline is already due.
 */
async function pollState(
  port: number,
  path: `/request/${string}`,
  deadlineMs: number | undefined,
  options: Omit<ApiOptions, 'timeoutMs'>,
): Promise<PollResult> {
  for (;;) {
    const remainingSeconds =
      deadlineMs === undefined
        ? MAX_WAIT_SECONDS
        : Math.max(0, (deadlineMs - performance.now()) / 1000)
    const waitSeconds = Math.min(remainingSeconds, MAX_WAIT_SECONDS)
    const result = await callApi(port, 'GET', `${path}?wait=${waitSeconds}`, undefined, {
      ...options,
      timeoutMs: waitSeconds * 1000 + FETCH_GRACE_MS,
    })
    if (result.kind === 'failed') {
      return result
    }
    if (!isStateBody(result.body)) {
      return { kind: 'failed', message: describeUnreadable(result.body) }
    }
    const isDue = deadlineMs !== undefined && performance.now() >= deadlineMs
    if (result.body.state !== 'pending' || isDue) {
      return { kind: 'ok', state: result.body }
    }
  }
}

function toWaitResult(state: StateBody): CallToolResult {
  switch (state.state) {
    case 'pending':
      return {
        content: [{ type: 'text', text: STILL_WAITING_TEXT }],
        structuredContent: { state: 'pending' },
      }
    case 'done':
      return {
        content: [{ type: 'text', text: formatAnswer(state.answer, state.timedOut) }],
        structuredContent: { state: 'done', answer: state.answer, timed_out: state.timedOut },
      }
    case 'cancelled':
      return {
        content: [{ type: 'text', text: CANCELLED_QUESTION_TEXT }],
        structuredContent: { state: 'cancelled' },
      }
  }
}

function toAskBody(args: AskArguments): AskBody {
  return {
    project: args.project_name,
    text: args.text,
    options: args.options,
    timeoutOption: args.timeout_option,
    ...(args.timeout_seconds === undefined ? {} : { timeout: args.timeout_seconds }),
  }
}

function formatAnswer(answer: string, timedOut: boolean): string {
  return timedOut ? `${answer} (timed out, no answer from the user)` : answer
}

function describeUnreadable(body: unknown): string {
  return `telegram-ask service sent an unreadable answer: ${JSON.stringify(body)}`
}

function toErrorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}
