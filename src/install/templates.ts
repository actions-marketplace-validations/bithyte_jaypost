import { basename } from 'node:path'

/** Wraps in double quotes, escaping backslash and `"`, and doubling `%` (systemd specifier). */
export function quoteSystemdValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
}

/** Quotes one ExecStart word; `$` is also escaped there because systemd expands `$VAR` in ExecStart. */
export function quoteExecWord(word: string): string {
  return quoteSystemdValue(word).replaceAll('$', () => '$$')
}

/**
 * Image that installs the package from npm, or from a local tarball when given, and runs `start` as
 * the node user.
 */
export function formatDockerfile(options: {
  readonly version: string
  readonly tarball?: string
}): string {
  const install =
    options.tarball === undefined
      ? `RUN npm i -g telegram-approval-bot@${options.version}`
      : `COPY ${basename(options.tarball)} /tmp/pkg.tgz\nRUN npm i -g /tmp/pkg.tgz && rm /tmp/pkg.tgz`
  return `FROM node:24-slim
ENV NODE_ENV=production APPROVAL_BOT_CONFIG=/data/config.json HOST=0.0.0.0
${install}
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
CMD ["telegram-approval-bot","start"]
`
}

/** Compose file publishing `port` on loopback only, with a named volume for /data. */
export function formatComposeYaml(port: number): string {
  return `name: telegram-approval-bot
services:
  bot:
    build: .
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:${port}:${port}"
    volumes:
      - data:/data
volumes:
  data: {}
`
}

/** KEY=VALUE lines for the container; `OWNER_ID` is included only when known. */
export function formatEnvFile(options: {
  readonly token: string
  readonly port: number
  readonly ownerId?: number
}): string {
  const lines = [
    `BOT_TOKEN=${options.token}`,
    `PORT=${options.port}`,
    ...(options.ownerId === undefined ? [] : [`OWNER_ID=${options.ownerId}`]),
  ]
  return lines.join('\n') + '\n'
}

/** Quadlet .container unit; publishes `port` on loopback only and reads the env file. */
export function formatQuadletContainer(options: {
  readonly version: string
  readonly port: number
  readonly envFile: string
}): string {
  return `[Unit]
Description=Telegram approval bot

[Container]
Image=localhost/telegram-approval-bot:${options.version}
ContainerName=telegram-approval-bot
Volume=telegram-approval-bot-data:/data
EnvironmentFile=${quoteSystemdValue(options.envFile)}
PublishPort=127.0.0.1:${options.port}:${options.port}

[Service]
Restart=on-failure

[Install]
WantedBy=default.target
`
}

/** User unit that runs `node cli start` with APPROVAL_BOT_CONFIG pinned to `config`. */
export function formatSystemdUnit(options: {
  readonly node: string
  readonly cli: string
  readonly config: string
}): string {
  return `[Unit]
Description=Telegram approval bot
After=network-online.target
Wants=network-online.target

[Service]
Environment=${quoteSystemdValue(`APPROVAL_BOT_CONFIG=${options.config}`)}
ExecStart=${quoteExecWord(options.node)} ${quoteExecWord(options.cli)} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}
