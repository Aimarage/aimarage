import { and, eq, gt, ilike, inArray, isNull, like, ne, or, sql } from 'drizzle-orm'
import { CATEGORY_CODES, DONE_STATUSES, OPEN_STATUSES } from '../../shared/utils/domain'
import { platformOf } from '../../shared/utils/drafting'
import { platformRule } from '../../shared/utils/social'
import { isOwnBlog, taskWhere } from '../../shared/utils/where'
import { blockedPlatforms } from '../../shared/utils/blocked-platforms'
import type { StrategyChannel } from '../db/schema'
import type { DbOrTx } from './db'
import { schema } from './db'
import { now } from './clock'
import { socialTarget } from './publish'
import { createTask, nextTaskCode, updateTask, websiteOrder } from './tasks'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

export interface PlanGuard {
  blog: string | null
  accounts: string[]
  excluded: string[]
}

export type PlanBlock = { kind: 'blog' } | { kind: 'reddit' } | { kind: 'account', platform: string | null }

const PLATFORM_WORDS: Record<string, string> = {
  x: 'x', twitter: 'x', linkedin: 'linkedin', instagram: 'instagram', insta: 'instagram', facebook: 'facebook', fb: 'facebook',
  bluesky: 'bluesky', bsky: 'bluesky', mastodon: 'mastodon', threads: 'threads', tiktok: 'tiktok', youtube: 'youtube', pinterest: 'pinterest', reddit: 'reddit', telegram: 'telegram',
}
const NEGATION = /(?:^|[^\p{L}])(?:kein(?:e|en|er|em)?|no|not on|nicht auf|nicht bei|ohne|never on|nie auf)\s+(?:eigene[nsr]?\s+)?(?:(?:konto|account|profil|präsenz|kanal)\s+(?:auf|bei|on|für)\s+)?([\p{L}][\p{L}\d.]{0,20})/giu

export function excludedPlatforms(texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>()
  for (const t of texts) {
    if (!t) continue
    for (const m of t.matchAll(NEGATION)) {
      const word = m[1]!.split(/[-.]/)[0]!.toLowerCase()
      const p = PLATFORM_WORDS[word]
      if (p) out.add(p)
    }
  }
  return [...out]
}

export async function projectMemoryTexts(db: DbOrTx, projectId: string): Promise<string[]> {
  return (await db.select({ text: schema.projectMemory.text }).from(schema.projectMemory).where(eq(schema.projectMemory.projectId, projectId)).limit(200)).map(m => m.text)
}

export function factTexts(project: Pick<Project, 'setup'>, memory: string[] = []): string[] {
  return [...(project.setup?.facts?.known ?? []), ...(project.setup?.facts?.avoid ?? []), ...memory]
}

export function guardExcluded(project: Pick<Project, 'setup'>, memory: string[] = []): string[] {
  return [...new Set([...blockedPlatforms(project), ...excludedPlatforms(factTexts(project, memory))])]
}

export function planGuard(ws: Workspace, project: Pick<Project, 'setup'>, memory: string[] = []): PlanGuard {
  return { blog: project.setup?.blog ?? null, accounts: socialTarget(ws, project)?.platforms.map(p => p.platform) ?? [], excluded: guardExcluded(project, memory) }
}

export async function loadPlanGuard(db: DbOrTx, project: Project): Promise<PlanGuard> {
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, project.workspaceId))
  const memory = await projectMemoryTexts(db, project.id)
  return ws ? planGuard(ws, project, memory) : { blog: project.setup?.blog ?? null, accounts: [], excluded: guardExcluded(project, memory) }
}

export function mentionedPlatforms(text: string): string[] {
  const out = new Set<string>()
  for (const w of text.split(/[^\p{L}\d]+/u)) {
    const p = PLATFORM_WORDS[w.toLowerCase()]
    if (p && (p !== 'x' || w === 'X' || w.toLowerCase() === 'twitter')) out.add(p)
  }
  const p = platformOf({ title: text, category: 'social', channel: null, targetUrl: null })
  if (p && p !== 'forum') out.add(p)
  return [...out]
}

