export interface MessageRef {
  chatId: number
  messageId: number
}

export interface Messenger {
  sendRequest(id: string, text: string, options: string[]): Promise<MessageRef>
  /** Replace the message text and remove its buttons. */
  finalize(ref: MessageRef, text: string): Promise<void>
}
