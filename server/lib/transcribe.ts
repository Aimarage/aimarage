import { sql } from 'drizzle-orm'
import { config } from './config'
import { today } from './clock'
import type { DbOrTx } from './db'
import { ownLlmFor } from './own-llm'
import { RateLimiter } from './ratelimit'
import type { schema } from './db'

type Workspace = typeof schema.workspaces.$inferSelect
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

// Spracheingabe: Audio geht einmal an Mistral Voxtral (EU) und wird nicht gespeichert, zurück kommt nur der Text.
// Betreiber-Schlüssel (TRANSCRIBE_API_KEY) oder eigener Mistral-Schlüssel des Workspaces.
export const TRANSCRIBE_MAX_BYTES = 8 * 1024 * 1024
export const transcribeLimiter = new RateLimiter('stt', 30, 60 * 60_000)

export interface SttTarget { baseUrl: string, apiKey: string, model: string, own: boolean }

export function sttTarget(ws: Workspace): SttTarget | null {
  const own = ownLlmFor(ws)
  if (own?.apiKey && /api\.mistral\.ai/.test(own.baseUrl)) return { baseUrl: own.baseUrl.replace(/\/+$/, ''), apiKey: own.apiKey, model: config.transcribeModel, own: true }
  if (config.transcribeApiKey) return { baseUrl: config.transcribeBaseUrl.replace(/\/+$/, ''), apiKey: config.transcribeApiKey, model: config.transcribeModel, own: false }
  return null
}

export class SttError extends Error {}

export async function transcribe(db: DbOrTx, ws: Workspace, audio: { data: Buffer, type: string, name: string }, lang: string | null, fetcher: FetchLike = fetch): Promise<string> {
  const t = sttTarget(ws)
  if (!t) throw new SttError('Spracheingabe ist nicht eingerichtet')
  if (!audio.data.length) throw new SttError('Keine Aufnahme')
  if (audio.data.length > TRANSCRIBE_MAX_BYTES) throw new SttError('Aufnahme zu lang')
  const fd = new FormData()
  fd.append('model', t.model)
  fd.append('file', new Blob([new Uint8Array(audio.data)], { type: audio.type || 'audio/webm' }), audio.name || 'audio.webm')
  if (lang) fd.append('language', lang)
  const res = await fetcher(`${t.baseUrl}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${t.apiKey}` }, body: fd, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new SttError(`Transkription fehlgeschlagen (${res.status})`)
  const body = await res.json() as { text?: string }
  const text = (body.text ?? '').replace(/[–—]/g, '-').trim()
  if (!t.own) await db.execute(sql`insert into service_usage (workspace_id, day, service, units) values (${ws.id}, ${today(ws.timezone)}, 'stt', 1) on conflict (workspace_id, day, service) do update set units = service_usage.units + 1`)
  return text
}