export function isExcluded(g: Pick<PlanGuard, 'excluded'>, ...texts: (string | null | undefined)[]): boolean {
  if (!g.excluded.length) return false
  return mentionedPlatforms(texts.filter(Boolean).join(' ')).some(p => g.excluded.includes(p))
}

const STOP = new Set(['der', 'die', 'das', 'des', 'dem', 'den', 'und', 'oder', 'fur', 'mit', 'von', 'zu', 'zum', 'zur', 'im', 'in', 'auf', 'an', 'am', 'ein', 'eine', 'einen', 'einer', 'ist', 'wie', 'was', 'warum', 'the', 'of', 'for', 'to', 'and', 'on', 'with', 'how', 'why', 'what', 'is', 'artikel', 'article', 'post', 'beitrag', 'blog', 'ratgeber', 'neu', 'new', 'entwurf'])

export function titleTokens(title: string): string[] {
  const words = title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').split(/[^a-z0-9]+/)
  return [...new Set(words.filter(w => w.length > 1 && !STOP.has(w)))]
}

export function similarTitle(a: string, b: string): boolean {
  const A = titleTokens(a)
  const B = titleTokens(b)
  const [short, long] = A.length <= B.length ? [A, B] : [B, A]
  if (short.length < 2) return false
  const same = (x: string, y: string) => x === y || (x.length >= 5 && y.length >= 5 && (x.startsWith(y) || y.startsWith(x)))
  const hit = short.filter(x => long.some(y => same(x, y))).length
  if (short.length === 2) return hit === 2 && long.length === 2
  return hit / short.length >= 0.8 && hit / long.length >= 0.5
}

const ONE_OFF = ['content', 'verzeichnis', 'launch', 'outreach']

export interface KnownTask {
  title: string
  category: string
  status: string
}

export function duplicateOf(t: { title: string, category: string }, known: KnownTask[]): KnownTask | null {
  return known.find(k => k.category === t.category && (OPEN_STATUSES.includes(k.status as never) || (ONE_OFF.includes(t.category) && DONE_STATUSES.includes(k.status as never))) && similarTitle(t.title, k.title)) ?? null
}

export async function knownTasks(db: DbOrTx, projectId: string): Promise<KnownTask[]> {
  return db.select({ title: schema.tasks.title, category: schema.tasks.category, status: schema.tasks.status }).from(schema.tasks).where(and(eq(schema.tasks.projectId, projectId), inArray(schema.tasks.status, [...OPEN_STATUSES, ...DONE_STATUSES])))
}

const TOPIC_GENERIC = new Set(['setup', 'einrichten', 'einrichtung', 'aufbauen', 'aufbau', 'starten', 'start', 'erstellen', 'anlegen', 'planen', 'plan', 'kampagne', 'aktion', 'serie', 'woche', 'monat', 'idee', 'ideen', 'entwurf', 'erster', 'erste', 'ersten', 'neuer', 'neue', 'neues', 'eigener', 'eigene', 'eigenen', 'launch', 'konzept', 'vorlage', 'test', 'testen', 'artikel', 'blog', 'beitrag', 'post', 'posts', 'thema'])

// Kernwörter eines Themas, Wortteile mit Bindestrich einzeln ("Fan-Newsletter" -> newsletter, "Newsletter-Setup" -> newsletter).
export function coreTopic(title: string): string[] {
  const words = title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/\([^)]*\)/g, ' ').split(/[^a-z0-9]+/)
  return [...new Set(words.filter(w => w.length >= 4 && !STOP.has(w) && !TOPIC_GENERIC.has(w)))]
}

