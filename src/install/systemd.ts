import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { readConfigFile, updateConfigFile } from '../config.ts'
import type { InstallRecord } from './state.ts'
import { ensureLinger } from './system.ts'
import type { InstallOptions, Secrets, Target, TargetDeps } from './target.ts'
import { systemdUnit } from './templates.ts'

const SERVICE = 'telegram-approval-bot'
const PKG = 'telegram-approval-bot'

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

export function systemdTarget(
  deps: TargetDeps,
  cli: { selfPath: string; nodePath: string },
): Target {
  const { exec, paths, env, user } = deps
  const ctl = (...args: string[]) => exec('systemctl', ['--user', ...args])
  const configEnv = env.APPROVAL_BOT_CONFIG || undefined
  // The unit passes APPROVAL_BOT_CONFIG to the bot, so secrets must live in that same file.
  const configFile = configEnv ?? paths.configFile
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
    const spec = opts.tarball ?? `${PKG}@${opts.version}`
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
    return join(installRoot, PKG, 'dist', 'cli.js')
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
      updateConfigFile(configFile, {
        botToken: opts.token,
        port: opts.port,
        ownerId: opts.ownerId ?? null,
      })
      mkdirSync(dirname(paths.systemdUnit), { recursive: true })
      writeFileSync(
        paths.systemdUnit,
        systemdUnit({ node: cli.nodePath, cli: cliPath, ...(configEnv ? { configEnv } : {}) }),
      )
      for (const args of [['daemon-reload'], ['enable', '--now', SERVICE]]) {
        const r = await ctl(...args)
        if (r.code !== 0) throw new Error(`systemctl ${args.join(' ')} failed: ${r.stderr.trim()}`)
      }
      await ensureLinger(exec, user, opts.print)
      return { target: 'systemd', port: opts.port, version: opts.version, cliPath }
    },
    async readSecrets(): Promise<Secrets> {
      const c = readConfigFile(configFile)
      return {
        ...(c.botToken === undefined ? {} : { token: c.botToken }),
        ...(c.ownerId === undefined ? {} : { ownerId: c.ownerId }),
      }
    },
    async remove(_rec, purge) {
      await ctl('disable', '--now', SERVICE)
      rmSync(paths.systemdUnit, { force: true })
      await ctl('daemon-reload')
      if (purge) {
        rmSync(configFile, { force: true })
        console.log(`The npm package was left in place; remove it with: npm rm -g ${PKG}`)
      }
    },
    async restart() {
      await ctl('restart', SERVICE)
    },
    async clearOwner() {
      updateConfigFile(configFile, { ownerId: null })
    },
    async isRunning() {
      return (await ctl('is-active', '--quiet', SERVICE)).code === 0
    },
    logsHint() {
      return `journalctl --user -u ${SERVICE} -f`
    },
  }
}
