import { expect, test } from 'vite-plus/test'
import {
  formatComposeYaml,
  formatDockerfile,
  formatEnvFile,
  formatQuadletContainer,
  quoteSystemdValue,
  formatSystemdUnit,
} from '../../src/install/index.ts'

test('formatDockerfile pins version', () =>
  expect(formatDockerfile({ version: '0.1.0' })).toContain('npm i -g telegram-approval-bot@0.1.0'))
test('formatDockerfile from tarball', () => {
  const d = formatDockerfile({ version: '0.1.0', tarball: '/a/b/pkg.tgz' })
  expect(d).toContain('COPY pkg.tgz /tmp/pkg.tgz')
  expect(d).toContain('RUN npm i -g /tmp/pkg.tgz && rm /tmp/pkg.tgz')
})
test('formatDockerfile binds all interfaces inside', () => {
  const d = formatDockerfile({ version: '1' })
  expect(d).toContain('HOST=0.0.0.0')
  expect(d).toContain('CMD ["telegram-approval-bot","start"]')
})
test('compose publishes on localhost only, restarts', () => {
  const y = formatComposeYaml(9000)
  expect(y).toContain('"127.0.0.1:9000:9000"')
  expect(y).toContain('restart: unless-stopped')
  expect(y).toContain('data:/data')
})
test('quadlet publishes on localhost and quotes the env file path', () => {
  const q = formatQuadletContainer({ version: '0.1.0', port: 8787, envFile: '/home/a b/.env' })
  expect(q).toContain('PublishPort=127.0.0.1:8787:8787')
  expect(q).toContain('EnvironmentFile="/home/a b/.env"')
  expect(q).toContain('Image=localhost/telegram-approval-bot:0.1.0')
})
test('systemd unit quotes paths with spaces and percent', () => {
  const u = formatSystemdUnit({
    node: '/opt/node 24/bin/node',
    cli: '/x/cli.js',
    config: '/h/50%/c.json',
  })
  expect(u).toContain('ExecStart="/opt/node 24/bin/node" "/x/cli.js" start')
  expect(u).toContain('Environment="APPROVAL_BOT_CONFIG=/h/50%%/c.json"')
  expect(u).not.toContain('WorkingDirectory')
})
test('systemd unit escapes $ in ExecStart only', () => {
  const u = formatSystemdUnit({ node: '/n$x/node', cli: '/c$y/cli.js', config: '/h/$z/c.json' })
  expect(u).toContain('ExecStart="/n$$x/node" "/c$$y/cli.js" start')
  expect(u).toContain('Environment="APPROVAL_BOT_CONFIG=/h/$z/c.json"')
})
test('quoteSystemdValue escapes backslash and quote', () =>
  expect(quoteSystemdValue('a\\b"c%')).toBe('"a\\\\b\\"c%%"'))
test('formatEnvFile omits OWNER_ID when unknown', () =>
  expect(formatEnvFile({ token: 't', port: 1 })).not.toContain('OWNER_ID'))
test('formatEnvFile is plain KEY=value', () =>
  expect(formatEnvFile({ token: '1:a-b_c', port: 5, ownerId: 9 })).toBe(
    'BOT_TOKEN=1:a-b_c\nPORT=5\nOWNER_ID=9\n',
  ))
