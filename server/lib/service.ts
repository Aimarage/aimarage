import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { safeHttpUrl } from '../../shared/utils/url'
import { accountKnown, cleanSteps, needsServiceCheck, needsSubmitUrl, serviceName, type TaskService } from '../../shared/utils/service'
import { releaseRule } from '../../shared/utils/release-focus'
import { servicePrompt } from '../prompts/de'
import { chatJson, type ChatResult, type LlmConfig } from './llm'
import { braveKey, braveSearch, type BraveResult } from './platforms/brave'
import { fetchSite, safeFetch, siteDigest, SITE_UA } from './site'
import { releaseFocusFor } from './release-focus'
import { activeChannels, projectPlatforms } from './where'
import { now, today } from './clock'
import type { Db } from './db'
import { schema } from './db'
import { enqueueJob } from './jobs'

type Workspace = typeof schema.workspaces.$inferSelect
type Task = typeof schema.tasks.$inferSelect
type Project = typeof schema.projects.$inferSelect

export const SERVICE_INFO = 'Info nötig:'
export const SERVICE_PER_RUN = 5

const dash = (s: string) => s.replace(/[\u2013\u2014]/g, '-').trim()
// Kürzen ohne halbe Sätze: bis zum letzten Satzende, sonst bis zum letzten Wort mit "...".
export function clipText(v: string, max: number): string {
  const s = dash(v)
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('.)'))
  if (end >= max / 3) return cut.slice(0, end + 1).trim()
  const sp = cut.slice(0, max - 3).lastIndexOf(' ')
  return `${cut.slice(0, sp > 0 ? sp : max - 3).replace(/[\s,;:(-]+$/, '')}...`
}

const text = (max: number) => z.string().max(max * 2).optional().nullable().transform(v => (v ? clipText(v, max) : null))

const serviceSchema = z.object({
  name: text(80),
  url: z.string().max(500).optional().nullable(),
  what: text(300),
  why: text(240),
  cost: text(120),
  register: text(120),
  steps: z.array(z.string().max(300)).max(8).optional().nullable(),
  fits: z.boolean().optional().nullable(),
  fitReason: text(240),
  description: text(600),
})

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  }
  catch {
    return null
  }
}

export async function reachable(url: string, f: typeof fetch = fetch): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await safeFetch(url, { method: 'GET', signal: ctrl.signal, headers: { 'User-Agent': SITE_UA, 'Accept': 'text/html,*/*;q=0.5' } }, f)
    await res.body?.cancel().catch(() => {})
    return res.status !== 404 && res.status !== 410
  }
  catch {
    return false
  }
  finally {
    clearTimeout(timer)
  }
}

export function pickUrl(raw: string | null | undefined, results: Pick<BraveResult, 'url'>[], searched: boolean): string | null {
  const url = safeHttpUrl(raw?.trim())
  if (!url) return null
  if (!searched) return url
  const host = hostOf(url)
  return results.some(r => hostOf(r.url) === host) ? url : null
}

export interface ServiceDeps { llm: LlmConfig, llmFetch?: typeof fetch, webFetch?: typeof fetch, log: string[], usage: ChatResult[] }

export async function researchService(db: Db, ws: Workspace, task: Task, project: Project | null, deps: ServiceDeps): Promise<{ service: TaskService, description: string | null }> {
  const web = deps.webFetch ?? fetch
  const channels = project ? (await activeChannels(db, [project.id])).get(project.id) ?? [] : []
  const name = serviceName(task, channels.map(c => c.name))
  const memory = project ? (await db.select({ text: schema.projectMemory.text }).from(schema.projectMemory).where(eq(schema.projectMemory.projectId, project.id)).orderBy(asc(schema.projectMemory.createdAt)).limit(30)).map(m => m.text) : []
  const facts = project?.setup?.facts?.known ?? []
  const known = accountKnown(name, [...memory, ...facts], project ? projectPlatforms(ws, project) : [])
  const key = braveKey(ws)
  let results: BraveResult[] = []
  if (key) {
    try {
      results = (await braveSearch(key, `${name} submit`, web, { count: 8, freshness: null, use: { ws: ws.id, project: project?.id, purpose: 'service' } })).slice(0, 8)
    }
    catch (err) {
      deps.log.push(`Brave-Suche für ${name} fehlgeschlagen: ${(err as Error).message.slice(0, 160)}`)
    }
  }
  const known_url = safeHttpUrl(task.targetUrl)
  let page: string | null = null
  if (known_url) {
    const site = await fetchSite(known_url, { maxPages: 1, fetchImpl: web }).catch(() => null)
    if (site?.pages[0]) page = siteDigest(site, 2500)
  }
  const focus = project ? await releaseFocusFor(db, project.id, today(ws.timezone)) : null
  const prompt = servicePrompt({
    name,
    task,
    project: project ? { name: project.name, url: project.url, description: project.description } : null,
    memory: memory.slice(-15),
    release: releaseRule(focus) || null,
    results: results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet })),
    page,
    account: known,
  })
  deps.log.push(prompt)
  const res = await chatJson(deps.llm, { messages: [{ role: 'user', content: prompt }], maxTokens: 900 }, serviceSchema, deps.llmFetch)
  deps.usage.push(...res.usage)
  const d = res.data
  let url = known_url ?? pickUrl(d.url, results, results.length > 0)
  if (url && !known_url && !(await reachable(url, web))) {
    deps.log.push(`Einreich-Seite nicht erreichbar: ${url}`)
    url = null
  }
  const service: TaskService = {
    name: d.name || name,
    what: d.what,
    why: d.why,
    cost: d.cost,
    account: known ? 'vorhanden' : 'neu',
    register: known ? null : d.register,
    steps: cleanSteps(d.steps ?? [], known, d.register),
    url,
    fits: d.fits !== false,
    fitReason: d.fits === false ? d.fitReason : null,
    checkedAt: now().toISOString(),
  }
  const description = d.description && d.description !== task.description ? d.description : null
  return { service, description }
}

