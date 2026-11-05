import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { PostPlatformResult } from '../db/schema'
import { redactKey } from './llm'
import { config } from './config'
import { updateSettings } from './connections'
import { numLimit, platformTaken, socialAccountsUsed } from './limits'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { looksHtml, statusText } from './platforms/types'
import type { FetchLike, OutletMedia, PostOutcome, PostRequest, SocialOutlet } from './outlets'
import { registerOutlet } from './outlets'
import { enqueueJob } from './jobs'
import { hostedAccounts, hostedZernioKey, parseAccounts, projectAccounts, SOCIAL_PROVIDERS, socialConfig, socialEnvAllowed, type ProjectSocial, type SocialAccount, type SocialConfig, type SocialSettings } from './social'
import { OutletError } from './uploadpost'
import { reportError } from './extensions'
import { POST_ERROR, type PostErrorKey } from '../../shared/utils/post-errors'

// Zernio (docs.zernio.com): Posten über einen Dienst statt eigener Plattform-Apps. Gehostet mit dem Betreiber-Schlüssel und
// je Workspace einem eigenen Profil (externalId = Workspace-ID); Konten werden über die Connect-Adresse von Zernio verbunden.

const BASE = SOCIAL_PROVIDERS.zernio.baseUrl

type Json = Record<string, unknown>
type Workspace = typeof schema.workspaces.$inferSelect

// Plattformen, die gehostet über Zernio verbunden werden (Bluesky, Mastodon und Telegram verbinden direkt, ohne Kosten).
export const ZERNIO_PLATFORMS = ['instagram', 'facebook', 'threads', 'linkedin', 'x', 'tiktok', 'youtube'] as const
export type ZernioPlatform = typeof ZERNIO_PLATFORMS[number]

export function isZernioPlatform(p: string): p is ZernioPlatform {
  return (ZERNIO_PLATFORMS as readonly string[]).includes(p)
}

export function toZernio(platform: string): string {
  return platform === 'x' ? 'twitter' : platform
}

export function fromZernio(platform: string): string {
  const p = platform.toLowerCase()
  return p === 'twitter' ? 'x' : p
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null
}

