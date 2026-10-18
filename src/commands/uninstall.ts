import { findExisting, removeInstall } from '../install/index.ts'
import { PromptAborted } from './prompts.ts'
import type { UninstallDeps } from './types.ts'

export async function runUninstall(deps: UninstallDeps): Promise<number> {
  const { print } = deps
  const existing = findExisting(deps.paths, deps.targets)
  if (!existing) {
    print('Not installed.')
    return 0
  }
  const { rec } = existing
  try {
    const purge = await deps.confirm('Also delete the bot token and paired owner?', false)
    await deps.targets[rec.target].remove(rec, purge)
    removeInstall(deps.paths.installFile)
  } catch (err) {
    if (err instanceof PromptAborted || deps.signal?.aborted) {
      print('')
      return 130
    }
    print('Uninstall failed. Check the service logs and try again.')
    return 1
  }
  print('Uninstalled.')
  return 0
}