export function serviceQuestion(task: Pick<Task, 'category'>, s: TaskService): string | null {
  if (!s.fits) return `${s.fitReason ?? `${s.name} passt eventuell nicht zum Projekt.`} Trotzdem bei ${s.name} einreichen?`
  if (!s.url && needsSubmitUrl(task)) return `Ich finde keine Einreich-Seite für ${s.name}. Kennst du den Link, oder soll die Aufgabe weg?`
  return null
}

export function serviceMemory(s: TaskService): string {
  return [
    `Ort: ${s.name}${s.what ? ` - ${s.what}` : ''}`,
    s.url ? `Einreichen über ${s.url}` : '',
    s.cost ? `Kosten: ${s.cost}` : '',
    s.account === 'vorhanden' ? `Konto bei ${s.name}: vorhanden` : `Konto bei ${s.name}: keins bekannt, der Mensch legt eins an. In "notes" nie "einloggen" oder "mit deinem Konto" schreiben.`,
  ].filter(Boolean).join('. ')
}

export async function refreshService(db: Db, ws: Workspace, task: Task, project: Project | null, deps: ServiceDeps): Promise<Task> {
  const { service, description } = await researchService(db, ws, task, project, deps)
  const [row] = await db.update(schema.tasks).set({
    service,
    targetUrl: task.targetUrl ?? service.url,
    ...(description ? { description } : {}),
    updatedAt: now(),
  }).where(eq(schema.tasks.id, task.id)).returning()
  if (service.url && !task.targetUrl) {
    await db.update(schema.drafts).set({ targetUrl: service.url }).where(and(eq(schema.drafts.taskId, task.id), inArray(schema.drafts.status, ['offen', 'freigegeben'])))
  }
  return row ?? task
}

async function askOnce(db: Db, taskId: string, question: string): Promise<boolean> {
  const text = `${SERVICE_INFO} ${question}`
  const had = await db.select({ id: schema.taskNotes.id }).from(schema.taskNotes).where(and(eq(schema.taskNotes.taskId, taskId), eq(schema.taskNotes.text, text))).limit(1)
  if (had.length) return false
  await db.insert(schema.taskNotes).values({ taskId, byAgent: true, text, createdAt: now() })
  return true
}

export async function refreshServiceTasks(db: Db, ws: Workspace, deps: ServiceDeps): Promise<number> {
  const rows = await db.select().from(schema.tasks).where(and(
    eq(schema.tasks.workspaceId, ws.id),
    inArray(schema.tasks.status, ['geplant', 'entwurf_fertig', 'freigegeben']),
    isNotNull(schema.tasks.humanStep),
    inArray(schema.tasks.category, ['verzeichnis', 'launch', 'community', 'content', 'outreach']),
  )).orderBy(asc(schema.tasks.dueDate)).limit(200)
  const at = now()
  const todo = rows.filter(t => needsServiceCheck(t, at)).slice(0, SERVICE_PER_RUN)
  let n = 0
  for (const t of todo) {
    const project = t.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, t.projectId)))[0] ?? null : null
    try {
      const fresh = await refreshService(db, ws, t, project, deps)
      n++
      const s = fresh.service!
      const q = serviceQuestion(fresh, s)
      const open = (await db.select({ id: schema.drafts.id }).from(schema.drafts).where(and(eq(schema.drafts.taskId, t.id), eq(schema.drafts.status, 'offen'))).limit(1))[0]
      if (q && open) await askOnce(db, t.id, q)
      else if (open && fresh.description !== t.description) await enqueueJob(db, 'draft_task', { workspaceId: ws.id, payload: { taskId: t.id }, dedupeKey: `draft_task:${t.id}:service` })
    }
    catch (err) {
      deps.log.push(`Dienst-Recherche ${t.code} fehlgeschlagen: ${(err as Error).message.slice(0, 200)}`)
    }
  }
  return n
}
