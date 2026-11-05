import { and, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm'
import { planAllowsMail } from '../../shared/utils/coldmail'
import { addDays, isValidTime, weekday } from '../../shared/utils/dates'
import type { Category, DraftKind } from '../../shared/utils/domain'
import { platformOf, taskListedPlatforms } from '../../shared/utils/drafting'
import { CATEGORY_STEPS } from '../../shared/utils/plan'
import { DEFAULT_RELEASE_TIME, MAX_RELEASE_ITEMS, parseTrackList, RELEASE_KIND_LABEL, RELEASE_KINDS, releaseSlug, validDate, weekendPolicy, type ReleaseKind, type WeekendPolicy } from '../../shared/utils/release'
import { platformRule } from '../../shared/utils/social'
import { safeHttpUrl } from '../../shared/utils/url'
import { logActivity } from './activity'
import { agentReady } from './agent'
import { bestTimes } from './best-times'
import { insightTime } from './experiments'
import { now, today } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { listFundus, type FundusItem } from './fundus'
import { enqueueJob } from './jobs'
import { excludedPlatforms, factTexts, projectMemoryTexts } from './plan-guard'
import { socialTarget } from './publish'
import { knownReleases, onReleaseCreated } from './release-focus'
import { withChannelPlaces } from './channel-places'
import { projectOwner } from './strategy'
import { createTask } from './tasks'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

export class ReleaseError extends Error {}

export interface ReleaseRequest {
  title: string
  kind: ReleaseKind
  releaseDate: string
  link?: string | null
  items?: string[] | string | null
  documentId?: string | null
  platforms?: string[] | null
  start?: string | null
  every?: number | null
  time?: string | null
  press?: boolean | null
}

export type ReleaseImage = Pick<FundusItem, 'id' | 'name' | 'mime' | 'tags' | 'usedCount' | 'taskId'>

export interface ReleaseEnv {
  today: string
  postable: string[]
  excluded: string[]
  busy: Record<string, string[]>
  weekend: WeekendPolicy
  hasBlog: boolean
  bestTime: string | null
  fundus: ReleaseImage[]
  documentItems?: string[]
}

export type ReleaseItemKind = 'social' | 'blog' | 'pitch' | 'community' | 'press'

export interface PlannedItem {
  kind: ReleaseItemKind
  title: string
  description: string
  category: Category
  draftKind: DraftKind
  date: string
  time: string | null
  platforms: string[]
  channel: string | null
  human: boolean
  targetUrl: string | null
  image: { id: string, name: string, tag: string } | null
  shifted: boolean
  agentStep: string
  humanStep: string
  estimateMin: number
}

export interface ReleasePlan {
  title: string
  kind: ReleaseKind
  releaseDate: string
  link: string | null
  start: string
  every: number
  time: string
  timeSource: 'input' | 'data' | 'default'
  platforms: string[]
  items: string[]
  weekend: WeekendPolicy
  tasks: PlannedItem[]
  warnings: string[]
}

const COVER = ['cover']
const GROUP = ['presse', 'pressefoto', 'press', 'gruppe', 'band', 'group']
const PORTRAIT = ['portraet', 'porträt', 'portrait']

function dmy(d: string): string {
  return `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`
}

function label(p: string): string {
  return platformRule(p).label
}

export function normalizeRequest(req: ReleaseRequest, env: Pick<ReleaseEnv, 'today' | 'postable' | 'excluded' | 'documentItems'>): { title: string, kind: ReleaseKind, releaseDate: string, link: string | null, items: string[], platforms: string[], start: string, every: number, time: string | null, press: boolean, warnings: string[] } {
  const warnings: string[] = []
  const title = (req.title ?? '').replace(/[–—]/g, '-').trim().slice(0, 120)
  if (!title) throw new ReleaseError('Titel fehlt')
  if (!(RELEASE_KINDS as readonly string[]).includes(req.kind)) throw new ReleaseError('Art unbekannt (album, single, ep, launch)')
  if (!req.releaseDate || !validDate(req.releaseDate)) throw new ReleaseError('Release-Datum fehlt oder ist ungültig (YYYY-MM-DD)')
  const link = req.link?.trim() ? safeHttpUrl(req.link.trim()) : null
  if (req.link?.trim() && !link) throw new ReleaseError('Release-Link ist keine gültige Adresse')
  const raw = Array.isArray(req.items) ? req.items.join('\n') : (req.items ?? '')
  let items = parseTrackList(raw)
  if (!items.length && env.documentItems?.length) items = env.documentItems
  items = items.slice(0, MAX_RELEASE_ITEMS)
  const available = env.postable.filter(p => !env.excluded.includes(p))
  let platforms = available
  if (req.platforms?.length) {
    const wanted = [...new Set(req.platforms.map(p => p.trim().toLowerCase()).filter(Boolean))]
    const missing = wanted.filter(p => !available.includes(p))
    if (missing.length) warnings.push(`Nicht verbunden oder ausgeschlossen, ausgelassen: ${missing.map(label).join(', ')}`)
    platforms = wanted.filter(p => available.includes(p))
  }
  if (!platforms.length) warnings.push('Kein Social-Konto verbunden: keine Posts geplant')
  const tomorrow = addDays(env.today, 1)
  const wantedStart = validDate(req.start) ? req.start : (req.releaseDate > env.today ? req.releaseDate : tomorrow)
  const start = wantedStart < tomorrow ? tomorrow : wantedStart
  const every = Math.min(Math.max(Math.round(Number(req.every) || 1), 1), 7)
  const time = req.time && isValidTime(req.time) ? req.time : null
  return { title, kind: req.kind, releaseDate: req.releaseDate, link, items, platforms, start, every, time, press: !!req.press, warnings }
}

function hasTag(i: ReleaseImage, tags: string[]): boolean {
  return i.tags.some(t => tags.includes(t))
}

export function imagePools(fundus: ReleaseImage[]): Record<'cover' | 'group' | 'portrait', ReleaseImage[]> {
  const imgs = fundus.filter(i => i.mime.startsWith('image/')).sort((a, b) => a.usedCount - b.usedCount || a.name.localeCompare(b.name))
  return {
    cover: imgs.filter(i => hasTag(i, COVER)),
    group: imgs.filter(i => hasTag(i, GROUP) && !hasTag(i, PORTRAIT) && !hasTag(i, COVER)),
    portrait: imgs.filter(i => hasTag(i, PORTRAIT) && !hasTag(i, COVER)),
  }
}

export function pickImages(fundus: ReleaseImage[], count: number): ({ id: string, name: string, tag: string } | null)[] {
  const pools = imagePools(fundus)
  const next: Record<string, number> = { cover: 0, group: 0, portrait: 0 }
  const order: Record<string, (keyof typeof pools)[]> = { cover: ['cover', 'group', 'portrait'], group: ['group', 'portrait', 'cover'], portrait: ['portrait', 'group', 'cover'] }
  const tagOf: Record<keyof typeof pools, string> = { cover: 'cover', group: 'presse', portrait: 'portraet' }
  const out: ({ id: string, name: string, tag: string } | null)[] = []
  for (let i = 0; i < count; i++) {
    const want: keyof typeof pools = i === 0 || i === count - 1 ? 'cover' : i % 2 === 1 ? 'group' : 'portrait'
    const pool = order[want]!.find(k => pools[k].length)
    if (!pool) {
      out.push(null)
      continue
    }
    const list = pools[pool]
    const item = list[next[pool]! % list.length]!
    next[pool]!++
    out.push({ id: item.id, name: item.name, tag: tagOf[pool] })
  }
  return out
}

function steps(category: Category, fallback: { agent: string, human: string, estimate: number }) {
  return CATEGORY_STEPS[category] ?? fallback
}

export function buildReleasePlan(req: ReleaseRequest, env: ReleaseEnv): ReleasePlan {
  const n = normalizeRequest(req, env)
  const { work, item } = RELEASE_KIND_LABEL[n.kind]
  const warnings = [...n.warnings]
  const timeSource: ReleasePlan['timeSource'] = n.time ? 'input' : env.bestTime ? 'data' : 'default'
  const time = n.time ?? env.bestTime ?? DEFAULT_RELEASE_TIME
  const busy = new Map<string, Set<string>>(Object.entries(env.busy).map(([d, ps]) => [d, new Set(ps)]))
  const okDay = (d: string, human: boolean) => weekday(d) < 6 || (human ? env.weekend.human : env.weekend.social)
  const humanDay = (from: string) => {
    let d = from
    for (let i = 0; i < 14 && !okDay(d, true); i++) d = addDays(d, 1)
    return d
  }
  const tasks: PlannedItem[] = []
  const linkLine = n.link ? `Link: ${n.link} (UTM wird je Plattform ergänzt).` : 'Release-Link fehlt: auf die Projekt-Website verweisen, keinen Link erfinden.'
  const rel = `Release ${dmy(n.releaseDate)}`
  const count = n.items.length
  const plural = count === 1 ? item : `${item}s`

  if (n.platforms.length) {
    const posts = [...n.items.map((t, i) => ({ track: t, idx: i + 1 })), { track: null as string | null, idx: count + 1 }]
    const total = posts.length
    const images = pickImages(env.fundus, total)
    const channel = n.platforms.length === env.postable.length ? null : n.platforms.map(label).join(', ')
    const st = steps('social', { agent: 'Beitrag entwerfen', human: 'Prüfen und posten', estimate: 5 })
    let cursor = n.start
    for (const [i, p] of posts.entries()) {
      let d = cursor
      let guard = 0
      while (guard++ < 366 && (!okDay(d, false) || n.platforms.some(pl => busy.get(d)?.has(pl)))) d = addDays(d, 1)
      const shifted = d !== cursor
      const set = busy.get(d) ?? new Set<string>()
      for (const pl of n.platforms) set.add(pl)
      busy.set(d, set)
      cursor = addDays(d, n.every)
      const img = images[i] ?? null
      const head = `Post-Serie zum ${work} "${n.title}" (${count ? `${count} ${plural}, ` : ''}${rel}), ein ${item} pro Post, ${work} first: jeder Post führt zum ganzen ${work}.`
      const what = p.track
        ? `${item} ${p.idx}: "${p.track}". Worum es im ${item} geht, nur aus bekannten Fakten und Unterlagen; nichts erfinden.`
        : `Abschluss der Serie: das ganze ${work}${count ? ` mit allen ${count} ${plural}` : ''} zusammen, Dank an alle, die reingehört bzw. reingeschaut haben, klare Einladung zum ${work}.`
      tasks.push({
        kind: 'social',
        title: (p.track ? `${n.title}-Serie ${p.idx}/${total}: ${p.track}` : `${n.title}-Serie ${total}/${total}: das ganze ${work}`).slice(0, 200),
        description: [
          head,
          what,
          `Plattformen: ${n.platforms.map(label).join(', ')}.`,
          img ? `Bild aus dem Fundus: ${img.name} (Tag ${img.tag}).` : '',
          linkLine,
          n.platforms.includes('instagram') ? 'Instagram: Links sind nicht klickbar, dort auf den Link in der Bio verweisen.' : '',
        ].filter(Boolean).join('\n'),
        category: 'social',
        draftKind: 'post',
        date: d,
        time,
        platforms: n.platforms,
        channel,
        human: false,
        targetUrl: n.link,
        image: img,
        shifted,
        agentStep: st.agent,
        humanStep: st.human,
        estimateMin: st.estimate,
      })
    }
  }

  const first = humanDay(n.start)
  const listHint = count ? ` (${n.items.slice(0, 12).join(', ')}${count > 12 ? ', ...' : ''})` : ''
  if (env.hasBlog) {
    const st = steps('content', { agent: 'Artikel entwerfen', human: 'Prüfen und veröffentlichen', estimate: 30 })
    tasks.push({
      kind: 'blog',
      title: `Blog-Artikel: ${n.title} - ${work} vorstellen (Anker der Kampagne)`.slice(0, 200),
      description: [
        `Artikel als Anker der Release-Kampagne zum ${work} "${n.title}" (${rel}). Konzept bzw. Idee, ${count ? `alle ${count} ${plural}${listHint} mit je 1-2 Sätzen, ` : ''}Release-Datum, wo es das ${work} gibt.`,
        'Social-Posts und der Community-Beitrag verweisen auf diesen Artikel. Nur bekannte Fakten, nichts erfinden.',
        linkLine,
      ].join('\n'),
      category: 'content',
      draftKind: 'article',
      date: first,
      time: '10:00',
      platforms: [],
      channel: null,
      human: false,
      targetUrl: null,
      image: null,
      shifted: first !== n.start,
      agentStep: st.agent,
      humanStep: st.human,
      estimateMin: st.estimate,
    })
  }
  else warnings.push('Kein Blog im Projekt: kein Anker-Artikel geplant')

  const music = n.kind !== 'launch'
  tasks.push({
    kind: 'pitch',
    title: music ? `Einreichung bei Kuratoren: ${n.title} (SubmitHub o.ä.)`.slice(0, 200) : `Einreichung: ${n.title} bei Launch-Seiten und Verzeichnissen`.slice(0, 200),
    description: [
      music
        ? `Der Mensch reicht selbst ein (eigenes Konto, Credits gibt der Mensch aus). Agent: 2-3 stärkste ${plural}${listHint} für passende Kuratoren und Blogs vorschlagen (nur passendes Genre, nur wer diese Art Musik annimmt), Credits-Aufteilung vorschlagen und je ${item} einen kurzen Pitch-Text schreiben (60-80 Wörter, konkret, kein Druck). ${work} first: im Pitch das ${work} erwähnen.`
        : `Der Mensch reicht selbst ein (eigenes Konto). Agent: passende Launch-Seiten und Verzeichnisse mit Einreich-Formular vorschlagen und die Einreichungstexte schreiben (kurz, lang, Kategorien)${count ? `, die wichtigsten ${plural}${listHint} hervorheben` : ''}.`,
      music ? 'Einreichung über das Formular der Plattform, z.B. https://www.submithub.com (keine Mail).' : 'Einreichung über das Formular der Plattform, z.B. https://www.producthunt.com (keine Mail).',
      linkLine,
    ].join('\n'),
    category: 'outreach',
    draftKind: 'text',
    date: first,
    time: null,
    platforms: [],
    channel: null,
    human: true,
    targetUrl: null,
    image: null,
    shifted: first !== n.start,
    agentStep: music ? `${plural} auswählen, Pitch-Texte schreiben` : 'Plattformen auswählen, Einreichungstexte schreiben',
    humanStep: music ? 'Selbst einreichen (eigenes Konto, Credits)' : 'Selbst einreichen',
    estimateMin: 20,
  })

  const comDay = humanDay(addDays(n.start, 2))
  const cst = steps('community', { agent: 'Beitrag entwerfen', human: 'Prüfen und selbst posten', estimate: 10 })
  tasks.push({
    kind: 'community',
    title: `Community-Beitrag: ${n.title} vorstellen`.slice(0, 200),
    description: [
      `Eigener Beitrag zum Konzept bzw. zur Idee hinter dem ${work} "${n.title}" in einer passenden Community (z.B. Subreddit oder Forum der Zielgruppe). Der Mensch postet selbst.`,
      'Vorher die Regeln der Community prüfen (Eigenwerbung erlaubt? diese Art Inhalt erlaubt?) und das Ergebnis in die Notiz schreiben. Projekt-Regeln gelten auch hier.',
      `Kein Werbe-Ton, Gespräch suchen, Link am Ende${env.hasBlog ? ' (Anker: der Blog-Artikel zum Release)' : ''}.`,
      linkLine,
    ].join('\n'),
    category: 'community',
    draftKind: 'post',
    date: comDay,
    time: null,
    platforms: [],
    channel: null,
    human: true,
    targetUrl: null,
    image: null,
    shifted: comDay !== addDays(n.start, 2),
    agentStep: 'Community wählen, Regeln prüfen, Beitrag entwerfen',
    humanStep: 'Regeln prüfen und selbst posten',
    estimateMin: cst.estimate,
  })

  if (n.press) {
    tasks.push({
      kind: 'press',
      title: `Pressetext: ${n.title}`.slice(0, 200),
      description: [
        `Nur Entwurf: kurzer Pressetext zum ${work} "${n.title}" (${rel}): Fakten, ${count ? `${count} ${plural}, ` : ''}wo es erscheint, ein kurzes Zitat ohne Erfindungen.`,
        'Senden nur an Redaktionen, die ausdrücklich um Einsendungen bitten (Einsende- oder Tipp-Adresse, Quelle als Link in der Notiz), oder als Antwort auf eine Anfrage. Keine Kaltmails.',
        linkLine,
      ].join('\n'),
      category: 'outreach',
      draftKind: 'text',
      date: first,
      time: null,
      platforms: [],
      channel: null,
      human: true,
      targetUrl: null,
      image: null,
      shifted: first !== n.start,
      agentStep: 'Pressetext entwerfen',
      humanStep: 'Prüfen, nur an Einsende-Adressen senden',
      estimateMin: 15,
    })
  }

  const allowed = tasks.filter((t) => {
    const ok = planAllowsMail({ category: t.category, draftKind: t.draftKind, title: t.title, description: t.description, targetUrl: t.targetUrl })
    if (!ok) warnings.push(`Ausgelassen (keine Kaltmails): ${t.title}`)
    return ok
  })
  allowed.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '99').localeCompare(b.time ?? '99'))
  return { title: n.title, kind: n.kind, releaseDate: n.releaseDate, link: n.link, start: n.start, every: n.every, time, timeSource, platforms: n.platforms, items: n.items, weekend: env.weekend, tasks: allowed, warnings }
}

