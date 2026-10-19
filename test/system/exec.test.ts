import { expect, test } from 'vite-plus/test'
import { realExec } from '../../src/system/index.ts'

// Writes the two bytes of "é" in separate writes, so they reach the parent as separate chunks.
const SPLIT_CHARACTER_SCRIPT = `
const [first, second] = Buffer.from('é')
process.stdout.write(Buffer.of(first))
process.stderr.write(Buffer.of(first))
setTimeout(() => {
  process.stdout.write(Buffer.of(second))
  process.stderr.write(Buffer.of(second))
}, 50)
`

test('realExec keeps a multi-byte character split across chunks intact', async () => {
  const result = await realExec(process.execPath, ['-e', SPLIT_CHARACTER_SCRIPT])
  expect(result).toEqual({ code: 0, stdout: 'é', stderr: 'é' })
})
