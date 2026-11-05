import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { now } from '../clock'
import type { DbOrTx } from '../db'
import { schema } from '../db'
import { config } from '../config'
import { notify } from '../notify'
import type { ApiPrincipal } from './principal'

export const CALL_LOG_DAYS = 90
export const DENIED_ALERT = 20

// Wem ein Aufruf zugeordnet wird: angemeldeter Schlüssel oder ein abgelaufener bzw. widerrufener, der noch bekannt ist.
export interface CallKey {
  workspaceId: string
  userId: string
  tokenId?: string | null
  grantId?: string | null
  label: string
}

export function keyOf(p: ApiPrincipal): CallKey {
  return { workspaceId: p.session.workspace.id, userId: p.session.user.id, tokenId: p.tokenId ?? null, grantId: p.grantId ?? null, label: p.label }
}

// Diese Argumente sind Kennungen oder Einstellungen, keine Inhalte: sie stehen im Protokoll im Klartext.
const PLAIN = new Set(['projekt', 'project', 'code', 'entwurf_id', 'id', 'status', 'datum', 'date', 'uhrzeit', 'time', 'kategorie', 'category', 'art', 'kind', 'ab', 'from', 'tage', 'days', 'von', 'bis', 'to', 'anzahl', 'limit', 'aenderung', 'change', 'kanal', 'channel', 'plattform', 'platform', 'force', 'anlegen', 'create', 'nur_geprueft', 'aufgabe_verwerfen', 'dropTask', 'ziel_id', 'kennzahl', 'metricKey', 'zaehlweise', 'mode', 'aktiv', 'active', 'tag', 'day', 'release_datum', 'releaseDate', 'abstand_tage', 'every', 'pressetext', 'press', 'start', 'entwurf', 'draft', 'stand', 'wert', 'value', 'zielwert', 'target', 'frist', 'deadline'])

function urlHost(v: string): string {
  try {
    return `URL ${new URL(v).hostname}`
  }
  catch {
    return `${v.length} Zeichen`
  }
}

// Kurzfassung ohne Inhalte: Kennungen bleiben, Texte werden zur Länge, Links zum Host.
export function summarizeArgs(args: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!args || typeof args !== 'object') return out
  for (const [k, v] of Object.entries(args as Record<string, unknown>).slice(0, 30)) {
    if (v === undefined || v === null) continue
    const key = k.slice(0, 40)
    if (/url|link/i.test(k) && typeof v === 'string') out[key] = urlHost(v)
    else if (PLAIN.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) out[key] = String(v).replace(/[\x00-\x1F\x7F]+/g, ' ').slice(0, 60)
    else if (typeof v === 'string') out[key] = `${v.length} Zeichen`
    else if (Array.isArray(v)) out[key] = `${v.length} Einträge`
    else if (typeof v === 'object') out[key] = `${Object.keys(v as object).length} Felder`
    else out[key] = typeof v
  }
  return out
}