// Gleiches Thema wie eine vom Menschen verworfene Aufgabe: alle Kernwörter der kürzeren stecken in der längeren,
// bei nur einem Kernwort darf die andere höchstens zwei haben ("Newsletter-Setup" = "Fan-Newsletter", aber nicht jeder Post, der "Release" sagt).
export function rejectedTopicOf(title: string, rejected: { title: string }[]): { title: string } | null {
  const a = coreTopic(title)
  if (!a.length) return null
  const same = (x: string, y: string) => x === y || (x.length >= 5 && y.length >= 5 && (x.startsWith(y) || y.startsWith(x)))
  return rejected.find((r) => {
    const b = coreTopic(r.title)
    if (!b.length) return false
    const [short, long] = a.length <= b.length ? [a, b] : [b, a]
    if (short.length === 1 && long.length > 2) return false
    return short.every(x => long.some(y => same(x, y)))
  }) ?? null
}

// Aufgaben, die der Mensch im Projekt verworfen hat (letzte 180 Tage), ohne Antworten auf einzelne Threads.
export async function humanRejected(db: DbOrTx, projectId: string): Promise<{ title: string }[]> {
  return db.select({ title: schema.tasks.title }).from(schema.tasks).where(and(
    eq(schema.tasks.projectId, projectId),
    eq(schema.tasks.status, 'verworfen'),
    sql`coalesce(${schema.tasks.origin}, '') not like 'sweep:%' and coalesce(${schema.tasks.origin}, '') not like 'listening:%'`,
    gt(schema.tasks.updatedAt, new Date(now().getTime() - 180 * 86_400_000)),
    sql`exists (select 1 from activity a where a.task_id = ${schema.tasks.id} and a.action = 'status:verworfen' and a.actor = 'user')`,
  )).limit(300)
}

function socialPlatform(text: string): string | null {
  const p = platformOf({ title: text, category: 'social', channel: null, targetUrl: null })
  return p && p !== 'forum' && p !== 'reddit' ? p : null
}

export function channelPlatforms(c: Pick<StrategyChannel, 'name' | 'places'>): string[] {
  return [...new Set([...(c.places ?? []), c.name].map(socialPlatform).filter((p): p is string => !!p))]
}

export function taskBlock(g: PlanGuard, category: string, place: string | null, c?: Pick<StrategyChannel, 'name' | 'places'>): PlanBlock | null {
  const w = taskWhere({ title: place ?? c?.name ?? '', category, channel: place, draftKind: category === 'content' ? 'article' : null }, { blog: g.blog, channelName: c?.name ?? null, places: c?.places ?? [], accounts: g.accounts })
  if (!w.missing) return null
  if (w.kind === 'blog') return { kind: 'blog' }
  if (w.kind === 'social') {
    const ex = g.excluded ?? []
    const platform = w.mark ?? (c ? channelPlatforms(c).find(p => !ex.includes(p)) ?? null : null)
    return platform && ex.includes(platform) ? null : { kind: 'account', platform }
  }
  return null
}

export function channelExcluded(g: Pick<PlanGuard, 'excluded'>, c: Pick<StrategyChannel, 'name' | 'places' | 'category'>): boolean {
  if (c.category === 'outreach') return true
  const platforms = channelPlatforms(c)
  return platforms.length > 0 && platforms.every(p => g.excluded.includes(p))
}

export function channelBlock(g: PlanGuard, c: Pick<StrategyChannel, 'name' | 'places' | 'category'>): PlanBlock | null {
  if (c.category === 'content') return taskBlock(g, 'content', null, c)
  if (c.category !== 'social') return null
  const all = channelPlatforms(c)
  const platforms = all.filter(p => !(g.excluded ?? []).includes(p))
  if (all.length && !platforms.length) return null
  if (platforms.some(p => g.accounts.includes(p)) || (!platforms.length && g.accounts.length)) return null
  return { kind: 'account', platform: platforms[0] ?? null }
}

export function wantsBlog(g: PlanGuard, c: Pick<StrategyChannel, 'places' | 'category'>): boolean {
  return c.category === 'content' && !g.blog && (c.places ?? []).some(isOwnBlog)
}

export function setupOrigin(b: PlanBlock): string {
  return b.kind === 'account' ? `setup:account:${b.platform ?? 'social'}` : `setup:${b.kind}`
}

