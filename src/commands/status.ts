import { findExistingInstall } from '../install/index.ts'
import { formatPairingText } from './pairing-text.ts'
import type { StatusDeps } from './types.ts'

/**
 * Prints install, running and pairing state. Returns 0 only when installed and running; 1
 * otherwise.
 */
export async function runStatus(deps: StatusDeps): Promise<number> {
  const { print } = deps
  const existing = findExistingInstall(deps.paths, deps.targets)
  if (!existing) {
    print('Not installed. Run "telegram-ask init".')
    return 1
  }
  const { record } = existing
  let running = false
  try {
    running = await deps.targets[record.target].isRunning(record)
  } catch {
    running = false
  }
  print(`Target:  ${record.target}`)
  print(`Version: ${record.version}`)
  print(`Port:    ${record.port}`)
  print(`Running: ${running ? 'yes' : 'no'}`)
  if (!running) {
    print(deps.targets[record.target].logsHint(record))
    return 1
  }
  const status = await deps.fetchStatus(record.port)
  if (!status) {
    print('Pairing: unknown (the service did not answer on /status yet)')
  } else if (status.paired) {
    print('Pairing: paired')
  } else {
    print(`Pairing: not paired
${formatPairingText(status)}`)
  }
  return 0
}
