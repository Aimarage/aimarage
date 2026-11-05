import { and, desc, eq, gt, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import { DONE_STATUSES, OPEN_STATUSES } from '../../shared/utils/domain'
import { now } from './clock'
import type { DbOrTx } from './db'
import { schema } from './db'

type Project = typeof schema.projects.$inferSelect

// Bekannte Verzeichnisse, Listings und Launch-Seiten mit den Namen, unter denen sie in Titeln und Texten vorkommen.
export const DIRECTORY_SITES: { domain: string, label: string, names: string[] }[] = [
  { domain: 'alternativeto.net', label: 'AlternativeTo', names: ['alternativeto'] },
  { domain: 'saashub.com', label: 'SaaSHub', names: ['saashub'] },
  { domain: 'producthunt.com', label: 'Product Hunt', names: ['product hunt', 'producthunt'] },
  { domain: 'g2.com', label: 'G2', names: ['g2'] },
  { domain: 'capterra.com', label: 'Capterra', names: ['capterra'] },
  { domain: 'getapp.com', label: 'GetApp', names: ['getapp'] },
  { domain: 'theresanaiforthat.com', label: 'There\'s An AI For That', names: ['there\'s an ai for that', 'theresanaiforthat', 'taaft'] },
  { domain: 'futurepedia.io', label: 'Futurepedia', names: ['futurepedia'] },
  { domain: 'toolify.ai', label: 'Toolify', names: ['toolify'] },
  { domain: 'european-alternatives.eu', label: 'European Alternatives', names: ['european-alternatives', 'european alternatives'] },
  { domain: 'registry.modelcontextprotocol.io', label: 'MCP Registry', names: ['mcp registry', 'mcp-registry', 'mcp-registrierung'] },
  { domain: 'glama.ai', label: 'Glama', names: ['glama'] },
  { domain: 'mcp.so', label: 'mcp.so', names: ['mcp.so'] },
  { domain: 'pulsemcp.com', label: 'PulseMCP', names: ['pulsemcp', 'pulse mcp'] },
  { domain: 'smithery.ai', label: 'Smithery', names: ['smithery'] },
  { domain: 'mcpmarket.com', label: 'MCP Market', names: ['mcpmarket', 'mcp market'] },
  { domain: 'launchingnext.com', label: 'Launching Next', names: ['launching next', 'launchingnext'] },
  { domain: 'betalist.com', label: 'BetaList', names: ['betalist'] },
  { domain: 'startbase.de', label: 'Startbase', names: ['startbase'] },
  { domain: 'slant.co', label: 'Slant', names: ['slant.co'] },
  { domain: 'sourceforge.net', label: 'SourceForge', names: ['sourceforge'] },
  { domain: 'stackshare.io', label: 'StackShare', names: ['stackshare'] },
  { domain: 'uneed.best', label: 'Uneed', names: ['uneed'] },
  { domain: 'microlaunch.net', label: 'Microlaunch', names: ['microlaunch'] },
  { domain: 'submithub.com', label: 'SubmitHub', names: ['submithub'] },
  { domain: 'dailyplaylists.com', label: 'Daily Playlists', names: ['dailyplaylists', 'daily playlists'] },
  { domain: 'branchenverzeichnis.org', label: 'branchenverzeichnis.org', names: ['branchenverzeichnis.org'] },
]

const SOURCE_LABEL: Record<ListingSource, string> = { aufgabe: 'Aufgabe', bericht: 'Kanäle und Verzeichnisse:', beitrag: 'eigener Beitrag', website: 'eigene Website', unterlagen: 'Unterlagen', notiz: 'Notiz', besucher: 'Besucher von dort' }

export type ListingSource = 'aufgabe' | 'bericht' | 'beitrag' | 'website' | 'unterlagen' | 'notiz' | 'besucher'

export interface ListingEntry {
  domain: string
  label: string
  sources: { kind: ListingSource, ref: string }[]
}

const UPDATE = /aktualisier|update|aufwert|überarbeit|ueberarbeit|auffrisch|verbesser|ergänz|refresh|improve|bewertung|review/i
const NEGATED = /(^|[^\p{L}])(kein|keine|keinen|nicht|nie|noch nie|ohne|no|not|never|none)([^\p{L}]|$)/iu
const LISTED = /eingetragen|gelistet|steh(t|en)|aufgenommen|erledigt|vorhanden|eintrag|einträge|profil|listed|listing|entry|bewertung|review/i

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./i, '').toLowerCase()
  }
  catch {
    return null
  }
}

