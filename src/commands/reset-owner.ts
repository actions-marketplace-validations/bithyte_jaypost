import { findExistingInstall } from '../install/index.ts'
import { PromptAborted } from './prompts.ts'
import type { ResetOwnerDeps, WaitResult } from './types.ts'

/**
 * Unlinks the paired owner, restarts the service and waits for a new pairing. Returns 0 on success
 * or if the user declines, 1 on failure or not installed, 130 on interrupt.
 */
export async function runResetOwner(deps: ResetOwnerDeps): Promise<number> {
  const { print } = deps
  const existing = findExistingInstall(deps.paths, deps.targets)
  if (!existing) {
    print('Not installed. Run "telegram-approval-bot init".')
    return 1
  }
  const { record } = existing
  const target = deps.targets[record.target]
  try {
    if (!(await deps.confirm('This unlinks your Telegram account. Continue?', false))) {
      return 0
    }
    await target.clearOwner(record)
    await target.restart(record)
  } catch (error) {
    if (error instanceof PromptAborted || deps.signal?.aborted) {
      print('')
      return 130
    }
    print(`Reset failed. ${target.logsHint(record)}`)
    return 1
  }
  let result: WaitResult
  try {
    result = await deps.wait({
      port: record.port,
      isRunning: () => target.isRunning(record),
      logsHint: target.logsHint(record),
      ...(deps.signal ? { signal: deps.signal } : {}),
      print,
    })
  } catch {
    if (deps.signal?.aborted) {
      print('')
      return 130
    }
    print(`Waiting for pairing failed. ${target.logsHint(record)}`)
    return 1
  }
  if (result === 'paired') {
    print('Paired. Try it: telegram-approval-bot test')
    return 0
  }
  if (result === 'interrupted') {
    return 130
  }
  print(target.logsHint(record))
  return 1
}
