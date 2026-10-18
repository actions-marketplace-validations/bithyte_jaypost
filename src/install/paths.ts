import { homedir } from 'node:os'
import { join } from 'node:path'
import { configDir } from '../config.ts'

export interface InstallPaths {
  configDir: string
  configFile: string
  installFile: string
  composeDir: string
  quadletDir: string
  systemdUnit: string
  quadletUnit: string
  userNpmPrefix: string
}

function nonEmpty(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v
}

export function installPaths(env: NodeJS.ProcessEnv = process.env): InstallPaths {
  const home = nonEmpty(env.HOME) ?? homedir()
  const dir = configDir(env)
  const xdgConfig = nonEmpty(env.XDG_CONFIG_HOME) ?? join(home, '.config')
  const xdgData = nonEmpty(env.XDG_DATA_HOME) ?? join(home, '.local', 'share')
  return {
    configDir: dir,
    configFile: join(dir, 'config.json'),
    installFile: join(dir, 'install.json'),
    composeDir: join(dir, 'compose'),
    quadletDir: join(dir, 'quadlet'),
    systemdUnit: join(xdgConfig, 'systemd', 'user', 'telegram-approval-bot.service'),
    quadletUnit: join(xdgConfig, 'containers', 'systemd', 'telegram-approval-bot.container'),
    userNpmPrefix: join(xdgData, 'telegram-approval-bot', 'npm'),
  }
}