export const BRAVE_SETUP = {
  title: 'Brave-Suche einrichten',
  description: 'Reddit vergibt keine neuen API-Zugänge mehr. Unter Einstellungen > Plattform-Zugänge einen Brave-Search-API-Schlüssel eintragen (api-dashboard.search.brave.com, Gratis-Stufe reicht), dann sucht der Agent passende Reddit-Threads selbst und schreibt die Antworten. Eine vorhandene Reddit-App geht auch. Bis dahin entwerfe ich keine Reddit-Antworten.',
  humanStep: 'Brave-Search-API-Schlüssel unter Einstellungen > Plattform-Zugänge eintragen',
}

// Hat der Mensch eine Einrichtungs-Aufgabe dieser Art schon verworfen, legt der Planer sie nicht wieder an.
async function userDropped(db: DbOrTx, projectId: string, origin: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.projectId, projectId), eq(schema.tasks.origin, origin), eq(schema.tasks.status, 'verworfen'),
    sql`exists (select 1 from activity a where a.task_id = ${schema.tasks.id} and a.action = 'status:verworfen' and a.actor = 'user')`)).limit(1)
  return !!row
}

export async function ensureSetupTask(db: DbOrTx, project: Project, b: PlanBlock, c: Pick<StrategyChannel, 'name' | 'why'> | null, ownerId: string | null, date: string): Promise<boolean> {
  const origin = setupOrigin(b)
  if (b.kind === 'account' && b.platform && guardExcluded(project, await projectMemoryTexts(db, project.id)).includes(b.platform)) return false
  if (b.kind === 'account' && await userDropped(db, project.id, origin)) return false
  const [had] = await db.select({ id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status }).from(schema.tasks).where(and(eq(schema.tasks.projectId, project.id), eq(schema.tasks.origin, origin), ne(schema.tasks.status, 'verworfen'))).limit(1)
  if (had) {
    if (b.kind === 'reddit' && had.title !== BRAVE_SETUP.title && OPEN_STATUSES.includes(had.status)) await db.update(schema.tasks).set({ title: BRAVE_SETUP.title, description: BRAVE_SETUP.description, humanStep: BRAVE_SETUP.humanStep, updatedAt: new Date() }).where(eq(schema.tasks.id, had.id))
    return false
  }
  if (b.kind === 'reddit') {
    await createTask(db, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      ...BRAVE_SETUP,
      category: 'pflege',
      channel: 'Reddit',
      dueDate: date,
      durationMin: 15,
      estimateMin: 10,
      prio: 'P1',
      assigneeUserId: ownerId,
      origin,
    })
    return true
  }
  const site = project.url ? project.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') : project.name
  const why = c?.why ? ` Warum: ${c.why}` : ''
  const label = b.kind === 'account' && b.platform ? platformRule(b.platform).label : 'Social-Kanal'
  const blog = b.kind === 'blog'
  const code = await nextTaskCode(db, project.workspaceId, `${project.code}-${CATEGORY_CODES.pflege}`)
  await createTask(db, {
    workspaceId: project.workspaceId,
    projectId: project.id,
    code,
    title: blog ? `Blog-Bereich einrichten: ${project.name}` : `Konto anlegen: ${label} für ${project.name}`,
    description: blog
      ? `Die Strategie sieht Artikel vor${c ? ` (Kanal ${c.name})` : ''}, aber ${project.name} hat noch keinen Blog. Einen Blog-Bereich auf ${site} anlegen (z.B. /ratgeber) und die Adresse in den Projekt-Einstellungen eintragen, oder einen externen Ort wählen (LinkedIn-Artikel, Medium, dev.to). Bis dahin plane ich keine Artikel für den eigenen Blog.${why}\n\n${websiteOrder(project.url, code, 'Blog-Bereich anlegen (z.B. /ratgeber) mit Übersichtsseite und Artikel-Vorlage im Stil der Website, im Menü verlinkt, Artikel in Sitemap und RSS-Feed. Danach die Adresse in Aimarage unter Projekt-Einstellungen > Blog eintragen.', [])}`
      : `Die Strategie sieht Posts auf ${label} vor${c ? ` (Kanal ${c.name})` : ''}, aber für ${project.name} ist dort kein Konto verbunden. Konto anlegen und unter Konten verbinden; bis dahin plane ich keine Posts dafür.${why}`,
    category: 'pflege',
    channel: blog ? null : label,
    dueDate: date,
    durationMin: 30,
    estimateMin: blog ? 60 : 15,
    prio: 'P1',
    humanStep: blog ? 'Blog-Bereich anlegen, Adresse in den Projekt-Einstellungen eintragen' : `${label}-Konto anlegen und unter Konten verbinden`,
    assigneeUserId: ownerId,
    origin,
  })
  return true
}

