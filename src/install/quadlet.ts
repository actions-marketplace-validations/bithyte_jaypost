import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { readEnvFile, removeEnvKey, writeEnvFile } from './envfile.ts'
import type { InstallRecord } from './state.ts'
import { ensureLinger } from './system.ts'
import type { Secrets, Target, TargetDeps } from './target.ts'
import { dockerfile, envFile, quadletContainer } from './templates.ts'

const SERVICE = 'telegram-approval-bot'
const NOT_FOUND = /no such|not found|does not exist/i
const VOLUME = 'telegram-approval-bot-data'
const tagOf = (version: string) => `localhost/${SERVICE}:${version}`

export function quadletTarget(deps: TargetDeps): Target {
  const { exec, paths, user } = deps
  const envPath = join(paths.quadletDir, '.env')
  const ctl = (...args: string[]) => exec('systemctl', ['--user', ...args])

  return {
    name: 'quadlet',
    async available() {
      let out: string
      try {
        const r = await exec('podman', ['--version'])
        if (r.code !== 0) return { ok: false, reason: 'podman not installed' }
        out = r.stdout
      } catch {
        return { ok: false, reason: 'podman not installed' }
      }
      const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(out)
      if (!m) return { ok: false, reason: `can't parse podman version: ${out.trim()}` }
      const major = Number(m[1])
      const minor = Number(m[2])
      if (major > 4 || (major === 4 && minor >= 4)) return { ok: true }
      return { ok: false, reason: `podman ${m[0]} is too old; quadlet needs 4.4 or newer` }
    },
    async install(opts): Promise<InstallRecord> {
      mkdirSync(paths.quadletDir, { recursive: true })
      if (opts.tarball !== undefined) {
        const dest = join(paths.quadletDir, basename(opts.tarball))
        if (resolve(opts.tarball) !== resolve(dest)) copyFileSync(opts.tarball, dest)
      }
      writeFileSync(
        join(paths.quadletDir, 'Dockerfile'),
        dockerfile({ version: opts.version, ...(opts.tarball ? { tarball: opts.tarball } : {}) }),
      )
      writeEnvFile(
        envPath,
        envFile({
          token: opts.token,
          port: opts.port,
          ...(opts.ownerId === undefined ? {} : { ownerId: opts.ownerId }),
        }),
      )
      const b = await exec('podman', ['build', '-t', tagOf(opts.version), paths.quadletDir], {
        inherit: true,
      })
      if (b.code !== 0) throw new Error(`podman build failed (exit ${b.code})`)
      mkdirSync(dirname(paths.quadletUnit), { recursive: true })
      writeFileSync(
        paths.quadletUnit,
        quadletContainer({ version: opts.version, port: opts.port, envFile: envPath }),
      )
      for (const args of [['daemon-reload'], ['start', SERVICE]]) {
        const r = await ctl(...args)
        if (r.code !== 0) throw new Error(`systemctl ${args.join(' ')} failed: ${r.stderr.trim()}`)
      }
      await ensureLinger(exec, user, opts.print)
      return { target: 'quadlet', port: opts.port, version: opts.version }
    },
    async readSecrets(rec): Promise<Secrets> {
      const e = readEnvFile(envPath)
      const out: Secrets = {}
      if (e.BOT_TOKEN) out.token = e.BOT_TOKEN
      if (e.OWNER_ID && /^-?\d+$/.test(e.OWNER_ID)) {
        out.ownerId = Number(e.OWNER_ID)
        return out
      }
      const r = await exec('podman', [
        'run',
        '--rm',
        '-v',
        `${VOLUME}:/data`,
        tagOf(rec.version),
        SERVICE,
        'owner',
        'get',
      ])
      const t = r.stdout.trim()
      if (r.code === 0 && /^-?\d+$/.test(t)) out.ownerId = Number(t)
      return out
    },
    async remove(rec, purge) {
      await ctl('stop', SERVICE)
      rmSync(paths.quadletUnit, { force: true })
      await ctl('daemon-reload')
      if (!purge) return
      const failures: string[] = []
      let volumeFailed = false
      const step = async (label: string, args: string[]): Promise<boolean> => {
        try {
          const r = await exec('podman', args)
          if (r.code === 0 || NOT_FOUND.test(r.stderr)) return true
          failures.push(`${label}: ${r.stderr.trim() || `exit ${r.code}`}`)
        } catch (e) {
          failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
        }
        return false
      }
      volumeFailed = !(await step('podman volume rm', ['volume', 'rm', VOLUME]))
      await step('podman rmi', ['rmi', tagOf(rec.version)])
      if (!volumeFailed) rmSync(paths.quadletDir, { recursive: true, force: true })
      if (failures.length > 0) throw new Error(`Purge incomplete; ${failures.join('; ')}`)
    },
    async restart() {
      await ctl('restart', SERVICE)
    },
    async clearOwner(rec) {
      removeEnvKey(envPath, 'OWNER_ID')
      try {
        const r = await exec('podman', ['exec', SERVICE, SERVICE, 'owner', 'clear'])
        if (r.code === 0) return
      } catch {
        // fall through to the one-off container
      }
      const r = await exec('podman', [
        'run',
        '--rm',
        '-v',
        `${VOLUME}:/data`,
        tagOf(rec.version),
        SERVICE,
        'owner',
        'clear',
      ])
      if (r.code !== 0)
        throw new Error(`Couldn't clear the owner in the container: ${r.stderr.trim()}`)
    },
    async isRunning() {
      return (await ctl('is-active', '--quiet', SERVICE)).code === 0
    },
    logsHint() {
      return `journalctl --user -u ${SERVICE} -f`
    },
  }
}
