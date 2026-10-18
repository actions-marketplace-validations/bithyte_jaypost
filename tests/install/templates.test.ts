import { expect, test } from 'vite-plus/test'
import {
  composeYaml,
  dockerfile,
  envFile,
  quadletContainer,
  systemdQuote,
  systemdUnit,
} from '../../src/install/templates.ts'

test('dockerfile pins version', () =>
  expect(dockerfile({ version: '0.1.0' })).toContain('npm i -g telegram-approval-bot@0.1.0'))
test('dockerfile from tarball', () => {
  const d = dockerfile({ version: '0.1.0', tarball: '/a/b/pkg.tgz' })
  expect(d).toContain('COPY pkg.tgz /tmp/pkg.tgz')
  expect(d).toContain('RUN npm i -g /tmp/pkg.tgz && rm /tmp/pkg.tgz')
})
test('dockerfile binds all interfaces inside', () => {
  const d = dockerfile({ version: '1' })
  expect(d).toContain('HOST=0.0.0.0')
  expect(d).toContain('CMD ["telegram-approval-bot","start"]')
})
test('compose publishes on localhost only, restarts', () => {
  const y = composeYaml(9000)
  expect(y).toContain('"127.0.0.1:9000:9000"')
  expect(y).toContain('restart: unless-stopped')
  expect(y).toContain('data:/data')
})
test('quadlet publishes on localhost and quotes the env file path', () => {
  const q = quadletContainer({ version: '0.1.0', port: 8787, envFile: '/home/a b/.env' })
  expect(q).toContain('PublishPort=127.0.0.1:8787:8787')
  expect(q).toContain('EnvironmentFile="/home/a b/.env"')
  expect(q).toContain('Image=localhost/telegram-approval-bot:0.1.0')
})
test('systemd unit quotes paths with spaces and percent', () => {
  const u = systemdUnit({
    node: '/opt/node 24/bin/node',
    cli: '/x/cli.js',
    config: '/h/50%/c.json',
  })
  expect(u).toContain('ExecStart="/opt/node 24/bin/node" "/x/cli.js" start')
  expect(u).toContain('Environment="APPROVAL_BOT_CONFIG=/h/50%%/c.json"')
  expect(u).not.toContain('WorkingDirectory')
})
test('systemd unit escapes $ in ExecStart only', () => {
  const u = systemdUnit({ node: '/n$x/node', cli: '/c$y/cli.js', config: '/h/$z/c.json' })
  expect(u).toContain('ExecStart="/n$$x/node" "/c$$y/cli.js" start')
  expect(u).toContain('Environment="APPROVAL_BOT_CONFIG=/h/$z/c.json"')
})
test('systemdQuote escapes backslash and quote', () =>
  expect(systemdQuote('a\\b"c%')).toBe('"a\\\\b\\"c%%"'))
test('envFile omits OWNER_ID when unknown', () =>
  expect(envFile({ token: 't', port: 1 })).not.toContain('OWNER_ID'))
test('envFile is plain KEY=value', () =>
  expect(envFile({ token: '1:a-b_c', port: 5, ownerId: 9 })).toBe(
    'BOT_TOKEN=1:a-b_c\nPORT=5\nOWNER_ID=9\n',
  ))
