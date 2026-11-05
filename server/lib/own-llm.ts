import { and, eq, gt, sql } from 'drizzle-orm'
import type { OwnLlmSettings } from '../db/schema'
import { config } from './config'
import { updateSettings } from './connections'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { extensionAllowsOwnLlm } from './extensions'
import { enqueueJob } from './jobs'
import type { LlmMeter } from './llm-meter'
import { isOwnProvider, keyHint, LlmError, llmLocked, modelPrice, normUrl, OWN_PROVIDERS, OWN_TIMEOUT_MS, type LlmConfig, type OwnKeyProblem, type OwnProvider } from './llm'
import { notify } from './notify'
import { decryptSecret, encryptSecret } from './secret'

// Eigener KI-Schlüssel ("bring your own key"): Der Kunde trägt einen Schlüssel bei einem Anbieter aus OWN_PROVIDERS ein.
// Aufrufe darüber zählen nicht ins KI-Budget des Tarifs. Schlägt der Schlüssel fehl, gibt es kein stilles Zurückfallen
// auf die KI des Betreibers: der Workspace wird gesperrt markiert, der Admin bekommt einen Hinweis, Jobs laufen nach der Behebung weiter.

type Workspace = typeof schema.workspaces.$inferSelect

const QUOTA_PAUSE_MS = 60 * 60 * 1000

export const OWN_PROBLEM_TEXT: Record<OwnKeyProblem, { de: string, en: string }> = {
  auth: { de: 'Schlüssel abgelehnt', en: 'key rejected' },
  quota: { de: 'Guthaben oder Kontingent beim Anbieter aufgebraucht', en: 'credit or quota at the provider used up' },
  model: { de: 'Modell beim Anbieter nicht gefunden', en: 'model not found at the provider' },
}

export function ownLlmAllowed(ws: Workspace): boolean {
  return llmLocked() && extensionAllowsOwnLlm(ws)
}

function keyContext(workspaceId: string, baseUrl: string): string {
  return `own-llm-key|${workspaceId}|${normUrl(baseUrl)}`
}

export function ownProviderOf(own: OwnLlmSettings | undefined): OwnProvider | null {
  return isOwnProvider(own?.provider) ? own.provider : null
}

export function storedOwnKey(own: OwnLlmSettings | undefined, workspaceId: string): { key: string | null, unreadable: boolean } {
  const p = ownProviderOf(own)
  const k = own?.key
  if (!p || !k || normUrl(k.baseUrl) !== normUrl(OWN_PROVIDERS[p].baseUrl)) return { key: null, unreadable: false }
  const key = decryptSecret(k.enc, keyContext(workspaceId, OWN_PROVIDERS[p].baseUrl))
  return { key, unreadable: !key }
}

export function ownBlocked(own: OwnLlmSettings | undefined, at = new Date()): string | null {
  const e = own?.error
  if (!e) return null
  if (e.until && new Date(e.until).getTime() <= at.getTime()) return null
  return `Eigener KI-Schlüssel gesperrt (${OWN_PROBLEM_TEXT[e.code]?.de ?? e.code}). Bitte unter Einstellungen > KI (/einstellungen/ki) prüfen und "Verbindung testen".`
}

export function ownLlmConfig(own: OwnLlmSettings | undefined, workspaceId: string, env = config.llm): LlmConfig | null {
  const p = ownProviderOf(own)
  if (!p || !own?.key) return null
  const def = OWN_PROVIDERS[p]
  const stored = storedOwnKey(own, workspaceId)
  const model = own.model?.trim() || def.model
  const price = modelPrice(model)
  const blocked = ownBlocked(own) ?? (stored.unreadable || !stored.key ? 'Eigener KI-Schlüssel nicht lesbar, bitte unter Einstellungen > KI (/einstellungen/ki) neu eintragen.' : null)
  return {
    provider: def.wire,
    baseUrl: def.baseUrl,
    apiKey: stored.key ?? '',
    keySource: 'workspace',
    model,
    modelFast: own.modelFast?.trim() || (own.model?.trim() ? model : def.modelFast),
    reasoning: false,
    timeoutMs: Math.max(env.timeoutMs, OWN_TIMEOUT_MS),
    priceInEur: price?.inEur ?? 0,
    priceOutEur: price?.outEur ?? 0,
    needsKey: true,
    own: true,
    ownProvider: p,
    ...(blocked ? { blocked } : {}),
  }
}

