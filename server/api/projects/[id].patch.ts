import { and, eq } from 'drizzle-orm'
import { PROJECT_COLORS } from '~~/shared/utils/domain'
import { AUTONOMY_KINDS, DRAFT_AHEAD_MAX, FIXED_APPROVAL } from '~~/shared/utils/plan'
import { LISTEN_MODES } from '~~/shared/utils/listening'
import { AUTO_READY } from '~~/server/lib/listening'
import { now, today } from '~~/server/lib/clock'
import { getDb, schema } from '~~/server/lib/db'
import { assertPlatformFree } from '~~/server/lib/limits'
import { closeBlogSetup } from '~~/server/lib/plan-guard'
import { activeStrategy, applyStrategy } from '~~/server/lib/strategy'

const body = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  code: z.string().trim().min(2).max(5).regex(/^[A-Za-z0-9]+$/).optional(),
  color: z.enum(PROJECT_COLORS).optional(),
  icon: z.string().trim().min(1).max(3).optional(),
  url: httpUrl(300).nullable().optional().or(z.literal('').transform(() => null)),
  blog: httpUrl(300).nullable().optional().or(z.literal('').transform(() => null)),
  description: z.string().max(2000).nullable().optional(),
  tonality: z.string().max(2000).nullable().optional(),
  languages: z.array(z.string().min(2).max(5)).max(10).optional(),
  kpis: z.array(z.object({ key: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/), label: z.string().trim().min(1).max(40) })).max(6).optional(),
  archived: z.boolean().optional(),
  autonomy: z.record(z.enum(AUTONOMY_KINDS), z.enum(['approve', 'auto', 'auto_report'])).optional(),
  rules: z.string().max(10_000).nullable().optional(),
  pacing: z.number().int().min(0).max(20).nullable().optional(),
  draftAhead: z.number().int().min(1).max(DRAFT_AHEAD_MAX).nullable().optional(),
  facts: z.object({ known: z.array(z.string().trim().min(1).max(300)).max(30), avoid: z.array(z.string().trim().min(1).max(300)).max(30) }).optional(),
  listening: z.enum(LISTEN_MODES).optional(),
  social: z.object({ profileIds: z.array(z.string().max(100)).max(20), accountIds: z.array(z.string().max(200)).max(100) }).optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  const db = await getDb()
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const { archived, autonomy, social, pacing, draftAhead, facts, blog, listening, ...rest } = input
  const set: Partial<typeof schema.projects.$inferInsert> = { ...rest }
  if (pacing !== undefined) {
    const [cur] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
    if (!cur) throw createError({ statusCode: 404 })
    set.setup = { ...cur.setup, ...set.setup, pacing: pacing ? { perPlatformPerDay: pacing } : null }
  }
  if (draftAhead !== undefined) {
    const [cur] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
    if (!cur) throw createError({ statusCode: 404 })
    set.setup = { ...cur.setup, ...set.setup, draftAhead }
  }
  if (facts) {
    const [cur] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
    if (!cur) throw createError({ statusCode: 404 })
    const dash = (v: string) => v.replace(/[\u2013\u2014]/g, '-')
    set.setup = { ...cur.setup, ...set.setup, facts: { known: facts.known.map(dash), avoid: facts.avoid.map(dash) } }
  }
  if (blog !== undefined) {
    const [cur] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
    if (!cur) throw createError({ statusCode: 404 })
    set.setup = { ...cur.setup, ...set.setup, blog }
  }
  if (listening) {
    if (listening === 'auto' && !AUTO_READY) throw createError({ statusCode: 400, statusMessage: 'Automatisch kommt mit dem KI-Prüfer' })
    const [cur] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
    if (!cur) throw createError({ statusCode: 404 })
    const prev = { ...cur.setup, ...set.setup }
    set.setup = { ...prev, listening: { ...prev.listening, mode: listening, ...(listening !== 'off' ? { pausedUntil: null, pauseReason: null } : {}) } }
  }
  if (social) {
    const [cur] = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
    if (!cur) throw createError({ statusCode: 404 })
    assertPlatformFree(s.workspace, cur.setup?.social, social)
    set.setup = { ...cur.setup, ...set.setup, social }
  }
  if (autonomy) {
    const [cur] = await db.select({ a: schema.projects.autonomy }).from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
    const next = { ...cur?.a, ...autonomy }
    for (const k of FIXED_APPROVAL) next[k] = 'approve'
    set.autonomy = next
  }
  if (rest.code) set.code = rest.code.toUpperCase()
  if (rest.icon) set.icon = rest.icon.toUpperCase()
  if (archived !== undefined) set.archivedAt = archived ? now() : null
  const rows = await db.update(schema.projects).set(set).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id))).returning({ id: schema.projects.id })
  if (!rows.length) throw createError({ statusCode: 404 })
  if (blog) {
    await closeBlogSetup(db, id, now())
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, id))
    const active = await activeStrategy(db, id)
    if (project && active) await applyStrategy(db, project, active, today(s.workspace.timezone))
  }
  return { ok: true }
})