async function call(cfg: Pick<SocialConfig, 'apiKey'>, path: string, init: { method: 'GET' | 'POST' | 'DELETE', body?: unknown, headers?: Record<string, string> } = { method: 'GET' }, fetchImpl: FetchLike = fetch, timeoutMs = 60_000): Promise<{ status: number, data: Json }> {
  if (!cfg.apiKey) throw new OutletError('Kein Schlüssel für Zernio hinterlegt', 0, 'no_key')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${BASE}${path}`, {
      method: init.method,
      headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Accept': 'application/json', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    })
    const text = await res.text().catch(() => '')
    let data: Json = {}
    try {
      data = text ? JSON.parse(text) as Json : {}
    }
    catch {
      data = looksHtml(text) ? {} : { error: text.slice(0, 300) }
    }
    if (!res.ok) {
      const msg = res.status >= 500 ? statusText(res.status) : str(data.error) ?? str(data.message) ?? statusText(res.status)
      throw new OutletError(redactKey(`${res.status === 401 ? 'Schlüssel abgelehnt' : res.status === 429 ? 'Limit erreicht' : 'Zernio'}: ${msg}`, cfg.apiKey).slice(0, 400), res.status, str(data.code))
    }
    return { status: res.status, data }
  }
  catch (err) {
    if (err instanceof OutletError) throw err
    throw new OutletError(redactKey(`Zernio nicht erreichbar: ${(err as Error).message}`, cfg.apiKey).slice(0, 300), 0, 'network')
  }
  finally {
    clearTimeout(timer)
  }
}

// Profile

function profileIdOf(d: Json): string | null {
  const p = (d.profile ?? d) as Json
  return str(p._id ?? p.id)
}

export async function ensureProfile(db: Db, ws: Pick<Workspace, 'id' | 'name' | 'settings'>, cfg: SocialConfig, fetchImpl?: FetchLike): Promise<string> {
  const have = ws.settings?.social?.hosted?.profileId
  if (have) return have
  let id: string | null = null
  const found = await call(cfg, `/profiles?externalId=${encodeURIComponent(ws.id)}`, { method: 'GET' }, fetchImpl, 20_000)
  const list = Array.isArray(found.data.profiles) ? found.data.profiles as Json[] : Array.isArray(found.data) ? found.data as unknown as Json[] : []
  id = list.map(p => (p.externalId === ws.id ? str(p._id ?? p.id) : null)).find(Boolean) ?? null
  if (!id) {
    try {
      const made = await call(cfg, '/profiles', { method: 'POST', body: { name: `aimarage-${ws.id}`, description: ws.name.slice(0, 100), externalId: ws.id } }, fetchImpl, 20_000)
      id = profileIdOf(made.data)
    }
    catch (err) {
      if (!(err instanceof OutletError && err.status === 409)) throw err
      const again = await call(cfg, `/profiles?externalId=${encodeURIComponent(ws.id)}`, { method: 'GET' }, fetchImpl, 20_000)
      const l2 = Array.isArray(again.data.profiles) ? again.data.profiles as Json[] : []
      id = l2.map(p => (p.externalId === ws.id ? str(p._id ?? p.id) : null)).find(Boolean) ?? null
    }
  }
  if (!id) throw new OutletError('Zernio: Profil konnte nicht angelegt werden', 0, 'profile')
  const pid = id
  await updateSettings(db, ws.id, s => ({ ...s, social: { ...s.social, hosted: { profileId: pid, at: new Date().toISOString() } } }))
  return pid
}

// Verbinden: Adresse, an die der Browser geht. Zurück kommt er auf redirectUrl (mit connected bzw. error).
export async function connectUrl(cfg: SocialConfig, profileId: string, platform: ZernioPlatform, redirectUrl: string, fetchImpl?: FetchLike): Promise<string> {
  const q = new URLSearchParams({ profileId, redirect_url: redirectUrl })
  const res = await call(cfg, `/connect/${toZernio(platform)}?${q}`, { method: 'GET' }, fetchImpl, 20_000)
  const url = str(res.data.authUrl)
  if (!url || !/^https:\/\//.test(url)) throw new OutletError('Zernio: keine Anmelde-Adresse erhalten', 0, 'connect')
  return url
}

// Konten des Profils von Zernio holen und im Workspace ablegen. Liefert die neu hinzugekommenen.
export async function syncHostedAccounts(db: Db, workspaceId: string, cfg: SocialConfig, fetchImpl?: FetchLike): Promise<{ accounts: SocialAccount[], added: SocialAccount[] }> {
  if (!cfg.profileId) return { accounts: [], added: [] }
  const res = await call(cfg, `/accounts?profileId=${encodeURIComponent(cfg.profileId)}`, { method: 'GET' }, fetchImpl, 20_000)
  const at = new Date().toISOString()
  const list = parseAccounts('zernio', res.data).filter(a => a.profileId === cfg.profileId).map(a => ({ ...a, platform: fromZernio(a.platform) }))
  let added: SocialAccount[] = []
  let accounts: SocialAccount[] = []
  await updateSettings(db, workspaceId, (s) => {
    const before = s.social?.accounts ?? []
    const known = new Map(before.map(a => [a.id, a]))
    accounts = list.map(a => ({ ...a, connectedAt: known.get(a.id)?.connectedAt ?? at }))
    added = accounts.filter(a => !known.has(a.id))
    return { ...s, social: { ...s.social, accounts, checkedAt: at } }
  })
  return { accounts, added }
}

export async function disconnectAccount(cfg: SocialConfig, accountId: string, fetchImpl?: FetchLike): Promise<void> {
  try {
    await call(cfg, `/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' }, fetchImpl, 20_000)
  }
  catch (err) {
    if (err instanceof OutletError && err.status === 404) return
    throw err
  }
}

