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
export { PAIRING_ALPHABET } from './constants.ts'
export { formatCode, generateCode, Pairing } from './pairing.ts'
export type { Dismiss, Owner, PairingMessage, PairResult, TapRoute } from './types.ts'