export async function closeBlogSetup(db: DbOrTx, projectId: string, at: Date): Promise<void> {
  await db.update(schema.tasks).set({ status: 'erledigt', doneAt: at, updatedAt: at }).where(and(eq(schema.tasks.projectId, projectId), eq(schema.tasks.origin, 'setup:blog'), inArray(schema.tasks.status, OPEN_STATUSES)))
}

export async function closeRedditSetup(db: DbOrTx, workspaceId: string, at: Date): Promise<void> {
  await db.update(schema.tasks).set({ status: 'erledigt', doneAt: at, updatedAt: at }).where(and(eq(schema.tasks.workspaceId, workspaceId), eq(schema.tasks.origin, 'setup:reddit'), inArray(schema.tasks.status, OPEN_STATUSES)))
}

const SETUP_NOUN = /(?:^|[^\p{L}])(?:konto|konten|account|accounts|profil|profile)(?:[^\p{L}]|$)/iu
const SETUP_VERB = /(?:^|[^\p{L}])(?:anlegen|einrichten|erstellen|verbinden|eröffnen|registrieren|create|set up|connect)(?:[^\p{L}]|$)/iu

// Plattformen einer Einrichtungs-Aufgabe (Konto/Profil anlegen oder verbinden), sonst null.
export function setupPlatforms(t: { title: string, origin: string | null }): string[] | null {
  if (t.origin?.startsWith('setup:account:')) {
    const p = t.origin.slice('setup:account:'.length)
    return p && p !== 'social' ? [p] : null
  }
  if (t.origin?.startsWith('setup:') || !SETUP_NOUN.test(t.title) || !SETUP_VERB.test(t.title)) return null
  const ps = mentionedPlatforms(t.title)
  return ps.length && !ps.includes('reddit') ? ps : null
}

// Offene Einrichtungs-Aufgaben schließen, deren Konten schon verbunden sind (bei "alle": in irgendeinem Projekt).
export async function closeConnectedSetups(db: DbOrTx, ws: Workspace, taskId?: string): Promise<number> {
  const projects = await db.select().from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), isNull(schema.projects.archivedAt)))
  const byProject = new Map(projects.map(p => [p.id, { name: p.name, platforms: new Set(socialTarget(ws, p)?.platforms.map(x => x.platform) ?? []) }]))
  const all = new Set([...byProject.values()].flatMap(p => [...p.platforms]))
  if (!all.size) return 0
  const rows = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.workspaceId, ws.id),
    inArray(schema.tasks.status, OPEN_STATUSES),
    taskId ? eq(schema.tasks.id, taskId) : undefined,
    or(like(schema.tasks.origin, 'setup:account:%'), ilike(schema.tasks.title, '%konto%'), ilike(schema.tasks.title, '%account%'), ilike(schema.tasks.title, '%profil%')),
  ))
  let n = 0
  for (const t of rows) {
    const ps = setupPlatforms(t)
    const p = t.projectId ? byProject.get(t.projectId) : null
    const have = p ? p.platforms : all
    if (!ps || !ps.every(x => have.has(x))) continue
    await updateTask(db, t, { status: 'erledigt' }, { type: 'agent' })
    const labels = ps.map(x => platformRule(x).label).join(', ')
    await db.insert(schema.taskNotes).values({ taskId: t.id, byAgent: true, text: `Automatisch erledigt: ${labels} ist ${p ? `für ${p.name}` : 'in den Projekten'} schon verbunden (Konten).` })
    n++
  }
  return n
}
