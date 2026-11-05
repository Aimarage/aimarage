import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { ALL_SLUG } from '../../shared/utils/domain'
import { normalizeTaskCode, type SearchHit, type SearchResult } from '../../shared/utils/global-search'
import { projectCond, type Access } from './access'
import type { DbOrTx } from './db'
import { schema } from './db'

const MAX = 8

function pattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`
}

function excerpt(text: string, q: string, len = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = flat.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0 || flat.length <= len) return flat.slice(0, len)
  const start = Math.max(0, at - 24)
  return `${start > 0 ? '...' : ''}${flat.slice(start, start + len)}`
}

function fill(tasks: SearchHit[], drafts: SearchHit[], projects: SearchHit[]) {
  const p = projects.slice(0, 2)
  const rest = MAX - p.length
  const t = tasks.slice(0, rest - Math.min(drafts.length, 3))
  return { tasks: t, drafts: drafts.slice(0, rest - t.length), projects: p }
}

export async function globalSearch(db: DbOrTx, workspaceId: string, access: Access, raw: string): Promise<SearchResult> {
  const q = raw.trim()
  const empty: SearchResult = { exact: null, tasks: [], drafts: [], projects: [] }
  if (q.length < 2) return empty
  const like = pattern(q)
  const projects = await db.select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name, code: schema.projects.code, archivedAt: schema.projects.archivedAt }).from(schema.projects)
    .where(and(eq(schema.projects.workspaceId, workspaceId), projectCond(access, schema.projects.id, false)))
  const slugOf = new Map(projects.map(p => [p.id, p.slug]))
  const base = (projectId: string | null) => `/p/${(projectId && slugOf.get(projectId)) || ALL_SLUG}`
  const visible = projectCond(access, schema.tasks.projectId)

  const codes = [...new Set([normalizeTaskCode(q), q.toUpperCase().replace(/\s+/g, '-')].filter((c): c is string => !!c && /^[A-Z0-9]+(-[A-Z0-9]+)+$/.test(c)))]
  let exact: SearchHit | null = null
  if (codes.length) {
    const [t] = await db.select({ id: schema.tasks.id, code: schema.tasks.code, title: schema.tasks.title, projectId: schema.tasks.projectId }).from(schema.tasks)
      .where(and(eq(schema.tasks.workspaceId, workspaceId), inArray(sql`upper(${schema.tasks.code})`, codes), visible))
      .limit(1)
    if (t) exact = { id: t.id, label: t.title, code: t.code, to: `${base(t.projectId)}/aufgaben/${t.id}` }
  }

  const taskRows = await db.select({ id: schema.tasks.id, code: schema.tasks.code, title: schema.tasks.title, projectId: schema.tasks.projectId }).from(schema.tasks)
    .where(and(eq(schema.tasks.workspaceId, workspaceId), visible, or(ilike(schema.tasks.title, like), ilike(schema.tasks.code, like), ilike(schema.tasks.description, like))))
    .orderBy(sql`case when ${schema.tasks.code} ilike ${like} then 0 when ${schema.tasks.title} ilike ${like} then 1 else 2 end`, desc(schema.tasks.updatedAt))
    .limit(MAX)
  const tasks: SearchHit[] = taskRows.filter(t => t.id !== exact?.id).map(t => ({ id: t.id, label: t.title, code: t.code, to: `${base(t.projectId)}/aufgaben/${t.id}` }))
  if (exact) tasks.unshift(exact)

  const draftRows = await db.select({ id: schema.drafts.id, subject: schema.drafts.subject, body: schema.drafts.body, taskId: schema.tasks.id, code: schema.tasks.code, projectId: schema.tasks.projectId }).from(schema.drafts)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId))
    .where(and(eq(schema.tasks.workspaceId, workspaceId), visible, inArray(schema.drafts.status, ['offen', 'freigegeben', 'verworfen']), or(ilike(schema.drafts.body, like), ilike(schema.drafts.subject, like))))
    .orderBy(desc(schema.drafts.createdAt))
    .limit(MAX * 3)
  const seen = new Set<string>()
  const drafts: SearchHit[] = []
  for (const d of draftRows) {
    if (seen.has(d.taskId)) continue
    seen.add(d.taskId)
    const inSubject = d.subject && d.subject.toLowerCase().includes(q.toLowerCase())
    drafts.push({ id: d.id, label: excerpt(inSubject ? d.subject! : d.body, q), code: d.code, to: `${base(d.projectId)}/freigaben/${d.id}` })
  }

  const ql = q.toLowerCase()
  const projectHits: SearchHit[] = projects
    .filter(p => !p.archivedAt && (p.name.toLowerCase().includes(ql) || p.slug.toLowerCase().includes(ql) || p.code.toLowerCase() === ql))
    .map(p => ({ id: p.id, label: p.name, code: p.code, to: `/p/${p.slug}` }))

  return { exact, ...fill(tasks, drafts, projectHits) }
}