function siteOfHost(host: string): typeof DIRECTORY_SITES[number] | null {
  return DIRECTORY_SITES.find(s => host === s.domain || host.endsWith(`.${s.domain}`)) ?? null
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Verzeichnisse, die ein Text nennt (Domain oder Name), als Domains.
export function directoriesIn(text: string | null | undefined): string[] {
  if (!text) return []
  const t = text.toLowerCase()
  const out = new Set<string>()
  for (const s of DIRECTORY_SITES) {
    if (t.includes(s.domain) || s.names.some(n => new RegExp(`(^|[^a-z0-9])${escape(n)}([^a-z0-9]|$)`).test(t))) out.add(s.domain)
  }
  return [...out]
}

function urlsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)<>"']+/gi)].map(m => m[0])
}

// Verzeichnis-Domains einer Aufgabe: Ziel-Link, Ort und Titel; ein Ziel-Link auf ein unbekanntes Verzeichnis zählt mit.
export function taskDirectories(t: { title: string, channel?: string | null, targetUrl?: string | null, postedUrl?: string | null, description?: string | null }, ownHost: string | null = null, opts: { description?: boolean } = {}): string[] {
  const out = new Set<string>()
  for (const u of [t.targetUrl, t.postedUrl]) {
    const h = hostOf(u)
    if (!h || h === ownHost || (ownHost && h.endsWith(`.${ownHost}`))) continue
    out.add(siteOfHost(h)?.domain ?? h)
  }
  for (const d of directoriesIn(`${t.title}\n${t.channel ?? ''}${opts.description ? `\n${t.description ?? ''}` : ''}`)) out.add(d)
  return [...out]
}

export function isListingUpdate(title: string): boolean {
  return UPDATE.test(title)
}

function labelOf(domain: string): string {
  return DIRECTORY_SITES.find(s => s.domain === domain)?.label ?? domain
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\n+/).map(s => s.trim()).filter(Boolean)
}

