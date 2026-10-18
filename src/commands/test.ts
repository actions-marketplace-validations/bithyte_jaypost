import { readInstall } from '../install/state.ts'

/** Port from install.json when present, else the fallback. */
export async function runTest(fallbackPort: number, installFile?: string): Promise<number> {
  const port = (installFile ? readInstall(installFile)?.port : undefined) ?? fallbackPort
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
    return res.status === 200 ? 0 : 1
  } catch (e) {
    console.error(
      `Could not reach the service on port ${port} (is it running? try telegram-approval-bot status): ${e instanceof Error ? e.message : String(e)}`,
    )
    return 1
  }
}
