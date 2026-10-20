import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { readAuditFiles, removeAuditFiles, resolveAuditPath } from '../audit/index.ts'
import { readConfigFile, updateConfigFile } from '../config/index.ts'
import { collectSettings, DEFAULT_PROVIDER, findProvider } from '../provider/index.ts'
import type { Provider } from '../provider/index.ts'
import { resolveStatePath } from '../state/index.ts'
import { ensureLinger, isMissingFileError } from '../system/index.ts'
import {
  CONFIG_ENV_PREFIX,
  ENVIRONMENT_LINE_PATTERN,
  ESCAPED_CHAR_PATTERN,
  EXEC_START_LINE_PATTERN,
  EXECUTABLE_MODE,
  PACKAGE_NAME,
  PATH_HINT,
  SERVICE_NAME,
} from './constants.ts'
import { requireRecordOwner } from './state.ts'
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

/** Copies `source` over `destination` via a temp file and rename, so a running copy is never half-written. */
function copyExecutable(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true })
  const temp = `${destination}.${process.pid}.tmp`
  try {
    copyFileSync(source, temp)
    // chmod after copying: the umask can strip bits at creation.
    chmodSync(temp, EXECUTABLE_MODE)
    renameSync(temp, destination)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** What sits at `path` without following links; `missing` when nothing does. */
function inspectEntry(path: string): 'missing' | 'symlink' | 'file' | 'other' {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if (isMissingFileError(error)) {
      return 'missing'
    }
    throw error
  }
  if (stats.isSymbolicLink()) {
    return 'symlink'
  }
  return stats.isFile() ? 'file' : 'other'
}

