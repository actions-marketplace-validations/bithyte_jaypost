import { stringify } from 'yaml'
import { z } from 'zod'
import { createApprovalRequestSchema, MAX_TIMEOUT_SECONDS } from '../approval/index.ts'
import { VERSION } from '../config/index.ts'
import { createNotifyRequestSchema } from '../notify/index.ts'
import { MAX_BODY_BYTES } from './constants.ts'
import { statusInfoSchema } from './schema.ts'
import type { OpenApiOptions } from './types.ts'

type JsonSchema = z.core.JSONSchema.BaseSchema

const TEXT_DESCRIPTION =
  'Message shown in the chat. Must not be blank. With `project`, the limit covers the `[project]` line too, so the text gets `project.length + 4` fewer characters.'

const BODY_DESCRIPTIONS: Readonly<Record<string, JsonSchema>> = {
  project: { description: 'Shown as `[project]` on the first line. Trimmed.' },
  options: { description: 'Button labels, unique.' },
  timeoutOption: { description: 'Answer returned on timeout. Must be one of `options`.' },
  timeout: {
    description: `Seconds to wait. Default and max ${MAX_TIMEOUT_SECONDS}; larger values are clamped.`,
  },
}

function errorResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  }
}

/** Input side of a body schema, with `$schema` dropped and descriptions and the text limit added. */
function toBodySchema(schema: z.ZodType, maxTextLength: number): JsonSchema {
  const { $schema: _schema, ...json } = z.toJSONSchema(schema, { io: 'input' })
  const extras: Readonly<Record<string, JsonSchema>> = {
    ...BODY_DESCRIPTIONS,
    text: { minLength: 1, maxLength: maxTextLength, description: TEXT_DESCRIPTION },
  }
  const properties = Object.fromEntries(
    Object.entries(json.properties ?? {}).map(([name, property]) => [
      name,
      typeof property === 'object' ? { ...property, ...extras[name] } : property,
    ]),
  )
  return { ...json, properties }
}

/** OpenAPI 3.1 document of the HTTP API, for a service on `port` with the given text limit. */
export function createOpenApiDocument(options: OpenApiOptions) {
  const { port, maxTextLength } = options
  const { $schema: _schema, ...status } = z.toJSONSchema(statusInfoSchema)
  return {
    openapi: '3.1.0',
    info: {
      title: 'telegram-ask',
      version: VERSION,
      description:
        'Local HTTP API that asks you a question in a chat app with buttons and returns your answer.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/request': {
        post: {
          operationId: 'request',
          summary: 'Ask a question with buttons and wait for the answer',
          description:
            'Stays open until a button is tapped or the timeout fires. Disconnecting cancels the question.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApprovalRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'The tapped answer, or `timeoutOption` on timeout.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Outcome' } },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '413': { $ref: '#/components/responses/PayloadTooLarge' },
            '500': errorResponse('Internal error, or the request was cancelled.'),
            '502': { $ref: '#/components/responses/SendFailed' },
            '503': { $ref: '#/components/responses/NotPaired' },
          },
        },
      },
      '/notify': {
        post: {
          operationId: 'notify',
          summary: "Send a message that doesn't need an answer",
          description:
            'Returns once the message is sent. The message has a Dismiss button and is deleted automatically later.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/NotifyRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'Sent.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { ok: { const: true } },
                    required: ['ok'],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '413': { $ref: '#/components/responses/PayloadTooLarge' },
            '502': { $ref: '#/components/responses/SendFailed' },
            '503': { $ref: '#/components/responses/NotPaired' },
          },
        },
      },
      '/status': {
        get: {
          operationId: 'status',
          summary: 'Pairing state',
          responses: {
            '200': {
              description: '`code` and `instructions` are present only while unpaired.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Status' } },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/openapi.yaml': {
        get: {
          operationId: 'openapi',
          summary: 'This document',
          security: [],
          responses: {
            '200': {
              description: 'OpenAPI document for this service.',
              content: { 'application/yaml': { schema: { type: 'string' } } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'The token `init` saved to `~/.config/telegram-ask/token`. A service installed without a token ignores the header.',
        },
      },
      schemas: {
        ApprovalRequest: toBodySchema(createApprovalRequestSchema(maxTextLength), maxTextLength),
        Outcome: {
          type: 'object',
          properties: {
            answer: { type: 'string', description: 'The tapped option, or `timeoutOption`.' },
            timedOut: { type: 'boolean' },
          },
          required: ['answer', 'timedOut'],
        },
        NotifyRequest: toBodySchema(createNotifyRequestSchema(maxTextLength), maxTextLength),
        Status: status,
        Error: {
          type: 'object',
          properties: { error: { type: 'string' } },
          required: ['error'],
        },
      },
      responses: {
        Unauthorized: errorResponse('Missing or wrong bearer token.'),
        BadRequest: errorResponse(
          'Body is not valid JSON or fails validation; `error` is the first problem found. Nothing is sent.',
        ),
        PayloadTooLarge: errorResponse(`Body over ${MAX_BODY_BYTES} bytes.`),
        SendFailed: errorResponse("The message couldn't be sent."),
        NotPaired: errorResponse('No owner is paired yet.'),
      },
    },
  }
}

/** `createOpenApiDocument` as YAML. */
export function formatOpenApiYaml(options: OpenApiOptions): string {
  return stringify(createOpenApiDocument(options), { lineWidth: 0 })
}
