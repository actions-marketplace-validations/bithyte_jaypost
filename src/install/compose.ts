import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Exec } from './exec.ts'
import { readEnvFile, removeEnvKey, writeEnvFile } from './envfile.ts'
import type { InstallRecord } from './state.ts'
import type { Secrets, Target, TargetDeps } from './target.ts'
import { composeYaml, dockerfile, envFile } from './templates.ts'

const PKG = 'telegram-approval-bot'

async function tryExec(exec: Exec, cmd: string, args: string[]) {
  try {
    return await exec(cmd, args)
  } catch {
    return undefined
  }
}

export function composeTarget(deps: TargetDeps): Target {
  const { exec, paths } = deps
  const file = join(paths.composeDir, 'compose.yaml')
  const envPath = join(paths.composeDir, '.env')
  const dc = (args: string[], opts?: { inherit?: boolean }) =>
    exec('docker', ['compose', '-f', file, ...args], opts)

  return {
    name: 'compose',
    async available() {
      const v = await tryExec(exec, 'docker', ['compose', 'version'])
      if (v === undefined) return { ok: false, reason: 'docker not installed' }
      if (v.code !== 0) return { ok: false, reason: 'docker compose v2 not available' }
      const info = await tryExec(exec, 'docker', ['info'])
      if (info === undefined || info.code !== 0)
        return { ok: false, reason: "can't talk to docker (not in the docker group?)" }
      return { ok: true }
    },
    async install(opts): Promise<InstallRecord> {
      mkdirSync(paths.composeDir, { recursive: true })
      if (opts.tarball !== undefined)
        copyFileSync(opts.tarball, join(paths.composeDir, basename(opts.tarball)))
      writeFileSync(
        join(paths.composeDir, 'Dockerfile'),
        dockerfile({ version: opts.version, ...(opts.tarball ? { tarball: opts.tarball } : {}) }),
      )
      writeFileSync(file, composeYaml(opts.port))
      writeEnvFile(
        envPath,
        envFile({
          token: opts.token,
          port: opts.port,
          ...(opts.ownerId === undefined ? {} : { ownerId: opts.ownerId }),
        }),
      )
      const r = await dc(['up', '-d', '--build'], { inherit: true })
      if (r.code !== 0) throw new Error(`docker compose up failed (exit ${r.code})`)
      return { target: 'compose', port: opts.port, version: opts.version }
    },
    async readSecrets(): Promise<Secrets> {
      const e = readEnvFile(envPath)
      const out: Secrets = {}
      if (e.BOT_TOKEN) out.token = e.BOT_TOKEN
      if (e.OWNER_ID && /^-?\d+$/.test(e.OWNER_ID)) {
        out.ownerId = Number(e.OWNER_ID)
        return out
      }
      const r = await dc(['run', '--rm', '--no-deps', 'bot', PKG, 'owner', 'get'])
      const t = r.stdout.trim()
      if (r.code === 0 && /^-?\d+$/.test(t)) out.ownerId = Number(t)
      return out
    },
    async remove(_rec, purge) {
      await dc(purge ? ['down', '-v'] : ['down'])
      if (purge) rmSync(paths.composeDir, { recursive: true, force: true })
    },
    async restart() {
      await dc(['up', '-d', '--force-recreate'])
    },
    async clearOwner() {
      removeEnvKey(envPath, 'OWNER_ID')
      await dc(['run', '--rm', '--no-deps', 'bot', PKG, 'owner', 'clear'])
    },
    async isRunning() {
      const r = await dc(['ps', '--status', 'running', '-q', 'bot'])
      return r.code === 0 && r.stdout.trim() !== ''
    },
    logsHint() {
      return `docker compose -f ${file} logs -f`
    },
  }
}
