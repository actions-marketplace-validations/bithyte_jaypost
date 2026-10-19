import { removeTokenFile } from '../auth/index.ts'
import { findExistingInstall, removeInstall } from '../install/index.ts'
import { PromptAborted } from './prompts.ts'
import type { UninstallDeps } from './types.ts'

/**
 * Removes the service after asking whether to purge the credentials, API token and owner. Returns
 * 0 on success or when nothing is installed, 1 on failure, 130 on interrupt.
 */
export async function runUninstall(deps: UninstallDeps): Promise<number> {
  const { print } = deps
  const existing = findExistingInstall(deps.paths, deps.targets)
  if (!existing) {
    print('Not installed.')
    return 0
  }
  const { record } = existing
  try {
    const purge = await deps.confirm(
      'Also delete the saved credentials, API token and paired owner?',
      false,
    )
    await deps.targets[record.target].remove(record, purge)
    removeInstall(deps.paths.installFile)
    if (purge) {
      removeTokenFile(deps.paths.tokenFile)
    }
  } catch (error) {
    if (error instanceof PromptAborted || deps.signal?.aborted) {
      print('')
      return 130
    }
    print('Uninstall failed. Check the service logs and try again.')
    return 1
  }
  print('Uninstalled.')
  return 0
}
