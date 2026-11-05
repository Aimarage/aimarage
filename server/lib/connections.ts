import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { WorkspaceSettings } from '../db/schema'
import type { Db } from './db'
import { schema } from './db'
import { keyHint } from './llm'
import { platformTaken } from './limits'
import type { FetchLike } from './outlets'
import { decryptSecret, encryptSecret } from './secret'
import { blueskyAdapter, bskySession } from './platforms/bluesky'
import { linkedinAdapter, verifyLinkedin } from './platforms/linkedin'
import { mastodonAdapter, verifyMastodon } from './platforms/mastodon'
import { instagramAdapter, verifyInstagram } from './platforms/instagram'
import { metaAdapter, verifyMeta } from './platforms/meta'
import { threadsAdapter } from './platforms/threads'
import { telegramAdapter, verifyTelegram } from './platforms/telegram'
import { tiktokAdapter } from './platforms/tiktok'
import { xAdapter, xMe } from './platforms/x'
import { verifyYoutube, youtubeAdapter, youtubeOptions } from './platforms/youtube'
import { callJson, cleanError, PlatformError } from './platforms/types'
import { isTransient } from '../../shared/utils/access'
import { appOf, authorizeUrl, defaultRedirect, exchangeCode, newState, newVerifier, usesPkce, type OAuthProvider } from './platforms/oauth'
import type { AdapterCtx, Creds, OAuthApp, OwnProvider, PlatformAdapter, SocialConn, StoredSecret } from './platforms/types'

type Workspace = { id: string, settings: WorkspaceSettings | null }

const adapters = new Map<OwnProvider, PlatformAdapter>()

export function registerAdapter(a: PlatformAdapter): void {
  adapters.set(a.provider, a)
}

export function adapterFor(provider: string): PlatformAdapter | null {
  return adapters.get(provider as OwnProvider) ?? null
}

for (const a of [blueskyAdapter, mastodonAdapter, metaAdapter, instagramAdapter, threadsAdapter, linkedinAdapter, xAdapter, tiktokAdapter, telegramAdapter, youtubeAdapter]) registerAdapter(a)

export const OWN_PROVIDERS: { id: OwnProvider, label: string, platforms: string[], kind: 'password' | 'token' | 'oauth' }[] = [
  { id: 'meta', label: 'Meta (Instagram, Facebook)', platforms: ['instagram', 'facebook'], kind: 'oauth' },
  { id: 'instagram', label: 'Instagram (ohne Facebook)', platforms: ['instagram'], kind: 'oauth' },
  { id: 'youtube', label: 'YouTube', platforms: ['youtube'], kind: 'oauth' },
  { id: 'tiktok', label: 'TikTok', platforms: ['tiktok'], kind: 'oauth' },
  { id: 'telegram', label: 'Telegram', platforms: ['telegram'], kind: 'token' },
  { id: 'x', label: 'X', platforms: ['x'], kind: 'oauth' },
  { id: 'threads', label: 'Threads', platforms: ['threads'], kind: 'oauth' },
  { id: 'linkedin', label: 'LinkedIn', platforms: ['linkedin'], kind: 'oauth' },
  { id: 'bluesky', label: 'Bluesky', platforms: ['bluesky'], kind: 'password' },
  { id: 'mastodon', label: 'Mastodon', platforms: ['mastodon'], kind: 'token' },
]

function connContext(workspaceId: string, id: string): string {
  return `conn|${workspaceId}|${id}`
}

function appContext(workspaceId: string, provider: string): string {
  return `app|${workspaceId}|${provider}`
}

export function sealCreds(workspaceId: string, id: string, creds: Creds, at = new Date()): StoredSecret {
  const plain = JSON.stringify(creds)
  const main = creds.password ?? creds.token ?? creds.accessToken ?? creds.access_token ?? Object.values(creds)[0] ?? ''
  return { enc: encryptSecret(plain, connContext(workspaceId, id)), hint: keyHint(main), setAt: at.toISOString() }
}