export function taskPlatforms(t: { category: string, channel: string | null, title: string, targetUrl: string | null, description?: string | null, channelPlaces?: string[] | null }, postable: string[]): string[] {
  const listed = taskListedPlatforms(t)
  if (listed.length) return listed
  const p = platformOf(t)
  return p && p !== 'forum' ? [p] : postable
}

export async function busyDays(db: DbOrTx, ws: Workspace, project: Project, from: string, postable: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, Set<string>> = {}
  const add = (d: string | null, ps: string[]) => {
    if (!d) return
    out[d] ??= new Set()
    for (const p of ps) out[d].add(p)
  }
  const tasks = await db.select({ id: schema.tasks.id, dueDate: schema.tasks.dueDate, category: schema.tasks.category, channel: schema.tasks.channel, title: schema.tasks.title, targetUrl: schema.tasks.targetUrl, description: schema.tasks.description, projectId: schema.tasks.projectId, strategyChannel: schema.tasks.strategyChannel }).from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, project.id), eq(schema.tasks.category, 'social'), ne(schema.tasks.status, 'verworfen'), gte(schema.tasks.dueDate, from)))
  for (const t of await withChannelPlaces(db, tasks)) add(t.dueDate, taskPlatforms(t, postable))
  const posts = await db.select({ platforms: schema.socialPosts.platforms, day: sql<string>`to_char(${schema.socialPosts.scheduledAt} at time zone ${ws.timezone}, 'YYYY-MM-DD')` }).from(schema.socialPosts)
    .where(and(eq(schema.socialPosts.projectId, project.id), inArray(schema.socialPosts.status, ['geplant', 'laeuft', 'gepostet', 'teilweise'])))
  for (const p of posts) if (p.day >= from) add(p.day, p.platforms)
  return Object.fromEntries(Object.entries(out).map(([d, s]) => [d, [...s]]))
}

