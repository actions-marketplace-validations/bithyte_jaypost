import { expect, test } from 'vite-plus/test'
import {
  collectSettings,
  findOwnerSetting,
  hasRequiredSecrets,
  listSecretValues,
  PROVIDERS,
  requireProvider,
} from '../../src/provider/index.ts'

const telegram = requireProvider(PROVIDERS, 'telegram')

test('requireProvider rejects an unknown name', () => {
  expect(() => requireProvider(PROVIDERS, 'slack')).toThrow(
    'unknown provider "slack"; run `telegram-ask init`',
  )
})

test('findOwnerSetting finds the owner setting', () => {
  expect(findOwnerSetting(telegram)?.configKey).toBe('ownerId')
})

test('collectSettings skips invalid values', () => {
  const read = (values: Record<string, unknown>) =>
    collectSettings(telegram, (setting) => values[setting.configKey])
  expect(read({ botToken: '', ownerId: 'x' })).toEqual({})
  expect(read({ botToken: 't', ownerId: '42' })).toEqual({ botToken: 't', ownerId: 42 })
})

test('listSecretValues returns only secret values', () => {
  expect(listSecretValues(telegram, { botToken: 't', ownerId: 42 })).toEqual(['t'])
})

test('hasRequiredSecrets needs every required secret', () => {
  expect(hasRequiredSecrets(telegram, { botToken: 't' })).toBe(true)
  expect(hasRequiredSecrets(telegram, { ownerId: 42 })).toBe(false)
})
