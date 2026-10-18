import { SendError } from '../approval/index.ts'
import type { MessageReference } from '../approval/index.ts'
import { NOTIFICATION_TTL_MS } from './constants.ts'
import type { Notifier, NotifyRequest } from './types.ts'

/** Sends notifications and deletes each one after `NOTIFICATION_TTL_MS` unless dismissed first. */
export class NotificationService {
  #notifier: Notifier
  #newId: () => string
  #log: (line: string) => void
  #timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    notifier: Notifier,
    newId: () => string = () => crypto.randomUUID(),
    log: (line: string) => void = console.error,
  ) {
    this.#notifier = notifier
    this.#newId = newId
    this.#log = log
  }

  /** Live notifications with a pending expiry. */
  get size(): number {
    return this.#timers.size
  }

  /**
   * Resolves once sent and the expiry timer is started. Throws `SendError` if sending fails. A failed
   * expiry delete is only logged.
   */
  async notify(request: NotifyRequest): Promise<void> {
    const id = this.#newId()
    let reference
    try {
      reference = await this.#notifier.sendNotification(id, request.text)
    } catch (cause) {
      throw new SendError('failed to send notification', { cause })
    }
    if (this.#notifier.deleteMessage === undefined) {
      return
    }
    const timer = setTimeout(() => {
      this.#timers.delete(id)
      void this.#expire(reference)
    }, NOTIFICATION_TTL_MS)
    this.#timers.set(id, timer)
  }

  /** Clears the expiry timer; false when the id is unknown or already expired. */
  dismiss(id: string): boolean {
    const timer = this.#timers.get(id)
    if (timer === undefined) {
      return false
    }
    clearTimeout(timer)
    this.#timers.delete(id)
    return true
  }

  async #expire(reference: MessageReference): Promise<void> {
    try {
      await this.#notifier.deleteMessage?.(reference)
    } catch (error) {
      this.#log(
        `failed to delete notification: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
