import { confirm, isCancel, password, select } from '@clack/prompts'

export class PromptAborted extends Error {
  constructor() {
    super('prompt aborted')
    this.name = 'PromptAborted'
  }
}

/** The prompts the commands use; injectable so tests can fake them. */
export interface Prompts {
  confirm: (message: string, initialValue: boolean) => Promise<boolean>
  password: (message: string) => Promise<string>
  select: <T extends string>(
    message: string,
    options: { value: T; label: string; disabled?: string }[],
    initialValue: T,
  ) => Promise<T>
}

// Clack never settles on a closed or piped stdin, so refuse up front.
function requireTty(): void {
  if (!process.stdin.isTTY) throw new PromptAborted()
}

function orAbort<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) throw new PromptAborted()
  return value as Exclude<T, symbol>
}

/**
 * Clack-backed prompts. Each rejects with PromptAborted on Ctrl-C, when `signal` aborts, or when
 * stdin isn't a terminal.
 */
export function clackPrompts(signal?: AbortSignal): Prompts {
  return {
    confirm: async (message, initialValue) => {
      requireTty()
      return orAbort(await confirm({ message, initialValue, signal }))
    },
    password: async (message) => {
      requireTty()
      return orAbort(await password({ message, signal })).trim()
    },
    select: async <T extends string>(
      message: string,
      options: { value: T; label: string; disabled?: string }[],
      initialValue: T,
    ) => {
      requireTty()
      // select<string>: clack's Option<T> is a conditional type TS can't check against a generic T.
      return orAbort(
        await select<string>({
          message,
          initialValue,
          signal,
          options: options.map((o) => ({
            value: o.value,
            label: o.disabled ? `${o.label} (unavailable: ${o.disabled})` : o.label,
            disabled: o.disabled !== undefined,
          })),
        }),
      ) as T
    },
  }
}
