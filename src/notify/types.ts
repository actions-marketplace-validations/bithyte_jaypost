import type { MessageReference } from '../approval/index.ts'
import type { NotificationRecord } from '../state/index.ts'

/** As produced by `parseNotifyRequest`. */
export type NotifyRequest = {
  readonly text: string
}

/** Outcome of validating a /notify body; `error` is the client-facing message. */
export type NotifyParseResult =
  | { readonly ok: true; readonly value: NotifyRequest }
  | { readonly ok: false; readonly error: string }

/** How a notification is delivered; `silent` suppresses the sound and vibration. */
export type SendNotificationOptions = {
  readonly silent: boolean
}

/**
 * Optional messenger part for notifications. Without `deleteMessage` there's no dismiss button and
 * no expiry.
 */
export type Notifier = {
  /** Send `text` to the owner with a dismiss control carrying `id`, if the messenger can delete. */
  readonly sendNotification: (
    id: string,
    text: string,
    options: SendNotificationOptions,
  ) => Promise<MessageReference>
  readonly deleteMessage?: (reference: MessageReference) => Promise<void>
}

/** Where live notifications are saved so a restart can still expire them; calls must not throw. */
export type NotificationStore = {
  readonly addNotification: (record: NotificationRecord) => void
  readonly removeNotification: (id: string) => void
}

/** Where quiet periods come from; `QuietService` satisfies it structurally. */
export type QuietSource = {
  /** When the current quiet period ends, or undefined when not quiet. */
  readonly quietUntil: () => Date | undefined
}

/**
 * Optional collaborators of `NotificationService`; `now` is the wall clock in epoch ms. Without
 * `quiet` it's never quiet.
 */
export type NotificationServiceOptions = {
  readonly quiet?: QuietSource
  readonly store?: NotificationStore
  readonly now?: () => number
}
