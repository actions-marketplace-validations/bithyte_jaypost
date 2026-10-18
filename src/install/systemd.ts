import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { readConfigFile, updateConfigFile } from '../config/index.ts'
import { ensureLinger } from '../system/index.ts'
import {
  CONFIG_ENV_PREFIX,
  ENVIRONMENT_LINE_PATTERN,
  ESCAPED_CHAR_PATTERN,
  PACKAGE_NAME,
  SERVICE_NAME,
} from './constants.ts'
import { formatSystemdUnit } from './templates.ts'
import type {
  CliLocation,
  InstallOptions,
  InstallPaths,
  InstallRecord,
  Secrets,
  Target,
  TargetDeps,
} from './types.ts'

function isUnder(file: string, root: string): boolean {
  return root !== '' && file.startsWith(root.endsWith(sep) ? root : root + sep)
}

function isWritable(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The config file a systemd install uses when nothing recorded one: $APPROVAL_BOT_CONFIG or the default, absolute. */
export function resolveDefaultConfigFile(paths: InstallPaths, env: NodeJS.ProcessEnv): string {
  return resolve(env.APPROVAL_BOT_CONFIG || paths.configFile)
}

/** Best-effort read of the APPROVAL_BOT_CONFIG value from a unit's Environment= lines. */
export function findUnitConfigFile(unit: string): string | undefined {
  for (const line of unit.split('\n')) {
    const rawValue = ENVIRONMENT_LINE_PATTERN.exec(line)?.[1]
    if (rawValue === undefined) {
      continue
    }
    const trimmed = rawValue.trim()
    const unquoted =
      trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1).replace(ESCAPED_CHAR_PATTERN, '$1')
        : trimmed
    const value = unquoted.replaceAll('%%', '%')
    if (value.startsWith(CONFIG_ENV_PREFIX) && value.length > CONFIG_ENV_PREFIX.length) {
      return resolve(value.slice(CONFIG_ENV_PREFIX.length))
    }
  }
  return undefined
}

export function createSystemdTarget(deps: TargetDeps, cli: CliLocation): Target {
  const { exec, paths, env, user } = deps
  const systemctl = (...args: string[]) => exec('systemctl', ['--user', ...args])
  // The unit always pins APPROVAL_BOT_CONFIG to this absolute path, and install.json records it,
  // so later commands don't depend on the environment they happen to run in.
  const configFile = resolveDefaultConfigFile(paths, env)
  const resolveConfigFile = (record: InstallRecord) => record.configFile ?? configFile
  const fallbackRoot = join(paths.userNpmPrefix, 'lib', 'node_modules')

  async function resolveCli(options: InstallOptions): Promise<string> {
    const root = (await exec('npm', ['root', '-g'])).stdout.trim()
    if (isUnder(cli.selfPath, root)) {
      options.print(`Using the installed CLI at ${cli.selfPath}`)
      return cli.selfPath
    }
    if (isUnder(cli.selfPath, fallbackRoot)) {
      options.print(`Using the installed CLI at ${cli.selfPath}`)
      return cli.selfPath
    }
    const packageSpec = options.tarball ?? `${PACKAGE_NAME}@${options.version}`
    const prefix = (await exec('npm', ['prefix', '-g'])).stdout.trim()
    let installRoot: string
    let args: string[]
    if (prefix !== '' && isWritable(prefix)) {
      options.print(`Installing ${packageSpec} globally with npm`)
      args = ['i', '-g', packageSpec]
      installRoot = root
    } else {
      options.print(
        `Global npm prefix isn't writable; installing ${packageSpec} into ${paths.userNpmPrefix}`,
      )
      mkdirSync(paths.userNpmPrefix, { recursive: true })
      args = ['i', '-g', '--prefix', paths.userNpmPrefix, packageSpec]
      installRoot = fallbackRoot
    }
    const result = await exec('npm', args)
    if (result.code !== 0) {
      throw new Error(`npm install failed: ${result.stderr.trim()}`)
    }
    return join(installRoot, PACKAGE_NAME, 'dist', 'cli.js')
  }

  return {
    name: 'systemd',
    async available() {
      const result = await systemctl('show-environment')
      return result.code === 0
        ? { ok: true }
        : { ok: false, reason: 'systemd user session not available' }
    },
    async install(options): Promise<InstallRecord> {
      const cliPath = await resolveCli(options)
      // Only touch ownerId when we have one; clearOwner is the explicit way to drop it.
      updateConfigFile(configFile, {
        botToken: options.token,
        port: options.port,
        ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
      })
      mkdirSync(dirname(paths.systemdUnit), { recursive: true })
      writeFileSync(
        paths.systemdUnit,
        formatSystemdUnit({ node: cli.nodePath, cli: cliPath, config: configFile }),
      )
      for (const args of [['daemon-reload'], ['enable', '--now', SERVICE_NAME]]) {
        const result = await systemctl(...args)
        if (result.code !== 0) {
          throw new Error(`systemctl ${args.join(' ')} failed: ${result.stderr.trim()}`)
        }
      }
      await ensureLinger(exec, user, options.print)
      return {
        target: 'systemd',
        port: options.port,
        version: options.version,
        cliPath,
        configFile,
      }
    },
    async readSecrets(record): Promise<Secrets> {
      const config = readConfigFile(resolveConfigFile(record))
      return {
        ...(config.botToken === undefined ? {} : { token: config.botToken }),
        ...(config.ownerId === undefined ? {} : { ownerId: config.ownerId }),
      }
    },
    async remove(record, purge) {
      await systemctl('disable', '--now', SERVICE_NAME)
      rmSync(paths.systemdUnit, { force: true })
      await systemctl('daemon-reload')
      if (purge) {
        rmSync(resolveConfigFile(record), { force: true })
        const prefix =
          record.cliPath !== undefined && isUnder(record.cliPath, fallbackRoot)
            ? `--prefix ${paths.userNpmPrefix} `
            : ''
        console.log(
          `The npm package was left in place; remove it with: npm rm -g ${prefix}${PACKAGE_NAME}`,
        )
      }
    },
    async restart() {
      const result = await systemctl('restart', SERVICE_NAME)
      if (result.code !== 0) {
        throw new Error(`systemctl restart failed (exit ${result.code})`)
      }
    },
    async clearOwner(record) {
      updateConfigFile(resolveConfigFile(record), { ownerId: null })
    },
    async isRunning() {
      return (await systemctl('is-active', '--quiet', SERVICE_NAME)).code === 0
    },
    logsHint() {
      return `journalctl --user -u ${SERVICE_NAME} -f`
    },
  }
}
