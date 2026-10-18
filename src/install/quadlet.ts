import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { ensureLinger } from '../system/index.ts'
import {
  DOCKERIGNORE,
  INTEGER_PATTERN,
  MIN_PODMAN_MAJOR,
  MIN_PODMAN_MINOR,
  NOT_FOUND_PATTERN,
  PODMAN_VERSION_PATTERN,
  SERVICE_NAME,
  VOLUME_NAME,
} from './constants.ts'
import { readEnvFile, removeEnvKey, writeEnvFile } from './envfile.ts'
import { formatDockerfile, formatEnvFile, formatQuadletContainer } from './templates.ts'
import type { InstallRecord, Secrets, Target, TargetDeps } from './types.ts'

function formatImageTag(version: string): string {
  return `localhost/${SERVICE_NAME}:${version}`
}

export function createQuadletTarget(deps: TargetDeps): Target {
  const { exec, paths, user } = deps
  const envPath = join(paths.quadletDirectory, '.env')
  const systemctl = (...args: string[]) => exec('systemctl', ['--user', ...args])
  return {
    name: 'quadlet',
    async available() {
      let output: string
      try {
        const result = await exec('podman', ['--version'])
        if (result.code !== 0) {
          return { ok: false, reason: 'podman not installed' }
        }
        output = result.stdout
      } catch {
        return { ok: false, reason: 'podman not installed' }
      }
      const match = PODMAN_VERSION_PATTERN.exec(output)
      if (!match) {
        return { ok: false, reason: `can't parse podman version: ${output.trim()}` }
      }
      const major = Number(match[1])
      const minor = Number(match[2])
      if (major > MIN_PODMAN_MAJOR || (major === MIN_PODMAN_MAJOR && minor >= MIN_PODMAN_MINOR)) {
        return { ok: true }
      }
      return { ok: false, reason: `podman ${match[0]} is too old; quadlet needs 4.4 or newer` }
    },
    async install(options): Promise<InstallRecord> {
      mkdirSync(paths.quadletDirectory, { recursive: true })
      if (options.tarball !== undefined) {
        const destination = join(paths.quadletDirectory, basename(options.tarball))
        if (resolve(options.tarball) !== resolve(destination)) {
          copyFileSync(options.tarball, destination)
        }
      }
      // Keep the token out of the build context.
      writeFileSync(join(paths.quadletDirectory, '.dockerignore'), DOCKERIGNORE)
      writeFileSync(
        join(paths.quadletDirectory, 'Dockerfile'),
        formatDockerfile({
          version: options.version,
          ...(options.tarball ? { tarball: options.tarball } : {}),
        }),
      )
      writeEnvFile(
        envPath,
        formatEnvFile({
          token: options.token,
          port: options.port,
          ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
        }),
      )
      const build = await exec(
        'podman',
        ['build', '-t', formatImageTag(options.version), paths.quadletDirectory],
        { inherit: true },
      )
      if (build.code !== 0) {
        throw new Error(`podman build failed (exit ${build.code})`)
      }
      mkdirSync(dirname(paths.quadletUnit), { recursive: true })
      writeFileSync(
        paths.quadletUnit,
        formatQuadletContainer({ version: options.version, port: options.port, envFile: envPath }),
      )
      for (const args of [['daemon-reload'], ['start', SERVICE_NAME]]) {
        const result = await systemctl(...args)
        if (result.code !== 0) {
          throw new Error(`systemctl ${args.join(' ')} failed: ${result.stderr.trim()}`)
        }
      }
      await ensureLinger(exec, user, options.print)
      return { target: 'quadlet', port: options.port, version: options.version }
    },
    async readSecrets(record): Promise<Secrets> {
      const values = readEnvFile(envPath)
      const tokenSecrets = values.BOT_TOKEN ? { token: values.BOT_TOKEN } : {}
      if (values.OWNER_ID && INTEGER_PATTERN.test(values.OWNER_ID)) {
        return { ...tokenSecrets, ownerId: Number(values.OWNER_ID) }
      }
      const result = await exec('podman', [
        'run',
        '--rm',
        '-v',
        `${VOLUME_NAME}:/data`,
        formatImageTag(record.version),
        SERVICE_NAME,
        'owner',
        'get',
      ])
      const output = result.stdout.trim()
      if (result.code === 0 && INTEGER_PATTERN.test(output)) {
        return { ...tokenSecrets, ownerId: Number(output) }
      }
      return tokenSecrets
    },
    async remove(record, purge) {
      await systemctl('stop', SERVICE_NAME)
      rmSync(paths.quadletUnit, { force: true })
      await systemctl('daemon-reload')
      if (!purge) {
        return
      }
      const failures: string[] = []
      const step = async (label: string, args: readonly string[]): Promise<boolean> => {
        try {
          const result = await exec('podman', args)
          if (result.code === 0 || NOT_FOUND_PATTERN.test(result.stderr)) {
            return true
          }
          failures.push(`${label}: ${result.stderr.trim() || `exit ${result.code}`}`)
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
        }
        return false
      }
      const isVolumeRemoved = await step('podman volume rm', ['volume', 'rm', VOLUME_NAME])
      await step('podman rmi', ['rmi', formatImageTag(record.version)])
      if (isVolumeRemoved) {
        rmSync(paths.quadletDirectory, { recursive: true, force: true })
      }
      if (failures.length > 0) {
        throw new Error(`purge incomplete: ${failures.join('; ')}`)
      }
    },
    async restart() {
      const result = await systemctl('restart', SERVICE_NAME)
      if (result.code !== 0) {
        throw new Error(`systemctl restart failed (exit ${result.code})`)
      }
    },
    async clearOwner(record) {
      removeEnvKey(envPath, 'OWNER_ID')
      try {
        const result = await exec('podman', ['exec', SERVICE_NAME, SERVICE_NAME, 'owner', 'clear'])
        if (result.code === 0) {
          return
        }
      } catch {
        // fall through to the one-off container
      }
      const result = await exec('podman', [
        'run',
        '--rm',
        '-v',
        `${VOLUME_NAME}:/data`,
        formatImageTag(record.version),
        SERVICE_NAME,
        'owner',
        'clear',
      ])
      if (result.code !== 0) {
        throw new Error(`couldn't clear the owner in the container: ${result.stderr.trim()}`)
      }
    },
    async isRunning() {
      return (await systemctl('is-active', '--quiet', SERVICE_NAME)).code === 0
    },
    logsHint() {
      return `journalctl --user -u ${SERVICE_NAME} -f`
    },
  }
}
