import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** Writes `contents` to `path` via a temp file, fsync and rename, so readers never see a partial file. Creates the parent directory. On failure removes the temp file (best effort) and rethrows; an existing file is left as it was. */
export function writeFileAtomic(path: string, contents: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  try {
    const fd = openSync(temp, 'w', mode)
    try {
      writeSync(fd, contents)
      // The umask can strip bits when the file is created.
      fchmodSync(fd, mode)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Best effort: the original error is the one worth reporting.
    }
    throw error
  }
}