export function hostedConfig(ws: Pick<Workspace, 'id' | 'settings'>): SocialConfig | null {
  const cfg = socialConfig(ws.settings?.social, ws.id, undefined, socialEnvAllowed(ws.settings))
  return cfg.keySource === 'hosted' ? cfg : null
}

export async function workspaceByProfile(db: DbOrTx, profileId: string): Promise<Workspace | null> {
  const [ws] = await db.select().from(schema.workspaces).where(sql`${schema.workspaces.settings}->'social'->'hosted'->>'profileId' = ${profileId}`).limit(1)
  return ws ?? null
}

// Webhook: Signatur X-Zernio-Signature = HMAC-SHA256 (hex) über den Rohtext mit dem Geheimnis des Endpunkts.
export function verifySignature(raw: string, header: string | null | undefined, secret = config.zernioWebhookSecret): boolean {
  if (!secret || !header) return false
  const want = createHmac('sha256', secret).update(raw).digest('hex')
  const got = header.trim().toLowerCase()
  if (got.length !== want.length || !/^[0-9a-f]+$/.test(got)) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(want))
}

// Beiträge

async function uploadMedia(cfg: SocialConfig, m: OutletMedia, fetchImpl: FetchLike = fetch): Promise<string> {
  if (m.url && /^https:\/\//.test(m.url)) return m.url
  const res = await call(cfg, '/media/presign', { method: 'POST', body: { filename: m.name.replace(/[^\w.-]+/g, '_').slice(0, 100) || 'datei', contentType: m.mime, size: m.data.byteLength } }, fetchImpl, 20_000)
  const put = str(res.data.uploadUrl)
  const pub = str(res.data.publicUrl)
  if (!put || !pub) throw new OutletError('Zernio: keine Upload-Adresse erhalten', 0, 'media')
  const up = await fetchImpl(put, { method: 'PUT', headers: { 'Content-Type': m.mime }, body: new Blob([m.data as unknown as ArrayBuffer], { type: m.mime }) })
  if (!up.ok) throw new OutletError(`Zernio: Upload fehlgeschlagen (${statusText(up.status)})`, up.status, 'media')
  return pub
}

function mediaType(mime: string): 'image' | 'video' | 'gif' | 'document' {
  if (mime === 'image/gif') return 'gif'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return 'document'
}

// TikTok verlangt bei jedem Beitrag tiktokSettings (docs.zernio.com/platforms/tiktok/fields): Sichtbarkeit aus den Stufen,
// die das Konto erlaubt (creator-info), Kommentare und bei Videos Duett/Stitch, dazu die beiden Pflicht-Bestätigungen. Der
// Mensch hat den Entwurf in Aimarage geprüft und freigegeben; Standard ist öffentlich mit allen Interaktionen, außer das
// Konto erlaubt sie nicht. Ist creator-info nicht lesbar, gilt dieser Standard ebenfalls.
export interface TiktokChoice { privacy: string, comment: boolean, duet: boolean, stitch: boolean }

export const TIKTOK_DEFAULT: TiktokChoice = { privacy: 'PUBLIC_TO_EVERYONE', comment: true, duet: true, stitch: true }

export function tiktokChoice(info: Json): TiktokChoice {
  const levels = (Array.isArray(info.privacyLevels) ? info.privacyLevels as unknown[] : [])
    .map(l => (typeof l === 'string' ? l : str((l as Json)?.value))).filter((v): v is string => !!v)
  const privacy = !levels.length || levels.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : levels[0]!
  const inter = (((info.postingLimits ?? {}) as Json).interactionSettings ?? {}) as Json
  const on = (k: string) => ((inter[k] ?? {}) as Json).enabled !== false
  return { privacy, comment: on('allow_comment'), duet: on('allow_duet'), stitch: on('allow_stitch') }
}

export function tiktokSettings(choice: TiktokChoice, opts: { photo: boolean, aiGenerated?: boolean, text: string }): Json {
  const s: Json = { privacy_level: choice.privacy, allow_comment: choice.comment, content_preview_confirmed: true, express_consent_given: true }
  if (opts.photo) {
    s.media_type = 'photo'
    s.photo_cover_index = 0
    s.description = [...opts.text].slice(0, 4000).join('')
  }
  else {
    s.allow_duet = choice.duet
    s.allow_stitch = choice.stitch
    if (opts.aiGenerated) s.video_made_with_ai = true
  }
  return s
}

async function creatorChoice(cfg: SocialConfig, accountId: string, photo: boolean, fetchImpl: FetchLike = fetch): Promise<TiktokChoice> {
  try {
    const res = await call(cfg, `/accounts/${encodeURIComponent(accountId)}/tiktok/creator-info?mediaType=${photo ? 'photo' : 'video'}`, { method: 'GET' }, fetchImpl, 20_000)
    return tiktokChoice(res.data)
  }
  catch (err) {
    console.error('[zernio] TikTok creator-info nicht lesbar:', (err as Error).message)
    return TIKTOK_DEFAULT
  }
}

// KI-Kennzeichnung: YouTube (containsSyntheticMedia) und TikTok (video_made_with_ai, nur Videos). Die Felder von Instagram
// (isAiGenerated) und X (madeWithAi) gelten laut Zernio nur für KI-erzeugte Bilder und Videos, nicht für KI-Text, und bleiben aus.
export function buildPost(req: PostRequest, mediaUrls: { url: string, mime: string }[], tiktok: TiktokChoice = TIKTOK_DEFAULT): Json {
  const video = mediaUrls.some(m => m.mime.startsWith('video/'))
  const platforms = req.platforms.map((p) => {
    const t = req.variants[p]?.trim() ? req.variants[p]! : req.text
    const entry: Json = { platform: toZernio(p), accountId: req.accounts?.[p] }
    if (t !== req.text) entry.customContent = t
    if (p === 'youtube') {
      const first = (req.variants.youtube || req.text).split('\n').find(l => l.trim())?.trim() ?? ''
      entry.platformSpecificData = { title: [...first].slice(0, 100).join(''), ...(req.aiGenerated ? { containsSyntheticMedia: true } : {}) }
    }
    if (p === 'tiktok') entry.platformSpecificData = { tiktokSettings: tiktokSettings(tiktok, { photo: !video && mediaUrls.length > 0, aiGenerated: req.aiGenerated, text: t }) }
    return entry
  })
  const body: Json = { content: req.text, platforms, publishNow: !req.at, metadata: { aimarage: req.externalId } }
  if (req.at) {
    body.scheduledFor = req.at.toISOString()
    body.timezone = req.timezone
  }
  if (mediaUrls.length) body.mediaItems = mediaUrls.map(m => ({ type: mediaType(m.mime), url: m.url }))
  return body
}

export function outcomeOf(data: Json): PostOutcome {
  const post = (data.post ?? data) as Json
  const requestId = str(post._id ?? post.id ?? data.postId)
  const plats = Array.isArray(post.platforms) ? post.platforms as Json[] : []
  const results: PostPlatformResult[] = plats.map((r) => {
    const st = str(r.status)
    const ok = st === 'published' ? true : st === 'failed' || st === 'cancelled' ? false : null
    return { platform: fromZernio(str(r.platform) ?? '?'), ok, url: str(r.platformPostUrl), postId: str(r.platformPostId), error: ok === false ? str(r.errorMessage) ?? 'fehlgeschlagen' : null }
  })
  const status = str(post.status)
  if (status === 'published' || status === 'partial') return { state: results.some(r => r.ok) ? 'done' : 'failed', requestId, results, error: null }
  if (status === 'failed' || status === 'cancelled') return { state: 'failed', requestId, results, error: str(data.error) ?? (results.map(r => r.error).filter(Boolean).join('; ') || 'fehlgeschlagen') }
  if (status === 'scheduled' && plats.every(r => str(r.status) === 'pending') && !data.platformResults) return { state: 'scheduled', requestId, results, error: null }
  return { state: 'pending', requestId, results, error: null }
}

// Fehler von Zernio im gehosteten Betrieb: Kunden sehen einen neutralen deutschen Text ohne den Namen des Dienstleisters
// (übersetzt in shared/utils/post-errors). Fehler, um die sich der Betreiber kümmern muss (z.B. fehlende Zahlungsart bei
// Zernio für X, abgelehnter Betreiber-Schlüssel) oder unbekannte, gehen zusätzlich in die Betriebsüberwachung.
export function classifyHostedError(raw: string, status = 0, code?: string | null): { key: PostErrorKey, ops: boolean } {
  const t = raw.toLowerCase()
  if (status === 402 || /payment method|pass-?through|billing|insufficient (credit|fund|balance)|credits?\b|upgrade your plan|plan limit|quota exceeded for (your|this) (plan|account)/.test(t)) return { key: 'unavailable', ops: true }
  if (status === 401 || /schlüssel abgelehnt|invalid api key|api key (is )?(invalid|missing)/.test(t)) return { key: 'unavailable', ops: true }
  if (code === 'no_key' || code === 'profile') return { key: 'unavailable', ops: true }
  if (status === 429 || /rate.?limit|too many requests|limit erreicht/.test(t)) return { key: 'busy', ops: false }
  if (code === 'network' || status >= 500 || /nicht erreichbar|timeout|timed out|unavailable|\beconn(refused|reset)\b|fetch failed/.test(t)) return { key: 'offline', ops: false }
  if (/duplicate|already (been )?posted|same content|identical/.test(t)) return { key: 'duplicate', ops: false }
  if (/token|expired|reconnect|re-?auth|revoked|disconnected|not connected|unauthori[sz]ed|permission|access denied/.test(t)) return { key: 'reconnect', ops: false }
  if (/too long|character|exceeds|max(imum)? length/.test(t)) return { key: 'tooLong', ops: false }
  if (/media|image|video|file|upload|aspect ratio|resolution/.test(t)) return { key: 'media', ops: false }
  if (/not found|nicht gefunden/.test(t) && status === 404) return { key: 'notFound', ops: false }
  return { key: 'rejected', ops: true }
}

function hostedText(cfg: SocialConfig, raw: string, platform: string | null, status = 0, code?: string | null): string {
  const { key, ops } = classifyHostedError(raw, status, code)
  if (ops) {
    reportError({ source: 'service', message: `Zernio${platform ? ` (${platform})` : ''}: ${raw}`.slice(0, 500), detail: { service: 'zernio', platform, status, code: code ?? null, profileId: cfg.profileId ?? null } })
      .catch(err => console.error('[zernio] Fehler nicht erfasst:', (err as Error).message))
  }
  return POST_ERROR[key].de
}

function hostedOutcome(cfg: SocialConfig, o: PostOutcome): PostOutcome {
  if (cfg.keySource !== 'hosted') return o
  const results = o.results.map(r => (r.ok === false && r.error ? { ...r, error: hostedText(cfg, r.error, r.platform) } : r))
  const error = o.error ? (results.find(r => r.error)?.error ?? hostedText(cfg, o.error, null)) : null
  return { ...o, results, error }
}

function hostedThrow(cfg: SocialConfig, err: unknown, platforms: string[]): never {
  if (cfg.keySource === 'hosted' && err instanceof OutletError) throw new OutletError(hostedText(cfg, err.message, platforms.join(', ') || null, err.status, err.code), err.status, err.code)
  throw err
}

export const zernioOutlet: SocialOutlet = {
  id: 'zernio',
  label: 'Zernio',
  async post(cfg, req, fetchImpl) {
    if (req.platforms.some(p => !req.accounts?.[p])) throw new OutletError(cfg.keySource === 'hosted' ? 'Konto nicht mehr verbunden' : 'Zernio: Konto für eine Plattform fehlt', 0, 'no_account')
    try {
      const media = []
      for (const m of req.media) media.push({ url: await uploadMedia(cfg, m, fetchImpl), mime: m.mime })
      const ttAccount = req.platforms.includes('tiktok') ? req.accounts?.tiktok : undefined
      const tiktok = ttAccount ? await creatorChoice(cfg, ttAccount, !media.some(m => m.mime.startsWith('video/')) && media.length > 0, fetchImpl) : TIKTOK_DEFAULT
      const res = await call(cfg, '/posts', { method: 'POST', body: buildPost(req, media, tiktok), headers: { 'Idempotency-Key': req.externalId } }, fetchImpl, 180_000)
      return hostedOutcome(cfg, outcomeOf(res.data))
    }
    catch (err) {
      hostedThrow(cfg, err, req.platforms)
    }
  },
  async status(cfg, requestId, fetchImpl) {
    try {
      const res = await call(cfg, `/posts/${encodeURIComponent(requestId)}`, { method: 'GET' }, fetchImpl, 20_000)
      return hostedOutcome(cfg, outcomeOf(res.data))
    }
    catch (err) {
      if (err instanceof OutletError && err.status === 404) return { state: 'failed', requestId, results: [], error: cfg.keySource === 'hosted' ? POST_ERROR.notFound.de : 'Beitrag bei Zernio nicht gefunden' }
      hostedThrow(cfg, err, [])
    }
  },
  async stats() {
    return []
  },
  async profileStats() {
    return {}
  },
}

registerOutlet(zernioOutlet)

// Kosten: Zernio rechnet je verbundenem Konto und Monat (taggenau). Gezählt wird täglich (Job storage_usage) in service_usage.
export async function recordZernioUsage(db: Db, day: string): Promise<number> {
  const wss = await db.select({ id: schema.workspaces.id, settings: schema.workspaces.settings }).from(schema.workspaces)
  let n = 0
  for (const ws of wss) {
    const pid = ws.settings?.social?.hosted?.profileId
    if (!pid) continue
    const units = (ws.settings?.social?.accounts ?? []).filter(a => a.profileId === pid).length
    await db.insert(schema.serviceUsage).values({ workspaceId: ws.id, day, service: 'zernio', units })
      .onConflictDoUpdate({ target: [schema.serviceUsage.workspaceId, schema.serviceUsage.day, schema.serviceUsage.service], set: { units } })
    n++
  }
  return n
}

export async function hostedAccountsOf(db: DbOrTx, workspaceId: string): Promise<SocialAccount[]> {
  const [ws] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))
  const pid = ws?.settings?.social?.hosted?.profileId
  return pid ? (ws?.settings?.social?.accounts ?? []).filter(a => a.profileId === pid) : []
}

