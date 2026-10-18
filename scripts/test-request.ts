import { DEFAULT_PORT, loadConfig } from '../src/config.ts'

function pickPort(): number {
  try {
    return loadConfig().port
  } catch {
    const p = Number(process.env.PORT)
    return Number.isInteger(p) && p > 0 ? p : DEFAULT_PORT
  }
}

const port = pickPort()
try {
  const res = await fetch(`http://127.0.0.1:${port}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'This is a test',
      options: ['Approve', 'Decline'],
      timeoutOption: 'Decline',
    }),
  })
  console.log(res.status, await res.text())
  if (res.status !== 200) process.exitCode = 1
} catch (e) {
  console.error(
    `Could not reach the service on port ${port} (is it running? try npm start): ${e instanceof Error ? e.message : String(e)}`,
  )
  process.exitCode = 1
}
