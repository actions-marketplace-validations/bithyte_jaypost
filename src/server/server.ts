import Fastify from 'fastify'
import type { FastifyError, FastifyInstance } from 'fastify'
import { parseApprovalRequest, SendError } from '../approval/index.ts'
import type { ApprovalService } from '../approval/index.ts'
import { parseNotifyRequest } from '../notify/index.ts'
import type { NotificationService } from '../notify/index.ts'
import { MAX_BODY_BYTES } from './constants.ts'
import type { StatusInfo } from './types.ts'

/**
 * Builds the HTTP API (POST /request, POST /notify, GET /status) without listening. Aborting the
 * connection cancels the pending request; errors return JSON bodies. Without `notifications`,
 * POST /notify answers 501.
 */
export function createApiServer(
  service: Pick<ApprovalService, 'request'>,
  status: () => StatusInfo,
  notifications?: Pick<NotificationService, 'notify'>,
): FastifyInstance {
  // Pending requests can hang for minutes; close() shouldn't wait for them.
  const app = Fastify({ bodyLimit: MAX_BODY_BYTES, forceCloseConnections: true })
  // Take the body as text whatever the content type, so bad JSON gets our own 400.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => done(null, body))
  app.setNotFoundHandler((request, reply) => {
    // Not new URL(): it throws on targets like '//'.
    const path = request.url.split('?')[0]
    if (path === '/request' || path === '/notify') {
      return reply.code(405).header('Allow', 'POST').send({ error: 'method not allowed' })
    }
    if (path === '/status') {
      return reply.code(405).header('Allow', 'GET').send({ error: 'method not allowed' })
    }
    return reply.code(404).send({ error: 'not found' })
  })
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof SendError) {
      return reply.code(502).send({ error: 'failed to send Telegram message' })
    }
    if (error.statusCode === 413) {
      // Drop the rest of the upload once the response is flushed.
      reply.raw.once('finish', () => request.raw.destroy())
      return reply.code(413).header('Connection', 'close').send({ error: 'request body too large' })
    }
    if (error.statusCode !== undefined && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message })
    }
    console.error(`unexpected error handling ${request.url}`, error)
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
      if (!reply.raw.writableEnded) {
        controller.abort()
      }
    })
    // The client may have gone while the body was being read, before 'close' was observed.
    if (reply.raw.destroyed) {
      controller.abort()
    }
    const result = await service.request(parsed.value, controller.signal)
    if (result.kind === 'cancelled') {
      // Normally because the client is gone, so this write is a no-op.
      return reply.code(500).send({ error: 'request was cancelled' })
    }
    return result.outcome
  })
  app.post<{ Body: string | undefined }>('/notify', async (request, reply) => {
    if (notifications === undefined) {
      return reply.code(501).send({ error: 'notifications not supported' })
    }
    if (!status().paired) {
      return reply.code(503).send({ error: 'not paired' })
    }
    let json: unknown
    try {
      json = JSON.parse(request.body ?? '')
    } catch {
      return reply.code(400).send({ error: 'body must be valid JSON' })
    }
    const parsed = parseNotifyRequest(json)
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error })
    }
    await notifications.notify(parsed.value)
    return { ok: true }
  })
  return app
}
