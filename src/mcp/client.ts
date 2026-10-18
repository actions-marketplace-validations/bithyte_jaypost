import { request as httpRequest } from 'node:http'
import {
  CANCELLED_MESSAGE,
  HOST,
  NOT_PAIRED_MESSAGE,
  NOT_SUPPORTED_MESSAGE,
  SEND_FAILED_MESSAGE,
  TOO_OLD_MESSAGE,
} from './constants.ts'
import type { ApiOptions, ApiPath, ApiResult } from './types.ts'

/**
 * POSTs JSON to the local service. Never throws; no retries. Uses node:http rather than fetch,
 * whose 300 s headers timeout would cut off a request that waits the full approval timeout.
 */
export async function postApi(
  port: number,
  path: ApiPath,
  body: object,
  options: ApiOptions,
): Promise<ApiResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = AbortSignal.any([options.signal, timeout])
  let response: RawResponse
  try {
    response = await send(port, path, JSON.stringify(body), signal)
  } catch {
    return { kind: 'failed', message: describeTransportFailure(port, options, timeout) }
  }
  if (response.status === 200) {
    return parseOk(response.text)
  }
  return { kind: 'failed', message: describeStatus(response.status, path, response.text) }
}

type RawResponse = { readonly status: number; readonly text: string }

/** Rejects on connection errors, resets and aborts; an abort destroys the socket. */
function send(
  port: number,
  path: ApiPath,
  payload: string,
  signal: AbortSignal,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: HOST,
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
        signal,
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          text += chunk
        })
        response.on('error', reject)
        response.on('close', () => {
          if (!response.complete) {
            reject(new Error('response cut off'))
            return
          }
          resolve({ status: response.statusCode ?? 0, text })
        })
      },
    )
    request.on('error', reject)
    request.end(payload)
  })
}

function describeTransportFailure(port: number, options: ApiOptions, timeout: AbortSignal): string {
  if (options.signal.aborted) {
    return CANCELLED_MESSAGE
  }
  if (timeout.aborted) {
    return `telegram-ask service didn't answer within ${options.timeoutMs / 1000} s`
  }
  return `telegram-ask service not reachable on ${HOST}:${port} (run telegram-ask status)`
}

function parseOk(text: string): ApiResult {
  try {
    return { kind: 'ok', body: JSON.parse(text) }
  } catch {
    return {
      kind: 'failed',
      message: `telegram-ask service sent an unreadable answer: ${text.trim()}`,
    }
  }
}

function describeStatus(status: number, path: ApiPath, text: string): string {
  const error = readErrorField(text)
  if (status === 400 && error !== undefined) {
    return error
  }
  if (status === 404 && path === '/notify') {
    return TOO_OLD_MESSAGE
  }
  if (status === 501) {
    return NOT_SUPPORTED_MESSAGE
  }
  if (status === 503) {
    return NOT_PAIRED_MESSAGE
  }
  if (status === 502) {
    return SEND_FAILED_MESSAGE
  }
  return `telegram-ask service error ${status}: ${error ?? text.trim()}`
}

function readErrorField(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      return typeof parsed.error === 'string' ? parsed.error : undefined
    }
  } catch {
    // not JSON, caller falls back to the raw text
  }
  return undefined
}
