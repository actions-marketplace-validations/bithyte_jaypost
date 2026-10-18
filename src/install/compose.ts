import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { Exec } from '../system/index.ts'
import { DOCKERIGNORE, INTEGER_PATTERN, PACKAGE_NAME } from './constants.ts'
import { readEnvFile, removeEnvKey, writeEnvFile } from './envfile.ts'
import { formatComposeYaml, formatDockerfile, formatEnvFile } from './templates.ts'
import type { InstallRecord, Secrets, Target, TargetDeps } from './types.ts'

async function tryExec(exec: Exec, command: string, args: readonly string[]) {
  try {
    return await exec(command, args)
  } catch {
    return undefined
  }
}

/**
 * Docker Compose target; writes its files under the compose directory and drives `docker compose`.
 */
export function createComposeTarget(deps: TargetDeps): Target {
  const { exec, paths } = deps
  const file = join(paths.composeDirectory, 'compose.yaml')
  const envPath = join(paths.composeDirectory, '.env')
  const compose = (args: readonly string[], options?: { readonly inherit?: boolean }) =>
    exec('docker', ['compose', '-f', file, ...args], options)
  return {
    name: 'compose',
    async available() {
      const version = await tryExec(exec, 'docker', ['compose', 'version'])
      if (version === undefined) {
        return { ok: false, reason: 'docker not installed' }
      }
      if (version.code !== 0) {
        return { ok: false, reason: 'docker compose v2 not available' }
      }
      const info = await tryExec(exec, 'docker', ['info'])
      if (info === undefined || info.code !== 0) {
        return { ok: false, reason: "can't talk to docker (not in the docker group?)" }
      }
      return { ok: true }
    },
    async install(options): Promise<InstallRecord> {
      mkdirSync(paths.composeDirectory, { recursive: true })
      if (options.tarball !== undefined) {
        const destination = join(paths.composeDirectory, basename(options.tarball))
        if (resolve(options.tarball) !== resolve(destination)) {
          copyFileSync(options.tarball, destination)
        }
      }
      // Keep the token out of the build context.
      writeFileSync(join(paths.composeDirectory, '.dockerignore'), DOCKERIGNORE)
      writeFileSync(
        join(paths.composeDirectory, 'Dockerfile'),
        formatDockerfile({
          version: options.version,
          ...(options.tarball ? { tarball: options.tarball } : {}),
        }),
      )
      writeFileSync(file, formatComposeYaml(options.port))
      writeEnvFile(
        envPath,
        formatEnvFile({
          token: options.token,
          port: options.port,
          ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
        }),
      )
      const result = await compose(['up', '-d', '--build'], { inherit: true })
      if (result.code !== 0) {
        throw new Error(`docker compose up failed (exit ${result.code})`)
      }
      return { target: 'compose', port: options.port, version: options.version }
    },
    async readSecrets(): Promise<Secrets> {
      const values = readEnvFile(envPath)
      const tokenSecrets = values.BOT_TOKEN ? { token: values.BOT_TOKEN } : {}
      if (values.OWNER_ID && INTEGER_PATTERN.test(values.OWNER_ID)) {
        return { ...tokenSecrets, ownerId: Number(values.OWNER_ID) }
      }
      const result = await compose([
        'run',
        '--rm',
        '--no-deps',
        'bot',
        PACKAGE_NAME,
        'owner',
        'get',
      ])
      const output = result.stdout.trim()
      if (result.code === 0 && INTEGER_PATTERN.test(output)) {
        return { ...tokenSecrets, ownerId: Number(output) }
      }
      return tokenSecrets
    },
    async remove(_record, purge) {
      const result = await compose(purge ? ['down', '-v'] : ['down'])
      if (result.code !== 0) {
        throw new Error(`docker compose down failed: ${result.stderr.trim()}`)
      }
      if (purge) {
        rmSync(paths.composeDirectory, { recursive: true, force: true })
      }
    },
    async restart() {
      const result = await compose(['up', '-d', '--force-recreate'])
      if (result.code !== 0) {
        throw new Error(`docker compose up failed (exit ${result.code})`)
      }
    },
    async clearOwner() {
      removeEnvKey(envPath, 'OWNER_ID')
      const result = await compose([
        'run',
        '--rm',
        '--no-deps',
        'bot',
        PACKAGE_NAME,
        'owner',
        'clear',
      ])
      if (result.code !== 0) {
        throw new Error(`couldn't clear the owner in the container: ${result.stderr.trim()}`)
      }
    },
    async isRunning() {
      const result = await compose(['ps', '--status', 'running', '-q', 'bot'])
      return result.code === 0 && result.stdout.trim() !== ''
    },
    logsHint() {
      return `docker compose -f ${file} logs -f`
    },
  }
}