export function openCreds(workspaceId: string, conn: Pick<SocialConn, 'id' | 'secret'>): Creds | null {
  const plain = decryptSecret(conn.secret.enc, connContext(workspaceId, conn.id))
  if (!plain) return null
  try {
    return JSON.parse(plain) as Creds
  }
  catch {
    return null
  }
}

export function sealAppSecret(workspaceId: string, provider: string, secret: string, at = new Date()): StoredSecret {
  return { enc: encryptSecret(secret, appContext(workspaceId, provider)), hint: keyHint(secret), setAt: at.toISOString() }
}

export function isLocalUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '0.0.0.0'
  }
  catch {
    return false
  }
}

// Gespeicherte Weiterleitungs-Adresse, außer sie zeigt auf localhost und die App läuft öffentlich (z.B. nach Datenübernahme lokal -> live).
export function redirectFor(stored: string | null | undefined, fallback: string): string {
  if (!stored) return fallback
  return isLocalUrl(stored) && !isLocalUrl(fallback) ? fallback : stored
}

export function openApp(ws: Workspace, provider: string, defaultRedirect: string): { clientId: string, clientSecret: string, redirectUri: string } | null {
  const app = ws.settings?.apps?.[provider]
  if (!app?.clientId || !app.secret) return null
  const clientSecret = decryptSecret(app.secret.enc, appContext(ws.id, provider))
  if (!clientSecret) return null
  return { clientId: app.clientId, clientSecret, redirectUri: redirectFor(app.redirectUri, defaultRedirect) }
}

export function sealAppApiKey(workspaceId: string, provider: string, key: string, at = new Date()): StoredSecret {
  return sealAppSecret(workspaceId, `${provider}-key`, key, at)
}

export function openAppApiKey(ws: Workspace, provider: string): string | null {
  const app = ws.settings?.apps?.[provider]
  return app?.key ? decryptSecret(app.key.enc, appContext(ws.id, `${provider}-key`)) || null : null
}

export function openAppKey(ws: Workspace, provider: string): string | null {
  const app = ws.settings?.apps?.[provider]
  return app?.secret ? decryptSecret(app.secret.enc, appContext(ws.id, provider)) || null : null
}

export function listConnections(ws: Workspace): SocialConn[] {
  return ws.settings?.connections ?? []
}

export function newConnId(): string {
  return randomUUID()
}

export async function updateSettings(db: Db, workspaceId: string, fn: (s: WorkspaceSettings) => WorkspaceSettings): Promise<WorkspaceSettings> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).for('update')
    const next = fn({ ...(cur?.settings ?? {}) })
    await tx.update(schema.workspaces).set({ settings: next }).where(eq(schema.workspaces.id, workspaceId))
    return next
  })
}

export async function upsertConnection(db: Db, workspaceId: string, conn: Omit<SocialConn, 'id' | 'secret'> & { id?: string }, creds: Creds, opts: { projectId?: string | null } = {}): Promise<SocialConn> {
  let saved: SocialConn | null = null
  await updateSettings(db, workspaceId, (s) => {
    const list = [...(s.connections ?? [])]
    const same = list.findIndex(c => c.id === conn.id || (c.provider === conn.provider && c.platform === conn.platform && (c.handle ?? c.name) === (conn.handle ?? conn.name)))
    const id = same >= 0 ? list[same]!.id : conn.id ?? newConnId()
    saved = { ...conn, id, secret: sealCreds(workspaceId, id, creds), checkedAt: new Date().toISOString(), error: null }
    if (same >= 0) list[same] = saved
    else list.push(saved)
    return { ...s, connections: list }
  })
  if (opts.projectId) {
    const [p] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(eq(schema.projects.id, opts.projectId))
    const [ws] = await db.select({ limits: schema.workspaces.limits, settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))
    if (p && !(ws && platformTaken(ws, p.setup?.social, saved!.platform, saved!.id))) {
      const social = p.setup?.social ?? {}
      const ids = new Set(social.accountIds ?? [])
      ids.add(saved!.id)
      await db.update(schema.projects).set({ setup: { ...p.setup, social: { ...social, accountIds: [...ids] } } }).where(eq(schema.projects.id, opts.projectId))
    }
  }
  return saved!
}

