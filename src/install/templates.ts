import { basename } from 'node:path'

export function systemdQuote(s: string): string {
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
}

/** Quotes one ExecStart word; `$` is also escaped there because systemd expands `$VAR` in ExecStart. */
export function execWord(s: string): string {
  return systemdQuote(s).replaceAll('$', () => '$$')
}

export const DOCKERIGNORE = '.env\n'

export function dockerfile(opts: { version: string; tarball?: string }): string {
  const install =
    opts.tarball === undefined
      ? `RUN npm i -g telegram-approval-bot@${opts.version}`
      : `COPY ${basename(opts.tarball)} /tmp/pkg.tgz\nRUN npm i -g /tmp/pkg.tgz && rm /tmp/pkg.tgz`
  return `FROM node:24-slim
ENV NODE_ENV=production APPROVAL_BOT_CONFIG=/data/config.json HOST=0.0.0.0
${install}
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
CMD ["telegram-approval-bot","start"]
`
}

export function composeYaml(port: number): string {
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

export function envFile(opts: { token: string; port: number; ownerId?: number }): string {
  const lines = [`BOT_TOKEN=${opts.token}`, `PORT=${opts.port}`]
  if (opts.ownerId !== undefined) lines.push(`OWNER_ID=${opts.ownerId}`)
  return lines.join('\n') + '\n'
}

export function quadletContainer(opts: { version: string; port: number; envFile: string }): string {
  return `[Unit]
Description=Telegram approval bot

[Container]
Image=localhost/telegram-approval-bot:${opts.version}
ContainerName=telegram-approval-bot
Volume=telegram-approval-bot-data:/data
EnvironmentFile=${systemdQuote(opts.envFile)}
PublishPort=127.0.0.1:${opts.port}:${opts.port}

[Service]
Restart=on-failure

[Install]
WantedBy=default.target
`
}

export function systemdUnit(opts: { node: string; cli: string; config: string }): string {
  return `[Unit]
Description=Telegram approval bot
After=network-online.target
Wants=network-online.target

[Service]
Environment=${systemdQuote(`APPROVAL_BOT_CONFIG=${opts.config}`)}
ExecStart=${execWord(opts.node)} ${execWord(opts.cli)} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}
