import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readEnvFile(path: string): Readonly<Record<string, string>> {
  if (!existsSync(path)) return {}
  const values: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1)
  }
  return values
}

export function writeEnvFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function removeEnvKey(path: string, key: string): void {
  if (!existsSync(path)) return
  const kept = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith(`${key}=`))
  writeEnvFile(path, kept.join('\n'))
}