export async function releaseEnv(db: DbOrTx, ws: Workspace, project: Project, req?: Pick<ReleaseRequest, 'documentId' | 'platforms' | 'releaseDate' | 'start'>): Promise<ReleaseEnv> {
  const d = today(ws.timezone)
  const memory = await projectMemoryTexts(db, project.id)
  const postable = socialTarget(ws, project)?.platforms.filter(p => p.postable).map(p => p.platform) ?? []
  const excluded = excludedPlatforms(factTexts(project, memory))
  const chosen = req?.platforms?.length ? req.platforms : postable
  const times = (await bestTimes(db, ws, project)).filter(t => t.source === 'data' && chosen.includes(t.platform))
  let documentItems: string[] | undefined
  if (req?.documentId) {
    const [doc] = await db.select({ text: schema.projectDocuments.text }).from(schema.projectDocuments).where(and(eq(schema.projectDocuments.id, req.documentId), eq(schema.projectDocuments.projectId, project.id)))
    if (!doc) throw new ReleaseError('Unterlage nicht gefunden')
    documentItems = parseTrackList(doc.text, { strict: true })
  }
  const fundus = (await listFundus(db, project.id, { checkedOnly: true })).filter(i => !i.taskId)
  return {
    today: d,
    postable,
    excluded,
    busy: await busyDays(db, ws, project, addDays(d, 1), postable),
    weekend: weekendPolicy([project.rules, ...factTexts(project, memory)]),
    hasBlog: !!(project.setup?.blog || project.setup?.blogApi?.secret),
    bestTime: times[0]?.time ?? await insightTime(db, project.id),
    fundus,
    documentItems,
  }
}

