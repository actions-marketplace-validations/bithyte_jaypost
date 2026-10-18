import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
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
    .filter((l) => !l.startsWith(`${key}=`))
  writeEnvFile(path, kept.join('\n'))
}
