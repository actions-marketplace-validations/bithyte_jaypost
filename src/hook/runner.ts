import { MAX_TIMEOUT_SECONDS } from '../approval/index.ts'
import type { ClientToken } from '../auth/index.ts'
import { FETCH_GRACE_MS, isOutcome, postApi, toFetchTimeoutMs } from '../client/index.ts'
import { ASK_IN_TERMINAL_OPTION, ASK_USER_QUESTION_TOOL } from './constants.ts'
import { decidePermission, formatNotificationText, formatPermissionQuestion } from './formatter.ts'
import { parseHookEvent } from './parser.ts'
import { resolveHookProject } from './project.ts'
import type { HookArgs, HookDeps, NotificationEvent, PermissionRequestEvent } from './types.ts'

/** Handles one hook event from stdin. Returns 0 when handled, 1 on any failure (stderr says why). */
export async function runHook(args: HookArgs, deps: HookDeps): Promise<number> {
  if (deps.token.kind === 'unusable') {
    deps.printError(`telegram-ask: ${deps.token.message}`)
    return 1
  }
  let input: string
  try {
    input = await deps.readInput()
  } catch (error) {
    if (!deps.signal.aborted) {
      const message = error instanceof Error ? error.message : String(error)
      deps.printError(`telegram-ask: couldn't read the hook input: ${message}`)
    }
    return 1
  }
  const parsed = parseHookEvent(input)
  if (parsed.kind === 'invalid') {
    deps.printError(`telegram-ask: ${parsed.message}`)
    return 1
  }
  const event = parsed.event
  const project = resolveHookProject(args.project, deps.env, event.cwd)
  switch (event.kind) {
    case 'Notification':
      return notify(event, project, deps)
    case 'PermissionRequest':
      return askPermission(event, project, args, deps)
  }
}

async function notify(event: NotificationEvent, project: string, deps: HookDeps): Promise<number> {
  const result = await postApi(
    deps.port,
    '/notify',
    { project, text: formatNotificationText(event) },
    { signal: deps.signal, timeoutMs: FETCH_GRACE_MS, ...toTokenOption(deps.token) },
  )
  if (result.kind === 'failed') {
    return reportFailure(result.message, deps)
  }
  return 0
}

async function askPermission(
  event: PermissionRequestEvent,
  project: string,
  args: HookArgs,
  deps: HookDeps,
): Promise<number> {
  // A plain allow doesn't answer it, so the terminal keeps it (spec non-goal).
  if (event.toolName === ASK_USER_QUESTION_TOOL) {
    return 0
  }
  const question = formatPermissionQuestion(event)
  const result = await postApi(
    deps.port,
    '/request',
    {
      project,
      text: question.text,
      options: question.options,
      timeoutOption: ASK_IN_TERMINAL_OPTION,
      timeout: args.timeout ?? MAX_TIMEOUT_SECONDS,
    },
    {
      signal: deps.signal,
      timeoutMs: toFetchTimeoutMs(args.timeout),
      ...toTokenOption(deps.token),
    },
  )
  if (result.kind === 'failed') {
    return reportFailure(result.message, deps)
  }
  if (!isOutcome(result.body)) {
    deps.printError(
      `telegram-ask: service sent an unreadable answer: ${JSON.stringify(result.body)}`,
    )
    return 1
  }
  const decision = decidePermission(event, question.options, result.body)
  switch (decision.kind) {
    case 'decided':
      deps.print(JSON.stringify(decision.output))
      return 0
    case 'undecided':
      return 0
    case 'unknownAnswer':
      deps.printError(`telegram-ask: unexpected answer ${JSON.stringify(decision.answer)}`)
      return 1
  }
}

/** Killed hooks stay silent: the abort is ours, not a failure worth reporting. */
function reportFailure(message: string, deps: HookDeps): number {
  if (!deps.signal.aborted) {
    deps.printError(`telegram-ask: ${message}`)
  }
  return 1
}

function toTokenOption(token: ClientToken): { readonly token?: string } {
  return token.kind === 'token' ? { token: token.token } : {}
}