// Nach dem Verbinden (Rückkehr aus Zernio oder Webhook account.connected): Konten abgleichen, Tarif-Grenze durchsetzen
// (überzählige neue Konten werden bei Zernio wieder getrennt, damit keine Kosten entstehen) und dem Projekt zuordnen.
export async function afterHostedConnect(db: Db, workspaceId: string, opts: { projectId?: string | null, platform?: string | null, fetchImpl?: FetchLike } = {}): Promise<{ added: SocialAccount[], assigned: SocialAccount | null, overLimit: boolean }> {
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))
  const cfg = ws ? hostedConfig(ws) : null
  if (!ws || !cfg?.profileId) return { added: [], assigned: null, overLimit: false }
  const { added } = await syncHostedAccounts(db, ws.id, cfg, opts.fetchImpl)
  const [fresh] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))
  const max = numLimit(fresh!, 'socialAccounts')
  let overLimit = false
  let keep = added
  if (max !== null && added.length) {
    const over = socialAccountsUsed(fresh!) - max
    if (over > 0) {
      overLimit = true
      const drop = added.slice(-over)
      for (const a of drop) await disconnectAccount(cfg, a.id, opts.fetchImpl).catch(err => console.error('[zernio] Trennen fehlgeschlagen:', (err as Error).message))
      keep = added.filter(a => !drop.includes(a))
      await syncHostedAccounts(db, ws.id, cfg, opts.fetchImpl)
    }
  }
  let assigned: SocialAccount | null = null
  if (opts.projectId) {
    const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, opts.projectId), eq(schema.projects.workspaceId, ws.id)))
    const pick = keep.find(a => !opts.platform || a.platform === opts.platform)
    const [cur] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))
    if (p && pick && cur && !platformTaken(cur, p.setup?.social, pick.platform, pick.id)) {
      const social = p.setup?.social ?? {}
      const ids = new Set(social.accountIds ?? [])
      ids.add(pick.id)
      await db.update(schema.projects).set({ setup: { ...p.setup, social: { ...social, accountIds: [...ids] } } }).where(eq(schema.projects.id, p.id))
      assigned = pick
    }
  }
  return { added: keep, assigned, overLimit }
}

