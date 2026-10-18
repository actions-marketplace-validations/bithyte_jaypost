import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { readConfigFile, updateConfigFile } from '../config/index.ts'
import { ensureLinger } from '../system/index.ts'
import {
  ENVIRONMENT_LINE_PATTERN,
  ESCAPED_CHAR_PATTERN,
  PACKAGE_NAME,
  SERVICE_NAME,
} from './constants.ts'
import { systemdUnit } from './templates.ts'
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

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The config file a systemd install uses when nothing recorded one: $APPROVAL_BOT_CONFIG or the default, absolute. */
export function defaultConfigFile(paths: InstallPaths, env: NodeJS.ProcessEnv): string {
  return resolve(env.APPROVAL_BOT_CONFIG || paths.configFile)
}

/** Best-effort read of the APPROVAL_BOT_CONFIG value from a unit's Environment= lines. */
export function unitConfigFile(unit: string): string | undefined {
  for (const line of unit.split('\n')) {
    const m = ENVIRONMENT_LINE_PATTERN.exec(line)
    if (!m) continue
    let v = m[1]!.trim()
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1).replace(ESCAPED_CHAR_PATTERN, '$1')
    }
    v = v.replaceAll('%%', '%')
    const key = 'APPROVAL_BOT_CONFIG='
    if (v.startsWith(key) && v.length > key.length) return resolve(v.slice(key.length))
  }
  return undefined
}

export function systemdTarget(deps: TargetDeps, cli: CliLocation): Target {
  const { exec, paths, env, user } = deps
  const ctl = (...args: string[]) => exec('systemctl', ['--user', ...args])
  // The unit always pins APPROVAL_BOT_CONFIG to this absolute path, and install.json records it,
  // so later commands don't depend on the environment they happen to run in.
  const configFile = defaultConfigFile(paths, env)
  const fileOf = (rec: InstallRecord) => rec.configFile ?? configFile
  const fallbackRoot = join(paths.userNpmPrefix, 'lib', 'node_modules')

  async function resolveCli(opts: InstallOptions): Promise<string> {
    const root = (await exec('npm', ['root', '-g'])).stdout.trim()
    if (isUnder(cli.selfPath, root)) {
      opts.print(`Using the installed CLI at ${cli.selfPath}`)
      return cli.selfPath
    }
    if (isUnder(cli.selfPath, fallbackRoot)) {
      opts.print(`Using the installed CLI at ${cli.selfPath}`)
      return cli.selfPath
    }
    const spec = opts.tarball ?? `${PACKAGE_NAME}@${opts.version}`
    const prefix = (await exec('npm', ['prefix', '-g'])).stdout.trim()
    let installRoot: string
    let args: string[]
    if (prefix !== '' && writable(prefix)) {
      opts.print(`Installing ${spec} globally with npm`)
      args = ['i', '-g', spec]
      installRoot = root
    } else {
      opts.print(`Global npm prefix isn't writable; installing ${spec} into ${paths.userNpmPrefix}`)
      mkdirSync(paths.userNpmPrefix, { recursive: true })
      args = ['i', '-g', '--prefix', paths.userNpmPrefix, spec]
      installRoot = fallbackRoot
    }
    const r = await exec('npm', args)
    if (r.code !== 0) throw new Error(`npm install failed: ${r.stderr.trim()}`)
    return join(installRoot, PACKAGE_NAME, 'dist', 'cli.js')
  }

  return {
    name: 'systemd',
    async available() {
      const r = await ctl('show-environment')
      return r.code === 0
        ? { ok: true }
        : { ok: false, reason: 'systemd user session not available' }
    },
    async install(opts): Promise<InstallRecord> {
      const cliPath = await resolveCli(opts)
      // Only touch ownerId when we have one; clearOwner is the explicit way to drop it.
      updateConfigFile(configFile, {
        botToken: opts.token,
        port: opts.port,
        ...(opts.ownerId === undefined ? {} : { ownerId: opts.ownerId }),
      })
      mkdirSync(dirname(paths.systemdUnit), { recursive: true })
      writeFileSync(
        paths.systemdUnit,
        systemdUnit({ node: cli.nodePath, cli: cliPath, config: configFile }),
      )
      for (const args of [['daemon-reload'], ['enable', '--now', SERVICE_NAME]]) {
        const r = await ctl(...args)
        if (r.code !== 0) throw new Error(`systemctl ${args.join(' ')} failed: ${r.stderr.trim()}`)
      }
      await ensureLinger(exec, user, opts.print)
      return { target: 'systemd', port: opts.port, version: opts.version, cliPath, configFile }
    },
    async readSecrets(rec): Promise<Secrets> {
      const c = readConfigFile(fileOf(rec))
      return {
        ...(c.botToken === undefined ? {} : { token: c.botToken }),
        ...(c.ownerId === undefined ? {} : { ownerId: c.ownerId }),
      }
    },
    async remove(rec, purge) {
      await ctl('disable', '--now', SERVICE_NAME)
      rmSync(paths.systemdUnit, { force: true })
      await ctl('daemon-reload')
      if (purge) {
        rmSync(fileOf(rec), { force: true })
        const prefix =
          rec.cliPath !== undefined && isUnder(rec.cliPath, fallbackRoot)
            ? `--prefix ${paths.userNpmPrefix} `
            : ''
        console.log(
          `The npm package was left in place; remove it with: npm rm -g ${prefix}${PACKAGE_NAME}`,
        )
      }
    },
    async restart() {
      const r = await ctl('restart', SERVICE_NAME)
      if (r.code !== 0) throw new Error(`systemctl restart failed (exit ${r.code})`)
    },
    async clearOwner(rec) {
      updateConfigFile(fileOf(rec), { ownerId: null })
    },
    async isRunning() {
      return (await ctl('is-active', '--quiet', SERVICE_NAME)).code === 0
    },
    logsHint() {
      return `journalctl --user -u ${SERVICE_NAME} -f`
    },
  }
}
