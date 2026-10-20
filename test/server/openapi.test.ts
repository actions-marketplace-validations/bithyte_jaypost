import { readFileSync } from 'node:fs'
import { expect, test } from 'vite-plus/test'
import { parse } from 'yaml'
import { DEFAULT_PORT } from '../../src/config/index.ts'
import { DEFAULT_PROVIDER, PROVIDERS, requireProvider } from '../../src/provider/index.ts'
import { createOpenApiDocument, formatOpenApiYaml } from '../../src/server/index.ts'

test('docs/openapi.yaml is up to date (npm run openapi)', () => {
  const maxTextLength = requireProvider(PROVIDERS, DEFAULT_PROVIDER).maxTextLength
  const committed = readFileSync(new URL('../../docs/openapi.yaml', import.meta.url), 'utf8')
  expect(committed).toBe(formatOpenApiYaml({ port: DEFAULT_PORT, maxTextLength }))
})

test('server url and text limits follow the options', () => {
  const document = createOpenApiDocument({ port: 9000, maxTextLength: 1234 })
  expect(document.servers).toEqual([{ url: 'http://127.0.0.1:9000' }])
  const { ApprovalRequest, NotifyRequest } = document.components.schemas
  for (const body of [ApprovalRequest, NotifyRequest]) {
    expect(body.properties?.text).toMatchObject({ minLength: 1 })
    expect(body.properties?.text).not.toHaveProperty('maxLength')
    expect(body.properties?.text).toMatchObject({
      description: expect.stringContaining('1234'),
    })
    expect(body.properties?.text).toMatchObject({
      description: expect.stringContaining('markdown'),
    })
    expect(body.properties?.format).toMatchObject({ enum: ['plain', 'markdown'] })
  }
})

test('request bodies come from the parser schemas', () => {
  const { ApprovalRequest, NotifyRequest } = createOpenApiDocument({
    port: 8787,
    maxTextLength: 3900,
  }).components.schemas
  expect(ApprovalRequest.required).toEqual(['text', 'timeoutOption'])
  expect(ApprovalRequest.properties?.allowText).toMatchObject({ type: 'boolean' })
  expect(ApprovalRequest.properties?.options).toMatchObject({
    type: 'array',
    items: { type: 'string', minLength: 1, maxLength: 64 },
  })
  expect(ApprovalRequest.properties?.options).not.toHaveProperty('minItems')
  expect(ApprovalRequest.properties?.timeout).toMatchObject({ exclusiveMinimum: 0 })
  expect(ApprovalRequest.properties?.project).toMatchObject({ maxLength: 100 })
  expect(NotifyRequest.required).toEqual(['text'])
  expect(Object.keys(NotifyRequest.properties ?? {})).toEqual(['text', 'project', 'format'])
})

test('yaml parses back to the document', () => {
  const options = { port: 8787, maxTextLength: 3900 }
  expect(parse(formatOpenApiYaml(options))).toEqual(createOpenApiDocument(options))
})

test('bearer auth is declared and required on the api routes', () => {
  const document = createOpenApiDocument({ port: 8787, maxTextLength: 3900 })
  expect(document.components.securitySchemes.bearerAuth).toMatchObject({
    type: 'http',
    scheme: 'bearer',
  })
  expect(document.security).toEqual([{ bearerAuth: [] }])
  expect(document.paths['/openapi.yaml'].get.security).toEqual([])
  const unauthorized = { $ref: '#/components/responses/Unauthorized' }
  expect(document.paths['/request'].post.responses['401']).toEqual(unauthorized)
  expect(document.paths['/notify'].post.responses['401']).toEqual(unauthorized)
  expect(document.paths['/status'].get.responses['401']).toEqual(unauthorized)
})

test('background paths are documented', () => {
  const { paths } = createOpenApiDocument({ port: 8787, maxTextLength: 3900 })
  expect(paths['/request/async'].post.responses['202'].headers).toHaveProperty('Location')
  const item = paths['/request/{id}']
  expect(item.get.parameters).toContainEqual(
    expect.objectContaining({ name: 'wait', in: 'query', schema: { type: 'number', minimum: 0 } }),
  )
  expect(item.get.responses).toHaveProperty('404')
  expect(item.delete.responses).toHaveProperty('404')
  expect(item.get).not.toHaveProperty('security')
  expect(item.delete).not.toHaveProperty('security')
  expect(paths['/request/async'].post).not.toHaveProperty('security')
})
