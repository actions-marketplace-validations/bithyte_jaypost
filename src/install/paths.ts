import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveConfigDirectory } from '../config/index.ts'
import type { InstallPaths } from './types.ts'

function toNonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

export function resolveInstallPaths(env: NodeJS.ProcessEnv = process.env): InstallPaths {
  const home = toNonEmpty(env.HOME) ?? homedir()
  const configDirectory = resolveConfigDirectory(env)
  const xdgConfigHome = toNonEmpty(env.XDG_CONFIG_HOME) ?? join(home, '.config')
  const xdgDataHome = toNonEmpty(env.XDG_DATA_HOME) ?? join(home, '.local', 'share')
  return {
    configDirectory,
    configFile: join(configDirectory, 'config.json'),
    installFile: join(configDirectory, 'install.json'),
    composeDirectory: join(configDirectory, 'compose'),
    quadletDirectory: join(configDirectory, 'quadlet'),
    systemdUnit: join(xdgConfigHome, 'systemd', 'user', 'telegram-approval-bot.service'),
    quadletUnit: join(xdgConfigHome, 'containers', 'systemd', 'telegram-approval-bot.container'),
    userNpmPrefix: join(xdgDataHome, 'telegram-approval-bot', 'npm'),
  }
}
