import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SendError } from './approvals.ts'
import type { ApprovalService } from './approvals.ts'
import { parseApprovalRequest } from './validate.ts'

const MAX_BODY_BYTES = 65536

class BodyTooLarge extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        cleanup()
        req.pause()
        reject(new BodyTooLarge())
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      cleanup()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

async function handleRequest(
  service: Pick<ApprovalService, 'request'>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: string
  try {
    raw = await readBody(req)
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      res.setHeader('Connection', 'close')
      sendJson(res, 413, { error: 'request body too large' })
      // Drop the rest of the upload once the response is flushed.
      res.once('finish', () => req.destroy())
      return
    }
    throw err
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: 'body must be valid JSON' })
    return
  }

  const parsed = parseApprovalRequest(json)
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error })
    return
  }

  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  try {
    const outcome = await service.request(parsed.value, controller.signal)
    if (outcome === null) {
      // Cancelled; normally because the client is gone, so this write is a no-op.
      sendJson(res, 500, { error: 'request was cancelled' })
      return
    }
    sendJson(res, 200, outcome)
  } catch (err) {
    if (err instanceof SendError) {
      sendJson(res, 502, { error: 'failed to send Telegram message' })
      return
    }
    console.error('unexpected error handling /request', err)
    sendJson(res, 500, { error: 'internal server error' })
  }
}

export function createApiServer(service: Pick<ApprovalService, 'request'>): http.Server {
  return http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path !== '/request') {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    handleRequest(service, req, res).catch((err) => {
      console.error('unexpected error handling /request', err)
      sendJson(res, 500, { error: 'internal server error' })
    })
  })
}
