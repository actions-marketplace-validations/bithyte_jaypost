import { findExisting } from '../install/index.ts'
import { PromptAborted } from './prompts.ts'
import type { ResetOwnerDeps, WaitResult } from './types.ts'

export async function runResetOwner(deps: ResetOwnerDeps): Promise<number> {
  const { print } = deps
  const existing = findExisting(deps.paths, deps.targets)
  if (!existing) {
    print('Not installed. Run "telegram-approval-bot init".')
    return 1
  }
  const { rec } = existing
  const target = deps.targets[rec.target]
  try {
    if (!(await deps.confirm('This unlinks your Telegram account. Continue?', false))) return 0
    await target.clearOwner(rec)
    await target.restart(rec)
  } catch (err) {
    if (err instanceof PromptAborted || deps.signal?.aborted) {
      print('')
      return 130
    }
    print(`Reset failed. ${target.logsHint(rec)}`)
    return 1
  }
  let result: WaitResult
  try {
    result = await deps.wait({
      port: rec.port,
      isRunning: () => target.isRunning(rec),
      logsHint: target.logsHint(rec),
      ...(deps.signal ? { signal: deps.signal } : {}),
      print,
    })
  } catch {
    if (deps.signal?.aborted) {
      print('')
      return 130
    }
    print(`Waiting for pairing failed. ${target.logsHint(rec)}`)
    return 1
  }
  if (result === 'paired') {
    print('Paired. Try it: telegram-approval-bot test')
    return 0
  }
  if (result === 'interrupted') return 130
  print(target.logsHint(rec))
  return 1
}