export async function removeConnection(db: Db, workspaceId: string, id: string): Promise<boolean> {
  let found = false
  await updateSettings(db, workspaceId, (s) => {
    const list = (s.connections ?? []).filter((c) => {
      if (c.id === id) found = true
      return c.id !== id
    })
    return { ...s, connections: list }
  })
  return found
}

export async function markConnection(db: Db, workspaceId: string, id: string, patch: Partial<Pick<SocialConn, 'error' | 'checkedAt' | 'expiresAt' | 'name'>>): Promise<void> {
  await updateSettings(db, workspaceId, s => ({ ...s, connections: (s.connections ?? []).map(c => (c.id === id ? { ...c, ...patch } : c)) }))
}

export function adapterCtx(db: Db, ws: Workspace, conn: SocialConn, fetchImpl: FetchLike = fetch): AdapterCtx {
  return {
    fetch: fetchImpl,
    app: openApp(ws, appOf(conn.provider), ''),
    saveCreds: async (c, expiresAt) => {
      await updateSettings(db, ws.id, s => ({ ...s, connections: (s.connections ?? []).map(x => (x.id === conn.id ? { ...x, secret: sealCreds(ws.id, x.id, c), ...(expiresAt !== undefined ? { expiresAt } : {}) } : x)) }))
    },
  }
}

export function publicConnections(ws: Workspace) {
  return listConnections(ws).map(c => ({ id: c.id, provider: c.provider, platform: c.platform, name: c.name, handle: c.handle ?? null, url: c.url ?? null, hint: c.secret.hint, setAt: c.secret.setAt, expiresAt: c.expiresAt ?? null, checkedAt: c.checkedAt ?? null, error: c.error ?? null, readable: !!openCreds(ws.id, c), options: c.provider === 'youtube' ? youtubeOptions(c) : null }))
}

export const APP_PROVIDERS = ['meta', 'instagram', 'threads', 'linkedin', 'tiktok', 'x', 'reddit', 'brave', 'google', 'bing'] as const

export function publicApps(ws: Workspace, defaults: Record<string, string>) {
  const apps = ws.settings?.apps ?? {}
  return Object.fromEntries(APP_PROVIDERS.map(p => [p, { clientId: apps[p]?.clientId ?? '', hasSecret: !!apps[p]?.secret, hint: apps[p]?.secret?.hint ?? null, redirectUri: redirectFor(apps[p]?.redirectUri, defaults[p] || ''), ...(apps[p]?.redirectUri && redirectFor(apps[p]?.redirectUri, defaults[p] || '') !== apps[p]?.redirectUri ? { redirectIgnored: apps[p]?.redirectUri } : {}), user: apps[p]?.user ?? '', hasKey: !!apps[p]?.key, keyHint: apps[p]?.key?.hint ?? null }]))
}

export type { OAuthApp }

