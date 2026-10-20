/** Shared mutable cell: pairing sets `id`, and the messenger and tap handler read it live. */
export type Owner = {
  id: number | undefined
}

/** What happened to a button tap: not from the owner, handled, or no longer valid. */
export type TapRoute = 'ignored' | 'accepted' | 'expired'

/** Who sent a command and where; `fromId` is absent for channel posts. */
export type CommandMessage = {
  readonly fromId: number | undefined
  readonly chatType: string
}

/** The parts of an incoming Telegram message that pairing looks at. */
export type PairingMessage = {
  readonly fromId: number
  readonly chatType: string
  readonly text: string
}

/**
 * Records an answer for request `id`; 'expired' when it is unknown, already settled, or the option
 * index is invalid.
 */
export type Tap = (id: string, optionIndex: number) => 'accepted' | 'expired'

/**
 * Settles request `id` with typed text; 'expired' when it is unknown or already settled.
 */
export type Reply = (id: string, text: string) => 'accepted' | 'expired'

/** What `routeReply` decided; only 'accepted' settled a request. */
export type ReplyRoute =
  | 'ignored'
  | 'accepted'
  | 'expired'
  | 'buttonsOnly'
  | 'notOpen'
  | 'ambiguous'
  | 'notText'

/** The parts of a Telegram message that routing needs; the reply-to is in the same chat. */
export type IncomingMessage = {
  readonly fromId: number | undefined
  readonly chatType: string
  readonly chatId: number
  readonly text: string | undefined
  readonly replyTo: { readonly messageId: number; readonly fromId: number | undefined } | undefined
}

/** Clears the expiry of notification `id`; false when it is unknown or already expired. */
export type Dismiss = (id: string) => boolean

/** What `MessageReference` holds for Telegram; cast back at the messenger's edge. */
export type TelegramMessageReference = {
  readonly chatId: number
  readonly messageId: number
  /** Absent in references saved before text replies (and on notifications); absent means true. */
  readonly hasButtons?: boolean
}

/** A request awaiting an answer, keyed by `formatMessageKey` in `OpenQuestions`. */
export type OpenQuestion = {
  readonly id: string
  readonly allowText: boolean
}

/** Open questions by `formatMessageKey`: set after send, deleted in `finalize`. */
export type OpenQuestions = Map<string, OpenQuestion>
