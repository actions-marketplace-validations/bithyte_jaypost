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