// IP gekürzt (IPv4 /24, IPv6 /48): reicht zum Erkennen fremder Zugriffe, ohne die volle Adresse zu speichern.
export function shortIp(ip: string | null | undefined): string | null {
  if (!ip || ip === 'unknown') return null
  const v4 = ip.replace(/^::ffff:/, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.replace(/\.\d+$/, '.0')
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::`
  return null
}

export interface CallEntry {
  via: 'mcp' | 'rest'
  tool: string
  args?: unknown
  project?: { id: string, slug: string } | null
  ok: boolean
  denied?: boolean
  error?: string | null
  resultBytes?: number
  durationMs?: number
  client?: string | null
  ip?: string | null
}

export async function logCall(db: DbOrTx, who: ApiPrincipal | CallKey, e: CallEntry): Promise<void> {
  const k = 'session' in who ? keyOf(who) : who
  try {
    await db.insert(schema.mcpCalls).values({
      workspaceId: k.workspaceId,
      userId: k.userId,
      tokenId: k.tokenId ?? null,
      grantId: k.grantId ?? null,
      keyLabel: k.label.slice(0, 80),
      client: e.client?.slice(0, 120) ?? null,
      ip: shortIp(e.ip),
      via: e.via,
      tool: e.tool.slice(0, 80),
      projectId: e.project?.id ?? null,
      project: e.project?.slug ?? null,
      args: summarizeArgs(e.args),
      ok: e.ok && !e.denied,
      denied: !!e.denied,
      error: e.error ? e.error.slice(0, 200) : null,
      resultBytes: Math.max(0, Math.round(e.resultBytes ?? 0)),
      durationMs: Math.max(0, Math.round(e.durationMs ?? 0)),
      createdAt: now(),
    })
    if (e.denied) await alertDenied(db, k)
  }
  catch (err) {
    console.error(`[mcp-log] ${(err as Error).message}`)
  }
}

// Gehäufte Ablehnungen eines Schlüssels (falsche Rechte, Grenzen, abgelaufen): einmal am Tag Mail an die Person, der er gehört.
export async function alertDenied(db: DbOrTx, k: CallKey, at = now()): Promise<boolean> {
  const who = k.tokenId ? eq(schema.mcpCalls.tokenId, k.tokenId) : k.grantId ? eq(schema.mcpCalls.grantId, k.grantId) : null
  if (!who) return false
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.mcpCalls)
    .where(and(who, eq(schema.mcpCalls.denied, true), gte(schema.mcpCalls.createdAt, new Date(at.getTime() - 3_600_000))))
  const n = r?.n ?? 0
  if (n < DENIED_ALERT) return false
  const url = `${config.appUrl}/einstellungen/api`
  const sent = await notify(db, k.workspaceId, k.userId, 'api_denied', {
    text: {
      de: { subject: `Aimarage: viele abgelehnte Aufrufe mit Schlüssel "${k.label}"`, body: `Mit deinem API/MCP-Schlüssel "${k.label}" wurden in der letzten Stunde ${n} Aufrufe abgelehnt (fehlende Rechte, Grenzen erreicht oder Schlüssel abgelaufen bzw. widerrufen). Wenn das nicht du bzw. dein Programm warst, widerrufe den Schlüssel. Details stehen im Protokoll unter Einstellungen > API und MCP.`, actionUrl: url, actionLabel: 'Protokoll ansehen' },
      en: { subject: `Aimarage: many rejected calls with key "${k.label}"`, body: `${n} calls with your API/MCP key "${k.label}" were rejected in the last hour (missing permissions, limits reached or key expired or revoked). If this was not you or your program, revoke the key. Details are in the log under Settings > API and MCP.`, actionUrl: url, actionLabel: 'View log' },
    },
  }, { dedupeKey: `api_denied:${k.tokenId ?? k.grantId}:${at.toISOString().slice(0, 10)}` })
  return sent > 0
}

export async function listCalls(db: DbOrTx, q: { workspaceId: string, userId?: string | null, tokenId?: string | null, limit?: number, before?: number | null }) {
  const rows = await db.select({ c: schema.mcpCalls, user: schema.users.name }).from(schema.mcpCalls)
    .leftJoin(schema.users, eq(schema.users.id, schema.mcpCalls.userId))
    .where(and(
      eq(schema.mcpCalls.workspaceId, q.workspaceId),
      q.userId ? eq(schema.mcpCalls.userId, q.userId) : undefined,
      q.tokenId ? eq(schema.mcpCalls.tokenId, q.tokenId) : undefined,
      q.before ? lt(schema.mcpCalls.id, q.before) : undefined,
    ))
    .orderBy(desc(schema.mcpCalls.id)).limit(Math.min(200, Math.max(1, q.limit ?? 100)))
  return rows.map(({ c, user }) => ({ id: c.id, at: c.createdAt.toISOString(), user, key: c.keyLabel, tokenId: c.tokenId, client: c.client, ip: c.ip, via: c.via, tool: c.tool, project: c.project, args: c.args, ok: c.ok, denied: c.denied, error: c.error, bytes: c.resultBytes, ms: c.durationMs }))
}

export async function pruneCalls(db: DbOrTx, at = now()): Promise<number> {
  const rows = await db.delete(schema.mcpCalls).where(lt(schema.mcpCalls.createdAt, new Date(at.getTime() - CALL_LOG_DAYS * 86_400_000))).returning({ id: schema.mcpCalls.id })
  return rows.length
}
