import type { StatusInfo } from '../http.ts'
import type { InstallPaths } from '../install/paths.ts'
import type { TargetName } from '../install/state.ts'
import type { Target } from '../install/target.ts'
import { findExisting } from '../install/targets.ts'

export interface StatusDeps {
  targets: Record<TargetName, Target>
  paths: InstallPaths
  fetchStatus: (port: number) => Promise<StatusInfo | undefined>
  print: (s: string) => void
}

export async function runStatus(deps: StatusDeps): Promise<number> {
  const { print } = deps
  const existing = findExisting(deps.paths, deps.targets)
  if (!existing) {
    print('Not installed. Run "telegram-approval-bot init".')
    return 1
  }
  const { rec } = existing
  let running = false
  try {
    running = await deps.targets[rec.target].isRunning(rec)
  } catch {
    running = false
  }
  print(`Target:  ${rec.target}`)
  print(`Version: ${rec.version}`)
  print(`Port:    ${rec.port}`)
  print(`Running: ${running ? 'yes' : 'no'}`)
  if (!running) {
    print(deps.targets[rec.target].logsHint(rec))
    return 1
  }
  const status = await deps.fetchStatus(rec.port)
  if (!status) {
    print('Pairing: unknown (the service did not answer on /status yet)')
  } else if (status.paired) {
    print('Pairing: paired')
  } else {
    const raw = status.code.replace(/-/g, '')
    print(
      `Pairing: not paired\nPairing code: ${status.code}\nSend "/start ${status.code}" to @${status.bot}, or open https://t.me/${status.bot}?start=${raw}`,
    )
  }
  return 0
}
