import { callApi } from '../client/index.ts'
import { CANCEL_TIMEOUT_MS } from './constants.ts'
import type { ServiceAddress } from './types.ts'

/**
 * Background questions this MCP server asked and hasn't seen settle. They belong to the agent
 * session, so `cancelAll` cancels them when the session ends.
 */
export class OpenQuestions {
  #ids = new Set<string>()

  add(id: string): void {
    this.#ids.add(id)
  }

  settle(id: string): void {
    this.#ids.delete(id)
  }

  /**
   * DELETEs every open question in parallel and forgets them. Gives up after `timeoutMs`; skips
   * silently when the token is unusable. Never rejects.
   */
  async cancelAll(address: ServiceAddress, timeoutMs: number = CANCEL_TIMEOUT_MS): Promise<void> {
    const ids = [...this.#ids]
    this.#ids.clear()
    if (ids.length === 0) {
      return
    }
    const token = address.readToken()
    if (token.kind === 'unusable') {
      return
    }
    const signal = new AbortController().signal
    // callApi never throws and aborts each call after timeoutMs, so this is bounded too.
    await Promise.all(
      ids.map((id) =>
        callApi(address.port, 'DELETE', `/request/${encodeURIComponent(id)}`, undefined, {
          signal,
          timeoutMs,
          ...(token.kind === 'token' ? { token: token.token } : {}),
        }),
      ),
    )
  }
}
