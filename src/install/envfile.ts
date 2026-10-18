import { readFileSync } from 'node:fs'
import { isMissingFileError, writeFileAtomic } from '../system/index.ts'
import { SECRET_FILE_MODE } from './constants.ts'

function readTextIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined
    }
    throw error
  }
}

/**
 * Parses KEY=VALUE lines, skipping blanks and comments; returns {} when the file is missing. Values
 * are taken literally (no unquoting).
 */
export function readEnvFile(path: string): Readonly<Record<string, string>> {
  const text = readTextIfPresent(path)
  if (text === undefined) {
    return {}
  }
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) {
      continue
    }
    const index = line.indexOf('=')
    if (index > 0) {
      values[line.slice(0, index)] = line.slice(index + 1)
    }
  }
  return values
}

/** Atomic write with owner-only permissions, since the file holds the bot token. */
export function writeEnvFile(path: string, contents: string): void {
  writeFileAtomic(path, contents, SECRET_FILE_MODE)
}

/**
 * Drops every `key=` line, rewriting the file atomically; does nothing when the file is missing.
 */
export function removeEnvKey(path: string, key: string): void {
  const text = readTextIfPresent(path)
  if (text === undefined) {
    return
  }
  const kept = text.split('\n').filter((line) => !line.startsWith(`${key}=`))
  writeEnvFile(path, kept.join('\n'))
}
