import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from '../system/index.ts'
import { SECRET_FILE_MODE } from './constants.ts'

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
  writeFileAtomic(path, contents, SECRET_FILE_MODE)
}

export function removeEnvKey(path: string, key: string): void {
  if (!existsSync(path)) return
  const kept = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith(`${key}=`))
  writeEnvFile(path, kept.join('\n'))
}