// Register "wo stehen wir schon" je Projekt: erledigte oder freigegebene Verzeichnis-Aufgaben, eigene Beiträge mit Link auf den Eintrag,
// Links auf der eigenen Website, Unterlagen und Notizen (ohne Verneinung) und Besucher, die von dort kommen.
export async function listingRegister(db: DbOrTx, project: Pick<Project, 'id' | 'url' | 'name' | 'slug'>): Promise<ListingEntry[]> {
  const own = hostOf(project.url)
  const byDomain = new Map<string, ListingEntry>()
  const add = (domain: string, kind: ListingSource, ref: string) => {
    let e = byDomain.get(domain)
    if (!e) {
      e = { domain, label: labelOf(domain), sources: [] }
      byDomain.set(domain, e)
    }
    if (!e.sources.some(s => s.kind === kind && s.ref === ref)) e.sources.push({ kind, ref })
  }

  const listed = await db.select({ id: schema.tasks.id, code: schema.tasks.code, title: schema.tasks.title, channel: schema.tasks.channel, targetUrl: schema.tasks.targetUrl, postedUrl: schema.tasks.postedUrl, status: schema.tasks.status })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, project.id), inArray(schema.tasks.category, ['verzeichnis', 'launch']), inArray(schema.tasks.status, [...DONE_STATUSES, 'wartet'])))
    .limit(300)
  for (const t of listed) for (const d of taskDirectories(t, own)) add(d, 'aufgabe', `${t.code} ${t.status}`)

  const links = await db.select({ url: schema.taskLinks.url, code: schema.tasks.code }).from(schema.taskLinks).innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskLinks.taskId))
    .where(and(eq(schema.tasks.projectId, project.id), eq(schema.tasks.category, 'verzeichnis'))).limit(300)
  for (const l of links) {
    const h = hostOf(l.url)
    if (h && h !== own) add(siteOfHost(h)?.domain ?? h, 'aufgabe', l.code)
  }

  const tracked = await db.select({ name: schema.channels.name, url: schema.channels.url, status: schema.channels.status }).from(schema.channels)
    .where(and(eq(schema.channels.projectId, project.id), inArray(schema.channels.status, ['eingereicht', 'live']))).limit(200)
  for (const c of tracked) {
    const h = hostOf(c.url)
    const domains = h && h !== own ? [siteOfHost(h)?.domain ?? h] : directoriesIn(c.name)
    for (const d of domains) add(d, 'bericht', c.status)
  }

  const nameRe = new RegExp(`${escape(project.slug.toLowerCase())}|${escape(project.name.toLowerCase().replace(/\s+/g, '-'))}`)
  const posts = await db.select({ body: schema.drafts.body, code: schema.tasks.code }).from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.tasks.projectId, project.id), eq(schema.drafts.status, 'freigegeben'), inArray(schema.tasks.status, [...DONE_STATUSES, 'wartet', 'freigegeben']), ne(schema.tasks.category, 'verzeichnis')))
    .orderBy(desc(schema.drafts.createdAt)).limit(300)
  for (const p of posts) {
    for (const u of urlsIn(p.body)) {
      const h = hostOf(u)
      const site = h ? siteOfHost(h) : null
      if (site && nameRe.test(u.toLowerCase())) add(site.domain, 'beitrag', `${p.code}: ${u.replace(/\?.*$/, '')}`)
    }
  }

  const pages = await db.select({ url: schema.projectPages.url, text: schema.projectPages.text }).from(schema.projectPages).where(eq(schema.projectPages.projectId, project.id)).limit(200)
  for (const p of pages) {
    const t = p.text.toLowerCase()
    for (const s of DIRECTORY_SITES) if (t.includes(s.domain)) add(s.domain, 'website', p.url)
  }

  const textual = async (kind: 'unterlagen' | 'notiz', rows: { ref: string, text: string }[]) => {
    for (const r of rows) {
      for (const s of sentences(r.text)) {
        if (NEGATED.test(s) || !LISTED.test(s)) continue
        for (const d of directoriesIn(s)) add(d, kind, r.ref)
      }
    }
  }
  const docs = await db.select({ name: schema.projectDocuments.name, text: schema.projectDocuments.text }).from(schema.projectDocuments).where(eq(schema.projectDocuments.projectId, project.id)).limit(50)
  await textual('unterlagen', docs.map(d => ({ ref: d.name, text: d.text.slice(0, 200_000) })))
  const memory = await db.select({ text: schema.projectMemory.text }).from(schema.projectMemory).where(eq(schema.projectMemory.projectId, project.id)).limit(300)
  await textual('notiz', memory.map(m => ({ ref: m.text.slice(0, 80), text: m.text })))

  const visits = await db.select({ source: schema.utmStats.source, n: sql<number>`sum(${schema.utmStats.visits})::int` }).from(schema.utmStats)
    .where(and(eq(schema.utmStats.projectId, project.id), gt(schema.utmStats.visits, 0))).groupBy(schema.utmStats.source).limit(500)
  for (const v of visits) {
    const src = v.source.toLowerCase()
    for (const s of DIRECTORY_SITES) {
      const dashed = s.domain.replace(/\./g, '-')
      const root = s.domain.split('.')[0]!
      if (src === s.domain || src === dashed || src.endsWith(`.${s.domain}`) || src.endsWith(`-${dashed}`) || (root.length >= 6 && src === root) || s.names.some(n => src === n.replace(/\s+/g, '-'))) add(s.domain, 'besucher', `${v.source} (${v.n})`)
    }
  }
  return [...byDomain.values()].sort((a, b) => a.label.localeCompare(b.label))
}

export function listingDigest(entries: ListingEntry[], name: string): string {
  if (!entries.length) return ''
  const lines = entries.map(e => `- ${e.label} (${e.domain}): ${e.sources.slice(0, 3).map(s => `${SOURCE_LABEL[s.kind]} ${s.ref}`).join('; ')}`)
  return `Hier steht ${name} schon (Register "wo stehen wir schon"). Diese Verzeichnisse nie erneut als Eintrag planen oder vorschlagen und nie behaupten, es gebe dort noch keinen Eintrag; nur eine ausdrücklich gewünschte Aktualisierung des bestehenden Eintrags ist erlaubt:\n${lines.join('\n')}`
}

export interface ListingConflict {
  domain: string
  label: string
  reason: string
}