// Gilt für alle Aufrufe des Workspace, solange der Tarif es erlaubt (die SaaS-Erweiterung entscheidet).
export function ownLlmFor(ws: Workspace): LlmConfig | null {
  return ownLlmAllowed(ws) ? ownLlmConfig(ws.settings?.ownLlm, ws.id) : null
}

export interface OwnLlmUpdate {
  provider?: OwnProvider
  model?: string
  modelFast?: string
  apiKey?: string
  remove?: boolean
}

export function applyOwnLlmUpdate(current: OwnLlmSettings | undefined, input: OwnLlmUpdate, workspaceId: string, at = new Date()): OwnLlmSettings | undefined {
  if (input.remove) return undefined
  const next: OwnLlmSettings = { ...current }
  const changed = input.provider !== undefined && input.provider !== current?.provider
  if (input.provider) next.provider = input.provider
  if (changed) {
    delete next.model
    delete next.modelFast
  }
  if (input.model !== undefined) next.model = input.model.trim() || undefined
  if (input.modelFast !== undefined) next.modelFast = input.modelFast.trim() || undefined
  const p = ownProviderOf(next)
  if (!p) return undefined
  const url = OWN_PROVIDERS[p].baseUrl
  if (next.key && normUrl(next.key.baseUrl) !== normUrl(url)) delete next.key
  const k = input.apiKey?.trim()
  if (k) next.key = { enc: encryptSecret(k, keyContext(workspaceId, url)), hint: keyHint(k), baseUrl: url, setAt: at.toISOString() }
  delete next.error
  return next
}

export async function ownLlmUsage(db: DbOrTx, ws: Pick<Workspace, 'id' | 'timezone'>): Promise<{ costEur: number, runs: number }> {
  const tz = ws.timezone || 'Europe/Vienna'
  const [r] = await db.select({ eur: sql<number>`coalesce(sum(${schema.agentRuns.ownCostEur}), 0)::float8`, n: sql<number>`count(*)::int` }).from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.workspaceId, ws.id), gt(schema.agentRuns.ownCostEur, 0), sql`${schema.agentRuns.startedAt} >= (date_trunc('month', now() at time zone ${tz}) at time zone ${tz})`))
  return { costEur: Math.round(Number(r?.eur ?? 0) * 100) / 100, runs: Number(r?.n ?? 0) }
}

// Für die Oberfläche: nie den Schlüssel, nur "gesetzt" und die letzten 4 Zeichen (nur für Admins).
export function publicOwnLlm(ws: Workspace, admin: boolean) {
  const own = ws.settings?.ownLlm
  const p = ownProviderOf(own)
  const stored = storedOwnKey(own, ws.id)
  const allowed = ownLlmAllowed(ws)
  const e = own?.error
  return {
    available: llmLocked() && (allowed || !!ws.pausedAt),
    allowed,
    paused: !!ws.pausedAt,
    active: allowed && !!stored.key,
    provider: p,
    model: p ? own?.model?.trim() || OWN_PROVIDERS[p].model : null,
    modelFast: p ? own?.modelFast?.trim() || (own?.model?.trim() ? own.model.trim() : OWN_PROVIDERS[p].modelFast) : null,
    key: { set: !!own?.key, hint: admin && own?.key ? own.key.hint : null, setAt: own?.key?.setAt ?? null, unreadable: stored.unreadable },
    error: e ? { code: e.code, message: admin ? e.message : '', at: e.at, until: e.until ?? null, active: !!ownBlocked(own) } : null,
    providers: (Object.keys(OWN_PROVIDERS) as OwnProvider[]).map(id => ({ id, model: OWN_PROVIDERS[id].model, modelFast: OWN_PROVIDERS[id].modelFast, region: OWN_PROVIDERS[id].region, baseUrl: OWN_PROVIDERS[id].baseUrl })),
  }
}

