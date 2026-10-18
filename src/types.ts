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
