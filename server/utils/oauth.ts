import type { H3Event } from 'h3'
import { z } from 'zod'
import { OAuthError } from '../lib/api/oauth'

export const authorizeParams = z.object({
  response_type: z.string().max(40).optional(),
  client_id: z.string().max(64).optional(),
  redirect_uri: z.string().max(500).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  scope: z.string().max(500).optional(),
  state: z.string().max(1000).optional(),
  resource: z.string().max(300).optional(),
})

export async function readOAuthBody(event: H3Event): Promise<Record<string, string>> {
  if (Number(getHeader(event, 'content-length') ?? 0) > 64 * 1024) throw new OAuthError('invalid_request', 'Request too large', 413)
  const raw = await readBody(event).catch(() => null)
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v
  return out
}

export function oauthError(event: H3Event, err: unknown) {
  if (err instanceof OAuthError) {
    setResponseStatus(event, err.status)
    return { error: err.code, error_description: err.message }
  }
  throw err
}

export function hostOf(uri: string): string {
  try {
    const u = new URL(uri)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : u.protocol.replace(/:$/, '')
  }
  catch {
    return ''
  }
}
