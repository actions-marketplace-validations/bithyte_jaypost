import { readInstall } from '../install/index.ts'

/** Port from install.json when present, else the fallback. */
export async function runTest(fallbackPort: number, installFile?: string): Promise<number> {
  const port = (installFile ? readInstall(installFile)?.port : undefined) ?? fallbackPort
  try {
    const response = await fetch(`http://127.0.0.1:${port}/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'This is a test',
        options: ['Approve', 'Decline'],
        timeoutOption: 'Decline',
      }),
    })
    console.log(response.status, await response.text())
    return response.status === 200 ? 0 : 1
  } catch (error) {
    console.error(
      `could not reach the service on port ${port} (is it running? try telegram-approval-bot status): ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }
}
