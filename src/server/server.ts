import Fastify from 'fastify'
import type { FastifyError, FastifyInstance } from 'fastify'
import { parseApprovalRequest, SendError } from '../approval/index.ts'
import type { ApprovalService } from '../approval/index.ts'
import { MAX_BODY_BYTES } from './constants.ts'
import type { StatusInfo } from './types.ts'

export function createApiServer(
  service: Pick<ApprovalService, 'request'>,
  status: () => StatusInfo,
): FastifyInstance {
  // Pending requests can hang for minutes; close() shouldn't wait for them.
  const app = Fastify({ bodyLimit: MAX_BODY_BYTES, forceCloseConnections: true })

  // Take the body as text whatever the content type, so bad JSON gets our own 400.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body))

  app.setNotFoundHandler((request, reply) => {
    // Not new URL(): it throws on targets like '//'.
    const path = request.url.split('?')[0]
    if (path === '/request') {
      return reply.code(405).header('Allow', 'POST').send({ error: 'method not allowed' })
    }
    if (path === '/status') {
      return reply.code(405).header('Allow', 'GET').send({ error: 'method not allowed' })
    }
    return reply.code(404).send({ error: 'not found' })
  })

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof SendError) {
      return reply.code(502).send({ error: 'failed to send Telegram message' })
    }
    if (err.statusCode === 413) {
      // Drop the rest of the upload once the response is flushed.
      reply.raw.once('finish', () => request.raw.destroy())
      return reply.code(413).header('Connection', 'close').send({ error: 'request body too large' })
    }
    if (err.statusCode !== undefined && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message })
    }
    console.error('unexpected error handling /request', err)
    return reply.code(500).send({ error: 'internal server error' })
  })

  app.get('/status', async () => status())

  app.post<{ Body: string | undefined }>('/request', async (request, reply) => {
    if (!status().paired) {
      return reply.code(503).send({ error: 'not paired' })
    }
    let json: unknown
    try {
      json = JSON.parse(request.body ?? '')
    } catch {
      return reply.code(400).send({ error: 'body must be valid JSON' })
    }

    const parsed = parseApprovalRequest(json)
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error })
    }

    const controller = new AbortController()
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort()
    })
    // The client may have gone while the body was being read, before 'close' was observed.
    if (reply.raw.destroyed) controller.abort()

    const outcome = await service.request(parsed.value, controller.signal)
    if (outcome === null) {
      // Cancelled; normally because the client is gone, so this write is a no-op.
      return reply.code(500).send({ error: 'request was cancelled' })
    }
    return outcome
  })

  return app
}
