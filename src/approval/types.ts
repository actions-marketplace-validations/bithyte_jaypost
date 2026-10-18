export interface ApprovalRequest {
  text: string
  options: string[]
  timeoutOption: string
  timeoutSeconds: number
}

export interface Outcome {
  answer: string
  timedOut: boolean
}

export type Settlement =
  | { kind: 'answered'; answer: string }
  | { kind: 'timedOut'; answer: string }
  | { kind: 'cancelled' }

export type ParseResult = { ok: true; value: ApprovalRequest } | { ok: false; error: string }

export interface MessageRef {
  chatId: number
  messageId: number
}

export interface Messenger {
  sendRequest(id: string, text: string, options: string[]): Promise<MessageRef>
  /** Replace the message text and remove its buttons. */
  finalize(ref: MessageRef, text: string): Promise<void>
}

export interface PendingEntry {
  req: ApprovalRequest
  timer: ReturnType<typeof setTimeout>
  resolve: (settlement: Settlement) => void
}
