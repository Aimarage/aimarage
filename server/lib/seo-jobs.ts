import { and, eq, isNull, sql } from 'drizzle-orm'
import { plural } from '../../shared/utils/plural'
import { agentReady, withRun, workspaceLlm, type RunOutcome } from './agent'
import { logActivity } from './activity'
import { config } from './config'
import { openAppApiKey } from './connections'
import type { Db } from './db'
import { schema } from './db'
import { SEARCH_LABEL, syncAllSearch } from './search-console'
import { auditSite, saveAudit, seoTasks } from './seo-audit'
import { spreadSelfTasks } from './self-limit'
import { readProjectSite } from './site-pages'
import { planByBudget } from './time-budget'
import { now, today } from './clock'

type Workspace = typeof schema.workspaces.$inferSelect
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export async function runSearchSync(db: Db, ws: Workspace, projectId: string | null = null, fetchImpl?: FetchLike): Promise<RunOutcome> {
  return withRun(db, ws, 'search_sync', { projectId }, async (ctx) => {
    const r = await syncAllSearch(db, ws, config.appUrl, { projectId, fetchImpl })
    if (r.errors.length) ctx.log.push(...r.errors)
    if (!r.projects) return { status: 'skipped', summary: 'Keine Search Console und kein Bing verbunden' }
    return { status: 'ok', summary: `${r.sources.map(x => SEARCH_LABEL[x]).join('- und ') || 'Google'}-Suchdaten geholt: ${r.rows} Zeilen aus ${r.projects - r.errors.length} von ${r.projects} Projekten${r.errors.length ? `, Fehler: ${r.errors[0]}` : ''}` }
  })
}

export async function runSeoAudit(db: Db, ws: Workspace, projectId: string | null = null, deps: { fetchImpl?: FetchLike, llmFetch?: FetchLike, delayMs?: number } = {}): Promise<RunOutcome> {
  return withRun(db, ws, 'seo_audit', { projectId }, async (ctx) => {
    const projects = await db.select().from(schema.projects).where(and(
      eq(schema.projects.workspaceId, ws.id),
      isNull(schema.projects.archivedAt),
      projectId ? eq(schema.projects.id, projectId) : undefined,
      sql`coalesce(${schema.projects.url}, '') <> ''`,
    ))
    if (ws.demo && !projectId) return { status: 'skipped', summary: 'Demo-Arbeitsbereich' }
    if (!projects.length) return { status: 'skipped', summary: 'Kein Projekt mit Website' }
    const key = openAppApiKey(ws, 'google')
    const llm = agentReady(ws) ? workspaceLlm(ws) : null
    const parts: string[] = []
    for (const p of projects) {
      const r = await auditSite(p.url!, { languages: p.languages, pagespeedKey: key, fetchImpl: deps.fetchImpl, delayMs: deps.delayMs })
      await saveAudit(db, p.id, r)
      if (r.error) {
        parts.push(`${p.name}: ${r.error}`)
        continue
      }
      const t = ws.settings?.agentEnabled === false ? { created: 0, closed: 0 } : await seoTasks(db, ws, p, r, { llm, fetchImpl: deps.llmFetch, usage: ctx.usage })
      await logActivity(db, { workspaceId: ws.id, projectId: p.id, actor: 'agent', action: 'seo_checked', detail: { title: p.name, count: r.issues.length, created: t.created }, at: now() })
      parts.push(`${p.name}: ${plural(r.pages.length, 'Seite', 'Seiten')}, ${plural(r.issues.length, 'Problem', 'Probleme')}, ${plural(t.created, 'Aufgabe', 'Aufgaben')} neu, ${t.closed} erledigt`)
    }
    await spreadSelfTasks(db, ws, today(ws.timezone))
    await planByBudget(db, ws, today(ws.timezone))
    return { status: 'ok', summary: `SEO-Prüfung: ${parts.join('; ')}`.slice(0, 500) }
  })
}

export async function runSiteRead(db: Db, ws: Workspace, projectId: string | null = null, deps: { fetchImpl?: FetchLike, delayMs?: number } = {}): Promise<RunOutcome> {
  return withRun(db, ws, 'site_read', { projectId }, async (ctx) => {
    if (ws.demo && !projectId) return { status: 'skipped', summary: 'Demo-Arbeitsbereich' }
    const projects = await db.select({ id: schema.projects.id, name: schema.projects.name, url: schema.projects.url }).from(schema.projects).where(and(
      eq(schema.projects.workspaceId, ws.id),
      isNull(schema.projects.archivedAt),
      projectId ? eq(schema.projects.id, projectId) : undefined,
      sql`coalesce(${schema.projects.url}, '') <> ''`,
    ))
    if (!projects.length) return { status: 'skipped', summary: 'Kein Projekt mit Website' }
    const parts: string[] = []
    for (const p of projects) {
      const r = await readProjectSite(db, p, deps)
      if (r.error) ctx.log.push(`${p.name}: ${r.error}`)
      parts.push(r.pages ? `${p.name}: ${plural(r.pages, 'Seite', 'Seiten')} (${r.external} verlinkte)` : `${p.name}: ${r.error ?? 'nichts gelesen'}`)
    }
    return { status: 'ok', summary: `Website eingelesen: ${parts.join('; ')}`.slice(0, 500) }
  })
}