export async function checkConnection(db: Db, ws: Workspace, id: string, fetchImpl: FetchLike = fetch): Promise<{ ok: true, name: string } | { ok: false, error: string }> {
  const conn = listConnections(ws).find(c => c.id === id)
  if (!conn) return { ok: false, error: 'Verbindung nicht gefunden' }
  const creds = openCreds(ws.id, conn)
  if (!creds) return { ok: false, error: 'Zugangsdaten unlesbar (Hauptschlüssel geändert?), bitte neu verbinden' }
  const at = new Date().toISOString()
  try {
    let name = conn.name
    if (conn.provider === 'bluesky') name = `@${(await bskySession((conn.url || 'https://bsky.social').replace(/\/+$/, ''), creds.identifier!, creds.password!, fetchImpl)).handle}`
    else if (conn.provider === 'mastodon') name = (await verifyMastodon({ url: conn.url!, token: creds.token! }, fetchImpl)).conn.name
    else if (conn.provider === 'meta') name = await verifyMeta(conn, creds, fetchImpl)
    else if (conn.provider === 'instagram') {
      if (conn.expiresAt && Date.parse(conn.expiresAt) < Date.now()) throw new Error('Instagram: Zugang abgelaufen (60 Tage), bitte neu verbinden')
      name = await verifyInstagram(creds, fetchImpl)
    }
    else if (conn.provider === 'threads') name = `@${String((await callJson(fetchImpl, 'Threads', `https://graph.threads.net/v1.0/me?fields=username&access_token=${encodeURIComponent(creds.accessToken!)}`)).username)}`
    else if (conn.provider === 'linkedin') {
      if (conn.expiresAt && Date.parse(conn.expiresAt) < Date.now()) throw new Error('LinkedIn: Zugang abgelaufen (60 Tage), bitte neu verbinden')
      name = await verifyLinkedin(creds, fetchImpl)
    }
    else if (conn.provider === 'x') name = `@${String((await xMe(creds, adapterCtx(db, ws, conn, fetchImpl))).username)}`
    else if (conn.provider === 'tiktok') {
      const f = await tiktokAdapter.followers!(conn, creds, adapterCtx(db, ws, conn, fetchImpl))
      if (f === null) throw new Error('TikTok: Profil nicht lesbar')
    }
    else if (conn.provider === 'youtube') name = await verifyYoutube(creds, adapterCtx(db, ws, conn, fetchImpl))
    else if (conn.provider === 'telegram') name = (await verifyTelegram({ token: creds.token!, chat: conn.ext?.chatId ?? `@${conn.handle}` }, fetchImpl)).conn.name
    await markConnection(db, ws.id, id, { error: null, checkedAt: at })
    return { ok: true, name }
  }
  catch (err) {
    const error = await noteConnError(db, ws.id, conn, (err as Error).message, at)
    return { ok: false, error }
  }
}

// Fehler einer Verbindung speichern: ohne HTML; eine vorübergehende Störung (5xx, 429, Netz) überschreibt keinen echten Zugangsfehler.
export async function noteConnError(db: Db, workspaceId: string, conn: Pick<SocialConn, 'id' | 'error'>, message: string, at = new Date().toISOString()): Promise<string> {
  const error = cleanError(message).slice(0, 400)
  if (isTransient(error) && conn.error && !isTransient(conn.error)) await markConnection(db, workspaceId, conn.id, { checkedAt: at })
  else await markConnection(db, workspaceId, conn.id, { error, checkedAt: at })
  return error
}

// Verbindungen mit vorübergehender Störung leicht prüfen (z.B. verify_credentials): klappt es, ist der Fehler weg.
export async function recheckTransient(db: Db, ws: Workspace, fetchImpl: FetchLike = fetch): Promise<{ cleared: string[], still: string[] }> {
  const cleared: string[] = []
  const still: string[] = []
  for (const conn of listConnections(ws)) {
    if (!conn.error || !isTransient(conn.error)) continue
    const r = await checkConnection(db, ws, conn.id, fetchImpl)
    if (r.ok) cleared.push(conn.name)
    else still.push(`${conn.name}: ${r.error}`)
  }
  return { cleared, still }
}

export function hasTransientConn(ws: Workspace): boolean {
  return listConnections(ws).some(c => !!c.error && isTransient(c.error))
}

// Einmalig: gespeicherte Fehler mit HTML-Seite oder 5xx in Klartext umschreiben.
export function cleanConnErrors(settings: WorkspaceSettings): WorkspaceSettings | null {
  const conns = settings.connections ?? []
  if (!conns.some(c => c.error && cleanError(c.error) !== c.error)) return null
  return { ...settings, connections: conns.map(c => (c.error && cleanError(c.error) !== c.error ? { ...c, error: cleanError(c.error).slice(0, 400) } : c)) }
}

