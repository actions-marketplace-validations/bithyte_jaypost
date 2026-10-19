import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test } from 'vite-plus/test'
import { ApprovalService } from '../../src/approval/index.ts'
import type { MessageReference, Messenger, Settlement } from '../../src/approval/index.ts'
import { NotificationService } from '../../src/notify/index.ts'
import type { Notifier } from '../../src/notify/index.ts'
import { createApiServer } from '../../src/server/index.ts'

const ROOT = new URL('../..', import.meta.url).pathname
const REFERENCE: MessageReference = { chatId: 1, messageId: 2 }

class RecordingMessenger implements Messenger {
  sent: { id: string; text: string; options: readonly string[] }[] = []
  finalized: { text: string; settlement: Settlement }[] = []

  async sendRequest(
    id: string,
    text: string,
    options: readonly string[],
  ): Promise<MessageReference> {
    this.sent.push({ id, text, options })
    return REFERENCE
  }

  async finalize(
    _reference: MessageReference,
    text: string,
    settlement: Settlement,
  ): Promise<void> {
    this.finalized.push({ text, settlement })
  }
}

class RecordingNotifier implements Notifier {
  sent: string[] = []

  sendNotification = async (_id: string, text: string): Promise<MessageReference> => {
    this.sent.push(text)
    return REFERENCE
  }
}

const servers: FastifyInstance[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function startApi(options: { readonly notifications?: boolean } = {}) {
  const messenger = new RecordingMessenger()
  const notifier = new RecordingNotifier()
  const service = new ApprovalService(messenger)
  const server = createApiServer(service, () => ({ paired: true, bot: 'b' }), {
    maxTextLength: 3900,
    providerName: 'test',
    ...(options.notifications === false
      ? {}
      : { notifications: new NotificationService(notifier) }),
  })
  servers.push(server)
  await server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = server.server.address() as AddressInfo
  return { port, service, messenger, notifier }
}

async function connect(port: number): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' })
  clients.push(client)
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['src/cli.ts', 'mcp', '--port', String(port)],
      cwd: ROOT,
      stderr: 'pipe',
    }),
  )
  return client
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met within 5 s')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const ASK = {
  project_name: 'api',
  text: 'Deploy?',
  options: ['Approve', 'Decline'],
  timeout_option: 'Decline',
}

test('lists exactly the two tools with project_name required', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  const { tools } = await client.listTools()
  expect(tools.map((tool) => tool.name).toSorted()).toEqual(['ask_for_permission', 'notify_user'])
  for (const tool of tools) {
    expect(tool.inputSchema.required).toContain('project_name')
  }
})

test('ask returns the tapped answer', async () => {
  const { port, service, messenger } = await startApi()
  const client = await connect(port)
  const pending = client.callTool({ name: 'ask_for_permission', arguments: ASK })
  await waitFor(() => messenger.sent.length === 1)
  const [sent] = messenger.sent
  expect(sent?.text).toBe('[api]\n\nDeploy?')
  service.tap(sent?.id ?? '', 0)
  expect(await pending).toEqual({
    content: [{ type: 'text', text: 'Approve' }],
    structuredContent: { answer: 'Approve', timed_out: false },
  })
})

test('ask on timeout returns the timeout option', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  const result = await client.callTool({
    name: 'ask_for_permission',
    arguments: { ...ASK, timeout_seconds: 0.2 },
  })
  expect(result).toEqual({
    content: [{ type: 'text', text: 'Decline (timed out, no answer from the user)' }],
    structuredContent: { answer: 'Decline', timed_out: true },
  })
})

test('service 400 text reaches the agent', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  const result = await client.callTool({
    name: 'ask_for_permission',
    arguments: { ...ASK, project_name: '   ' },
  })
  expect(result).toEqual({
    isError: true,
    content: [{ type: 'text', text: 'project must be a non-empty string' }],
  })
})

test('notify sends and returns', async () => {
  const { port, notifier } = await startApi()
  const client = await connect(port)
  const result = await client.callTool({
    name: 'notify_user',
    arguments: { project_name: 'api', text: 'done' },
  })
  expect(result).toEqual({ content: [{ type: 'text', text: 'sent' }] })
  expect(notifier.sent).toEqual(['[api]\n\ndone'])
})

test('notify without provider support', async () => {
  const { port } = await startApi({ notifications: false })
  const client = await connect(port)
  const result = await client.callTool({
    name: 'notify_user',
    arguments: { project_name: 'api', text: 'done' },
  })
  expect(result).toEqual({
    isError: true,
    content: [{ type: 'text', text: 'notifications not supported by this provider' }],
  })
})

test('service down is a tool error and the server keeps going', async () => {
  const port = await freePort()
  const client = await connect(port)
  const expected = {
    isError: true,
    content: [
      {
        type: 'text',
        text: `telegram-ask service not reachable on 127.0.0.1:${port} (run telegram-ask status)`,
      },
    ],
  }
  const call = () =>
    client.callTool({ name: 'notify_user', arguments: { project_name: 'api', text: 'done' } })
  expect(await call()).toEqual(expected)
  expect(await call()).toEqual(expected)
})

test('cancelling an ask cancels the request', async () => {
  const { port, messenger } = await startApi()
  const client = await connect(port)
  const controller = new AbortController()
  const pending = client.callTool({ name: 'ask_for_permission', arguments: ASK }, undefined, {
    signal: controller.signal,
  })
  await waitFor(() => messenger.sent.length === 1)
  controller.abort()
  await expect(pending).rejects.toThrow()
  await waitFor(() => messenger.finalized[0]?.settlement.kind === 'cancelled')
})

test('closing stdin cancels a pending ask', async () => {
  const { port, messenger } = await startApi()
  const client = await connect(port)
  const pending = client.callTool({ name: 'ask_for_permission', arguments: ASK })
  // The call rejects once the connection closes; that's expected here.
  pending.catch(() => {})
  await waitFor(() => messenger.sent.length === 1)
  const startedAt = performance.now()
  await client.close()
  // The SDK sends SIGTERM only after waiting 2 s; finishing sooner means stdin's end stopped it.
  expect(performance.now() - startedAt).toBeLessThan(2000)
  await waitFor(() => messenger.finalized[0]?.settlement.kind === 'cancelled')
})

test('stdout carries only json-rpc', async () => {
  const { port } = await startApi()
  const child = spawn(process.execPath, ['src/cli.ts', 'mcp', '--port', String(port)], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => (stdout += chunk))
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
  const messages = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]
  child.stdin.end(messages.map((message) => `${JSON.stringify(message)}\n`).join(''))
  expect(await exited).toBe(0)
  const lines = stdout.split('\n').filter((line) => line.trim() !== '')
  expect(lines.map((line) => JSON.parse(line).id)).toEqual([1, 2])
  for (const line of lines) {
    expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
  }
})