// Aufräumen beim Löschen: Konten trennen und (beim Arbeitsbereich) das Profil löschen. Läuft mit dem Betreiber-Schlüssel,
// damit es auch nach dem Löschen des Workspace geht. Ein Fehler bei Zernio blockiert das Löschen nie: er wird protokolliert
// und als Job ohne Workspace (überlebt die Kaskade) später erneut versucht.
export interface ZernioCleanup {
  profileId?: string | null
  accountIds: string[]
}

export async function cleanupZernio(target: ZernioCleanup, apiKey = hostedZernioKey(), fetchImpl?: FetchLike): Promise<{ accounts: number, profile: boolean }> {
  const cfg = { apiKey }
  const ids = new Set(target.accountIds)
  if (target.profileId) {
    const res = await call(cfg, `/accounts?profileId=${encodeURIComponent(target.profileId)}`, { method: 'GET' }, fetchImpl, 20_000).catch((err) => {
      if (err instanceof OutletError && err.status === 404) return { status: 404, data: {} as Json }
      throw err
    })
    for (const a of parseAccounts('zernio', res.data)) if (a.profileId === target.profileId) ids.add(a.id)
  }
  for (const id of ids) await disconnectAccount(cfg as SocialConfig, id, fetchImpl)
  let profile = false
  if (target.profileId) {
    try {
      await call(cfg, `/profiles/${encodeURIComponent(target.profileId)}`, { method: 'DELETE' }, fetchImpl, 20_000)
      profile = true
    }
    catch (err) {
      if (!(err instanceof OutletError && err.status === 404)) throw err
    }
  }
  return { accounts: ids.size, profile }
}