// Nach einem Lauf: hat der eigene Schlüssel versagt, Workspace sperren und Admins benachrichtigen. Gibt die Meldung für das Protokoll zurück.
export async function handleOwnKeyFailure(db: Db, ws: Pick<Workspace, 'id' | 'timezone'>, meter: LlmMeter | undefined): Promise<string | null> {
  const err = meter?.ownKeyError
  if (!(err instanceof LlmError) || !err.ownKey) return null
  await flagOwnLlmError(db, ws, err)
  return ownErrorSummary(err)
}

export function ownErrorSummary(err: LlmError): string {
  return `Eigener KI-Schlüssel: ${OWN_PROBLEM_TEXT[err.ownKey ?? 'auth'].de}. Nichts wurde über die KI von Aimarage nachgeholt. Bitte unter Einstellungen > KI (/einstellungen/ki) prüfen (${err.message.slice(0, 200)})`
}

export async function flagOwnLlmError(db: Db, ws: Pick<Workspace, 'id' | 'timezone'>, err: LlmError, at = new Date()): Promise<boolean> {
  const code = err.ownKey ?? 'auth'
  let fresh = false
  await updateSettings(db, ws.id, (s) => {
    if (!s.ownLlm?.key || ownBlocked(s.ownLlm, at)) return s
    fresh = true
    s.ownLlm = { ...s.ownLlm, error: { code, message: err.message.slice(0, 300), at: at.toISOString(), until: code === 'quota' ? new Date(at.getTime() + QUOTA_PAUSE_MS).toISOString() : null } }
    return s
  })
  if (!fresh) return false
  const url = `${config.appUrl}/einstellungen/ki`
  const t = OWN_PROBLEM_TEXT[code]
  try {
    await notify(db, ws.id, null, 'own_llm', {
      code,
      text: {
        de: { subject: 'Eigener KI-Schlüssel funktioniert nicht', body: `Der Agent konnte deinen eigenen KI-Schlüssel nicht verwenden: ${t.de}. Solange das so ist, schreibt er keine neuen Entwürfe; die KI von Aimarage springt nicht ein. Bitte den Schlüssel in den Einstellungen prüfen und "Verbindung testen" drücken. Danach geht es automatisch weiter.`, actionUrl: url, actionLabel: 'Einstellungen öffnen' },
        en: { subject: 'Your own AI key is not working', body: `The agent could not use your own AI key: ${t.en}. Until this is fixed it writes no new drafts; the Aimarage AI does not step in. Please check the key in the settings and press "Test connection". It continues automatically afterwards.`, actionUrl: url, actionLabel: 'Open settings' },
      },
    }, { dedupeKey: `own-llm:${code}:${ws.id}:${at.toISOString().slice(0, 10)}` })
  }
  catch (e) {
    console.error('[own-llm] Hinweis nicht verschickt:', (e as Error).message)
  }
  return true
}

// Nach Behebung (neuer Schlüssel, erfolgreicher Test): Sperre aufheben und liegengebliebene Entwürfe nachholen.
export async function clearOwnLlmError(db: Db, workspaceId: string): Promise<boolean> {
  let had = false
  await updateSettings(db, workspaceId, (s) => {
    if (!s.ownLlm?.error) return s
    had = true
    const { error: _e, ...rest } = s.ownLlm
    s.ownLlm = rest
    return s
  })
  if (had) await resumeAfterOwnLlmFix(db, workspaceId)
  return had
}

export async function resumeAfterOwnLlmFix(db: Db, workspaceId: string): Promise<void> {
  await enqueueJob(db, 'draft_tasks', { workspaceId, dedupeKey: `draft_tasks:${workspaceId}:own-llm:${Date.now()}` })
}