export function releaseSummary(plan: ReleasePlan) {
  return {
    title: plan.title,
    kind: plan.kind,
    start: plan.start,
    time: plan.time,
    platforms: plan.platforms,
    weekend: plan.weekend,
    warnings: plan.warnings,
    tasks: plan.tasks.map(t => ({ date: t.date, time: t.time, title: t.title, platforms: t.platforms, human: t.human, image: t.image?.name ?? null, shifted: t.shifted })),
  }
}

export function campaignName(title: string): string {
  return `Release: ${title}`.slice(0, 200)
}

export async function planRelease(db: DbOrTx, ws: Workspace, project: Project, req: ReleaseRequest): Promise<ReleasePlan> {
  return buildReleasePlan(req, await releaseEnv(db, ws, project, req))
}

export async function createRelease(db: Db, ws: Workspace, project: Project, req: ReleaseRequest, actor: { userId: string | null, via?: 'api' | null }): Promise<{ plan: ReleasePlan, campaignId: string, tasks: { id: string, code: string, title: string, date: string, time: string | null }[] }> {
  const plan = await planRelease(db, ws, project, req)
  const name = campaignName(plan.title)
  const [had] = await db.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.projectId, project.id), eq(schema.campaigns.name, name))).limit(1)
  if (had) {
    const [open] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.campaignId, had.id), ne(schema.tasks.status, 'verworfen'))).limit(1)
    if (open) throw new ReleaseError(`Die Release-Kampagne "${plan.title}" ist schon angelegt`)
  }
  const owner = actor.userId ?? await projectOwner(db, project.id)
  const origin = `release:${releaseSlug(plan.title)}`
  const d = today(ws.timezone)
  const last = plan.tasks.reduce((m, t) => (t.date > m ? t.date : m), plan.start)
  const release = { title: plan.title, kind: plan.kind, releaseDate: plan.releaseDate, items: plan.items }
  const older = (await knownReleases(db, project.id)).some(r => r.releaseDate > plan.releaseDate)
  const created = await db.transaction(async (tx) => {
    const [c] = await tx.insert(schema.campaigns).values({ workspaceId: ws.id, projectId: project.id, name, startDate: plan.start, endDate: last, goal: `${RELEASE_KIND_LABEL[plan.kind].work} ${plan.title}, Release ${plan.releaseDate}`, release }).returning({ id: schema.campaigns.id })
    const rows: { id: string, code: string, title: string, date: string, time: string | null, draft: boolean }[] = []
    for (const t of plan.tasks) {
      const row = await createTask(tx, {
        workspaceId: ws.id,
        projectId: project.id,
        campaignId: c!.id,
        title: t.title,
        description: t.description,
        category: t.category,
        channel: t.channel,
        dueDate: t.date,
        dueTime: t.time,
        agentStep: t.agentStep,
        humanStep: t.humanStep,
        assigneeUserId: owner,
        draftKind: t.draftKind,
        targetUrl: t.targetUrl,
        estimateMin: t.estimateMin,
        milestone: false,
        createdByUserId: actor.userId,
        origin,
        releaseOk: older,
      })
      if (t.image) await tx.update(schema.mediaLibrary).set({ taskId: row.id }).where(and(eq(schema.mediaLibrary.id, t.image.id), eq(schema.mediaLibrary.projectId, project.id), isNull(schema.mediaLibrary.taskId)))
      rows.push({ id: row.id, code: row.code, title: row.title, date: t.date, time: t.time, draft: true })
    }
    await logActivity(tx, { workspaceId: ws.id, projectId: project.id, actor: actor.userId ? 'user' : 'agent', userId: actor.userId, action: 'release_planned', detail: { title: plan.title, count: rows.length }, at: now() })
    return { campaignId: c!.id, rows }
  })
  if (!older) {
    try {
      await onReleaseCreated(db, ws, project, release)
    }
    catch (err) {
      console.error('Release: Strategie-Vorschlag fehlgeschlagen', err)
    }
  }
  if (agentReady(ws)) {
    for (const r of created.rows) {
      if (r.date <= addDays(d, 2)) await enqueueJob(db, 'draft_task', { workspaceId: ws.id, payload: { taskId: r.id, ...(actor.via ? { hold: true } : {}) }, dedupeKey: `draft_task:${r.id}:${d}` })
    }
  }
  return { plan, campaignId: created.campaignId, tasks: created.rows.map(({ draft: _d, ...r }) => r) }
}
