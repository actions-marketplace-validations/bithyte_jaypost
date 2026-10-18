export {
  callbackData,
  createTelegramMessenger,
  handlePairingMessage,
  makeOnPaired,
  registerPairingHandler,
  registerTapHandler,
  routeTap,
} from './adapter.ts'
export { PAIRING_ALPHABET } from './constants.ts'
export { formatCode, generateCode, Pairing } from './pairing.ts'
export type { Owner, PairResult, TapRoute } from './types.ts'
