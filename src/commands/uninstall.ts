import { PromptAborted } from '../install/prompt.ts'
import type { Prompts } from '../install/prompt.ts'
import type { InstallPaths } from '../install/paths.ts'
import { removeInstall } from '../install/state.ts'
import type { TargetName } from '../install/state.ts'
import type { Target } from '../install/target.ts'
import { findExisting } from '../install/targets.ts'

export interface UninstallDeps {
  targets: Record<TargetName, Target>
  paths: InstallPaths
  confirm: Prompts['confirm']
  print: (s: string) => void
  signal?: AbortSignal
}

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
