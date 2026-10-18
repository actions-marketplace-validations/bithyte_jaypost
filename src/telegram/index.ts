export {
  createOnPaired,
  createTelegramMessenger,
  formatCallbackData,
  formatDismissData,
  handlePairingMessage,
  parseDismissData,
  registerPairingHandler,
  registerTapHandler,
  routeTap,
} from './adapter.ts'
export type { Dismiss, Owner, PairingMessage, TapRoute } from './types.ts'
export { telegramProvider } from './provider.ts'
export { validateToken } from './setup.ts'