export async function startOAuth(db: Db, ws: Workspace, provider: OAuthProvider, projectId: string | null, appUrl: string): Promise<string> {
  const app = openApp(ws, appOf(provider), defaultRedirect(appUrl, provider))
  if (!app) throw new PlatformError(provider === 'youtube' ? 'Google-Zugang fehlt: Client-ID und Clientschlüssel unter Einstellungen > Plattform-Zugänge bei Google eintragen' : 'App-ID und App-Geheimnis fehlen (Schritt 1 der Anleitung)')
  const state = newState()
  const verifier = usesPkce(provider) ? newVerifier() : undefined
  await updateSettings(db, ws.id, s => ({ ...s, oauthStates: [...(s.oauthStates ?? []).filter(x => Date.now() - Date.parse(x.at) < 3_600_000).slice(-9), { state, provider, projectId, ...(verifier ? { verifier } : {}), at: new Date().toISOString() }] }))
  return authorizeUrl(provider, app, state, verifier)
}

export async function finishOAuth(db: Db, ws: Workspace, provider: OAuthProvider, code: string, state: string | null, appUrl: string, fetchImpl: FetchLike = fetch): Promise<SocialConn[]> {
  const pending = ws.settings?.oauthStates ?? []
  const match = state ? pending.find(x => x.state === state && x.provider === provider) : [...pending].reverse().find(x => x.provider === provider)
  if (state && !match) throw new PlatformError('Anmeldung abgelaufen oder aus einem anderen Fenster, bitte "Verbinden" erneut klicken')
  const app = openApp(ws, appOf(provider), defaultRedirect(appUrl, provider))
  if (!app) throw new PlatformError('App-ID und App-Geheimnis fehlen')
  const found = await exchangeCode(provider, app, code, fetchImpl, match?.verifier)
  const out: SocialConn[] = []
  for (const f of found) out.push(await upsertConnection(db, ws.id, f.conn, f.creds, { projectId: match?.projectId ?? null }))
  await updateSettings(db, ws.id, s => ({ ...s, oauthStates: (s.oauthStates ?? []).filter(x => x.state !== match?.state) }))
  return out
}

export async function refreshTokens(db: Db, ws: Workspace, fetchImpl: FetchLike = fetch): Promise<{ refreshed: string[], errors: string[] }> {
  const refreshed: string[] = []
  const errors: string[] = []
  for (const conn of listConnections(ws)) {
    const adapter = adapterFor(conn.provider)
    if (!adapter?.refresh) continue
    const exp = Date.parse(conn.expiresAt ?? '')
    if (Number.isFinite(exp) && exp < Date.now()) {
      if (!conn.error) await markConnection(db, ws.id, conn.id, { error: `${adapter.label}: Zugang abgelaufen, bitte neu verbinden`, checkedAt: new Date().toISOString() })
      continue
    }
    const creds = openCreds(ws.id, conn)
    if (!creds) continue
    try {
      if (await adapter.refresh(conn, creds, adapterCtx(db, ws, conn, fetchImpl))) {
        refreshed.push(conn.name)
        if (conn.error) await markConnection(db, ws.id, conn.id, { error: null, checkedAt: new Date().toISOString() })
      }
    }
    catch (err) {
      errors.push(`${conn.name}: ${await noteConnError(db, ws.id, conn, (err as Error).message)}`)
    }
  }
  return { refreshed, errors }
}

// Einmalig nach Datenübernahme: gespeicherte localhost-Weiterleitungen entfernen, wenn die App öffentlich läuft.
export function dropLocalRedirects(settings: WorkspaceSettings, appUrl: string): WorkspaceSettings | null {
  if (isLocalUrl(appUrl)) return null
  const apps = settings.apps ?? {}
  const bad = Object.keys(apps).filter(k => isLocalUrl(apps[k]?.redirectUri))
  if (!bad.length) return null
  return { ...settings, apps: Object.fromEntries(Object.entries(apps).map(([k, a]) => [k, bad.includes(k) ? { ...a, redirectUri: null } : a])) as typeof apps }
}
