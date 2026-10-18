import { expect, test } from 'vite-plus/test'
import {
  formatComposeYaml,
  formatDockerfile,
  formatEnvFile,
  formatQuadletContainer,
  quoteSystemdValue,
  formatSystemdUnit,
} from '../../src/install/index.ts'
import { telegramProvider } from '../../src/telegram/index.ts'
import { createFakeProvider } from '../provider/fake.ts'

test('formatDockerfile pins version', () =>
  expect(formatDockerfile({ version: '0.1.0' })).toContain('npm i -g telegram-ask@0.1.0'))
test('formatDockerfile from tarball', () => {
  const d = formatDockerfile({ version: '0.1.0', tarball: '/a/b/pkg.tgz' })
  expect(d).toContain('COPY pkg.tgz /tmp/pkg.tgz')
  expect(d).toContain('RUN npm i -g /tmp/pkg.tgz && rm /tmp/pkg.tgz')
})
test('formatDockerfile binds all interfaces inside', () => {
  const d = formatDockerfile({ version: '1' })
  expect(d).toContain('HOST=0.0.0.0')
  expect(d).toContain('CMD ["telegram-ask","start"]')
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
  expect(q).toContain('Image=localhost/telegram-ask:0.1.0')
})
test('systemd unit quotes paths with spaces and percent', () => {
  const u = formatSystemdUnit({
    node: '/opt/node 24/bin/node',
    cli: '/x/cli.js',
    config: '/h/50%/c.json',
  })
  expect(u).toContain('ExecStart="/opt/node 24/bin/node" "/x/cli.js" start')
  expect(u).toContain('Environment="TELEGRAM_ASK_CONFIG=/h/50%%/c.json"')
  expect(u).not.toContain('WorkingDirectory')
})
test('systemd unit escapes $ in ExecStart only', () => {
  const u = formatSystemdUnit({ node: '/n$x/node', cli: '/c$y/cli.js', config: '/h/$z/c.json' })
  expect(u).toContain('ExecStart="/n$$x/node" "/c$$y/cli.js" start')
  expect(u).toContain('Environment="TELEGRAM_ASK_CONFIG=/h/$z/c.json"')
})
test('quoteSystemdValue escapes backslash and quote', () =>
  expect(quoteSystemdValue('a\\b"c%')).toBe('"a\\\\b\\"c%%"'))
test('formatEnvFile writes the provider, its settings and the port', () =>
  expect(
    formatEnvFile({
      provider: telegramProvider,
      port: 8787,
      settings: { botToken: 't', ownerId: 42 },
    }),
  ).toBe('PROVIDER=telegram\nBOT_TOKEN=t\nPORT=8787\nOWNER_ID=42\n'))
test('formatEnvFile omits OWNER_ID when unknown', () =>
  expect(
    formatEnvFile({ provider: telegramProvider, port: 8787, settings: { botToken: 't' } }),
  ).toBe('PROVIDER=telegram\nBOT_TOKEN=t\nPORT=8787\n'))
test('formatEnvFile works for any provider', () =>
  expect(
    formatEnvFile({ provider: createFakeProvider(), port: 1, settings: { fakeKey: 'k' } }),
  ).toBe('PROVIDER=fake\nFAKE_KEY=k\nPORT=1\n'))
test('formatEnvFile rejects a value with a newline', () => {
  for (const botToken of ['a\nOWNER_ID=1', 'a\rb']) {
    const format = () =>
      formatEnvFile({ provider: telegramProvider, port: 1, settings: { botToken } })
    expect(format).toThrow(RangeError)
    expect(format).toThrow('setting "botToken" contains a line break')
  }
})