function isWritable(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The config file a systemd install uses when nothing recorded one: $TELEGRAM_ASK_CONFIG or the default, absolute. */
export function resolveDefaultConfigFile(paths: InstallPaths, env: NodeJS.ProcessEnv): string {
  return resolve(env.TELEGRAM_ASK_CONFIG || paths.configFile)
}

/** Best-effort read of the TELEGRAM_ASK_CONFIG value from a unit's Environment= lines. */
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

/** Splits a unit command line into words, honoring double quotes and backslash escapes. */
function splitCommandLine(line: string): string[] {
  const words: string[] = []
  let word = ''
  let hasWord = false
  let isQuoted = false
  let isEscaped = false
  for (const char of line) {
    if (isEscaped) {
      word += char
      isEscaped = false
      continue
    }
    if (char === '\\') {
      isEscaped = true
      hasWord = true
      continue
    }
    if (char === '"') {
      isQuoted = !isQuoted
      hasWord = true
      continue
    }
    if (!isQuoted && /\s/.test(char)) {
      if (hasWord) {
        words.push(word)
      }
      word = ''
      hasWord = false
      continue
    }
    word += char
    hasWord = true
  }
  if (hasWord) {
    words.push(word)
  }
  return words
}

/**
 * The unquoted words of a unit's `ExecStart=` line minus the trailing `start`: the node path and
 * CLI script, or the binary path. Undefined without an `ExecStart=` line.
 */
export function findUnitExecWords(unit: string): readonly string[] | undefined {
  for (const line of unit.split('\n')) {
    const rawValue = EXEC_START_LINE_PATTERN.exec(line)?.[1]
    if (rawValue === undefined) {
      continue
    }
    const words = splitCommandLine(rawValue).map((word) =>
      word.replaceAll('$$', '$').replaceAll('%%', '%'),
    )
    return words.at(-1) === 'start' ? words.slice(0, -1) : words
  }
  return undefined
}

/**
 * Provider named in the config file (Telegram when absent) and its settings; settings are empty for
 * an unknown provider. Throws on a corrupt config file.
 */
export function readConfigSecrets(path: string, providers: readonly Provider[]): Secrets {
  const config = readConfigFile(path)
  const name = config.provider ?? DEFAULT_PROVIDER
  const provider = findProvider(providers, name)
  if (provider === undefined) {
    return { provider: name, settings: {} }
  }
  return {
    provider: name,
    settings: collectSettings(provider, (setting) => config[setting.configKey]),
  }
}

/**
 * `null` for every config key other providers use, so switching providers drops the old settings.
 */
function formatOtherProviderKeys(
  providers: readonly Provider[],
  current: Provider,
): Readonly<Record<string, null>> {
  const ownKeys = new Set(current.settings.map((setting) => setting.configKey))
  const keys = providers
    .filter((provider) => provider.name !== current.name)
    .flatMap((provider) => provider.settings.map((setting) => setting.configKey))
    .filter((key) => !ownKeys.has(key))
  return Object.fromEntries(keys.map((key) => [key, null]))
}

/**
 * systemd user service target running the npm-installed CLI, or a copy of the standalone binary in
 * ~/.local/bin; keeps its settings in the config file.
 */
export function createSystemdTarget(deps: TargetDeps, cli: CliLocation): Target {
  const { exec, paths, env, user, providers } = deps
  const systemctl = (...args: string[]) => exec('systemctl', ['--user', ...args])
  // The unit always pins TELEGRAM_ASK_CONFIG to this absolute path, and install.json records it,
  // so later commands don't depend on the environment they happen to run in.
  const configFile = resolveDefaultConfigFile(paths, env)
  const resolveConfigFile = (record: InstallRecord) => record.configFile ?? configFile
  const fallbackRoot = join(paths.userNpmPrefix, 'lib', 'node_modules')
  async function resolveCli(selfPath: string, options: InstallOptions): Promise<string> {
    const root = (await exec('npm', ['root', '-g'])).stdout.trim()
    if (isUnder(selfPath, root)) {
      options.print(`Using the installed CLI at ${selfPath}`)
      return selfPath
    }
    if (isUnder(selfPath, fallbackRoot)) {
      options.print(`Using the installed CLI at ${selfPath}`)
      return selfPath
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
  /** Installs or locates the CLI; `words` is what the unit execs before `start`. */
  async function resolveExec(
    options: InstallOptions,
  ): Promise<{ readonly cliPath: string; readonly words: readonly string[] }> {
    if (cli.kind === 'npm') {
      // A leftover binary copy would shadow npm's launcher on PATH; a symlink there is npm's own.
      if (inspectEntry(paths.binaryCopy) === 'file') {
        options.print(`Removing the old standalone binary at ${paths.binaryCopy}`)
        rmSync(paths.binaryCopy, { force: true })
      }
      const cliPath = await resolveCli(cli.selfPath, options)
      return { cliPath, words: [cli.nodePath, cliPath] }
    }
    if (resolve(cli.binaryPath) !== resolve(paths.binaryCopy)) {
      options.print(`Copying ${cli.binaryPath} to ${paths.binaryCopy}`)
      copyExecutable(cli.binaryPath, paths.binaryCopy)
    }
    return { cliPath: paths.binaryCopy, words: [paths.binaryCopy] }
  }
  function isOnPath(directory: string): boolean {
    return (env.PATH ?? '')
      .split(delimiter)
      .some((entry) => entry !== '' && resolve(entry) === resolve(directory))
  }
  const target: Target = {
    name: 'systemd',
    async available() {
      if (cli.kind === 'binary' && inspectEntry(paths.binaryCopy) === 'symlink') {
        return {
          ok: false,
          reason: `~/.local/bin/${PACKAGE_NAME} is a symlink (npm's launcher?); run "npm rm -g ${PACKAGE_NAME}" first`,
        }
      }
      const result = await systemctl('show-environment')
      return result.code === 0
        ? { ok: true }
        : { ok: false, reason: 'systemd user session not available' }
    },
    async install(options): Promise<InstallRecord> {
      const command = await resolveExec(options)
      // Only touch the owner when we have one; clearOwner is the explicit way to drop it.
      updateConfigFile(configFile, {
        ...formatOtherProviderKeys(providers, options.provider),
        provider: options.provider.name,
        port: options.port,
        ...options.settings,
        apiToken: options.auth.kind === 'token' ? options.auth.token : null,
      })
      mkdirSync(dirname(paths.systemdUnit), { recursive: true })
      writeFileSync(
        paths.systemdUnit,
        formatSystemdUnit({ exec: command.words, config: configFile }),
      )
      for (const args of [['daemon-reload'], ['enable', '--now', SERVICE_NAME]]) {
        const result = await systemctl(...args)
        if (result.code !== 0) {
          throw new Error(`systemctl ${args.join(' ')} failed: ${result.stderr.trim()}`)
        }
      }
      await ensureLinger(exec, user, options.print)
      if (cli.kind === 'binary' && !isOnPath(dirname(paths.binaryCopy))) {
        options.print(PATH_HINT)
      }
      return {
        target: 'systemd',
        provider: options.provider.name,
        port: options.port,
        version: options.version,
        cliPath: command.cliPath,
        cliKind: cli.kind,
        configFile,
      }
    },
    async upgrade(options): Promise<InstallRecord> {
      const record = await target.install(options)
      // `enable --now` leaves an already running unit on the old command.
      await target.restart(record)
      return record
    },
    async readSecrets(record): Promise<Secrets> {
      return readConfigSecrets(resolveConfigFile(record), providers)
    },
    async remove(record, purge) {
      await systemctl('disable', '--now', SERVICE_NAME)
      rmSync(paths.systemdUnit, { force: true })
      await systemctl('daemon-reload')
      if (purge) {
        rmSync(resolveConfigFile(record), { force: true })
        rmSync(resolveStatePath(resolveConfigFile(record)), { force: true })
        removeAuditFiles(resolveAuditPath(resolveConfigFile(record)))
        if (record.cliKind === 'binary') {
          if (record.cliPath !== undefined) {
            rmSync(record.cliPath, { force: true })
          }
          return
        }
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
      updateConfigFile(resolveConfigFile(record), {
        [requireRecordOwner(providers, record).configKey]: null,
      })
    },
    async readAuditLog(record) {
      return readAuditFiles(resolveAuditPath(resolveConfigFile(record)))
    },
    async isRunning() {
      return (await systemctl('is-active', '--quiet', SERVICE_NAME)).code === 0
    },
    logsHint() {
      return `journalctl --user -u ${SERVICE_NAME} -f`
    },
  }
  return target
}