// Verzeichnis-Aufgabe, die gegen das Register oder eine andere offene Aufgabe für dieselbe Domain verstößt (Aktualisierungen ausgenommen, höchstens eine offene je Domain).
export async function listingConflict(db: DbOrTx, project: Pick<Project, 'id' | 'url' | 'name' | 'slug'>, task: { id?: string, title: string, channel?: string | null, targetUrl?: string | null, description?: string | null, dueDate?: string | null, createdAt?: Date | null }, opts: { register?: ListingEntry[], open?: OpenListing[] } = {}): Promise<ListingConflict | null> {
  const own = hostOf(project.url)
  const domains = taskDirectories(task, own)
  if (!domains.length) return null
  const update = isListingUpdate(task.title)
  const register = opts.register ?? await listingRegister(db, project)
  if (!update) {
    for (const d of domains) {
      const e = register.find(r => r.domain === d)
      if (e) return { domain: d, label: e.label, reason: `${project.name} steht schon auf ${e.label} (${e.sources.slice(0, 2).map(s => `${SOURCE_LABEL[s.kind]} ${s.ref}`).join('; ')}). Kein zweiter Eintrag in demselben Verzeichnis.` }
    }
  }
  const open = opts.open ?? await openListings(db, project)
  for (const d of domains) {
    const other = open.find(o => o.id !== task.id && o.update === update && o.domains.includes(d) && earlier(o, task))
    if (other) return { domain: d, label: labelOf(d), reason: `Für ${labelOf(d)} gibt es schon die offene Aufgabe ${other.code}. Je Verzeichnis höchstens eine Aufgabe.` }
  }
  return null
}

export interface OpenListing {
  id: string
  code: string
  title: string
  update: boolean
  domains: string[]
  dueDate: string | null
  createdAt: Date
}

function earlier(o: OpenListing, t: { dueDate?: string | null, createdAt?: Date | null }): boolean {
  if (!t.dueDate) return true
  const a = o.dueDate ?? '9999'
  const b = t.dueDate ?? '9999'
  if (a !== b) return a < b
  return !t.createdAt || o.createdAt.getTime() <= t.createdAt.getTime()
}

export async function openListings(db: DbOrTx, project: Pick<Project, 'id' | 'url'>): Promise<OpenListing[]> {
  const own = hostOf(project.url)
  const rows = await db.select({ id: schema.tasks.id, code: schema.tasks.code, title: schema.tasks.title, channel: schema.tasks.channel, targetUrl: schema.tasks.targetUrl, dueDate: schema.tasks.dueDate, createdAt: schema.tasks.createdAt })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, project.id), eq(schema.tasks.category, 'verzeichnis'), inArray(schema.tasks.status, OPEN_STATUSES)))
    .limit(300)
  return rows.map(r => ({ id: r.id, code: r.code, title: r.title, update: isListingUpdate(r.title), domains: taskDirectories(r, own), dueDate: r.dueDate, createdAt: r.createdAt }))
}

// Was der Agent im Projekt schon gemacht hat (alle Arten, nicht nur der Kanal): erledigte und freigegebene Aufgaben der letzten Monate.
export async function doneDigest(db: DbOrTx, projectId: string, opts: { days?: number, limit?: number } = {}): Promise<string> {
  const since = new Date(now().getTime() - (opts.days ?? 180) * 86_400_000)
  const rows = await db.select({ code: schema.tasks.code, title: schema.tasks.title, category: schema.tasks.category, status: schema.tasks.status, at: schema.tasks.doneAt, due: schema.tasks.dueDate, posted: schema.tasks.postedUrl, target: schema.tasks.targetUrl })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, projectId), inArray(schema.tasks.status, [...DONE_STATUSES, 'wartet']), isNotNull(schema.tasks.doneAt), gt(schema.tasks.doneAt, since), ne(schema.tasks.category, 'bericht'), sql`coalesce(${schema.tasks.origin}, '') not like 'setup:%'`))
    .orderBy(desc(schema.tasks.doneAt)).limit(opts.limit ?? 60)
  if (!rows.length) return ''
  return `Schon erledigt (letzte ${opts.days ?? 180} Tage, nicht wiederholen, Themen und Orte abwechseln):\n${rows.map(r => `- ${r.at!.toISOString().slice(0, 10)} ${r.code} [${r.category}] ${r.title}${r.posted || r.target ? ` (${hostOf(r.posted ?? r.target) ?? ''})` : ''}`).join('\n')}`
}
