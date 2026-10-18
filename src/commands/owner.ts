import { readConfigFile, resolveConfigPath, updateConfigFile } from '../config/index.ts'

/** Hidden helper; runs inside containers so the CLI can read/clear the owner in the data volume. */
export function runOwner(args: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  const path = resolveConfigPath(env)
  if (args[0] === 'get') {
    const id = readConfigFile(path).ownerId
    if (id !== undefined) {
      console.log(String(id))
    }
    return 0
  }
  if (args[0] === 'clear') {
    updateConfigFile(path, { ownerId: null })
    return 0
  }
  console.error('Usage: owner get|clear')
  return 2
}