// Was bei Zernio zum Arbeitsbereich gehört: das gehostete Profil und alle Konten darin.
export async function zernioCleanupOf(db: DbOrTx, workspaceId: string): Promise<ZernioCleanup> {
  const [ws] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))
  const social = ws?.settings?.social
  const profileId = social?.hosted?.profileId ?? null
  return { profileId, accountIds: profileId ? (social?.accounts ?? []).filter(a => a.profileId === profileId).map(a => a.id) : [] }
}

export async function cleanupZernioSafe(db: DbOrTx, target: ZernioCleanup, label: string, fetchImpl?: FetchLike): Promise<'done' | 'queued' | 'skipped'> {
  if (!target.profileId && !target.accountIds.length) return 'skipped'
  if (!hostedZernioKey()) return 'skipped'
  try {
    await cleanupZernio(target, undefined, fetchImpl)
    return 'done'
  }
  catch (err) {
    console.error(`[zernio] Aufräumen ${label} fehlgeschlagen, wird erneut versucht: ${(err as Error).message}`)
    await enqueueJob(db, 'zernio_cleanup', { workspaceId: null, payload: { profileId: target.profileId ?? null, accountIds: target.accountIds, label }, runAt: new Date(Date.now() + 10 * 60_000), maxAttempts: 8 })
      .catch(e => console.error(`[zernio] Wiederholung ${label} nicht eingereiht: ${(e as Error).message}`))
    return 'queued'
  }
}

// Gehostete Konten, die nach dem Löschen eines Projekts kein anderes Projekt mehr nutzt. Das Profil gehört dem Workspace und bleibt.
export function orphanedHostedAccounts(settings: SocialSettings | undefined, project: ProjectSocial | null | undefined, others: (ProjectSocial | null | undefined)[]): SocialAccount[] {
  const mine = projectAccounts(project, hostedAccounts(settings))
  return mine.filter(a => !others.some(o => projectAccounts(o, [a]).length))
}
