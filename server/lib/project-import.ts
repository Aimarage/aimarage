import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { AUTONOMY_KINDS, FIXED_APPROVAL } from '../../shared/utils/plan'
import { PROJECT_COLORS } from '../../shared/utils/domain'
import { logActivity } from './activity'
import { today } from './clock'
import type { Db } from './db'
import { schema } from './db'
import { saveGoals } from './goals'
import { createProjectRecord } from './onboarding'

export const projectImportSchema = z.object({
  name: z.string().trim().min(1).max(60),
  url: z.string().max(300).nullable().optional(),
  color: z.enum(PROJECT_COLORS).optional(),
  description: z.string().max(2000).nullable().optional(),
  languages: z.array(z.string().min(2).max(5)).max(5).optional(),
  tonality: z.string().max(500).nullable().optional(),
  rules: z.string().max(10_000).nullable().optional(),
  budget: z.string().max(200).nullable().optional(),
  pacing: z.number().int().min(0).max(20).nullable().optional(),
  autonomy: z.partialRecord(z.enum(AUTONOMY_KINDS), z.enum(['approve', 'auto', 'auto_report'])).optional(),
  analysis: z.object({ positioning: z.string().max(1000).optional(), audiences: z.array(z.string().max(300)).max(8).optional(), communities: z.array(z.string().max(200)).max(20).optional(), channels: z.array(z.string().max(200)).max(20).optional() }).optional(),
  social: z.object({ profileIds: z.array(z.string().max(100)).max(5).optional(), accountIds: z.array(z.string().max(200)).max(50).optional() }).optional(),
  goals: z.array(z.object({ label: z.string().min(1).max(120), metricKey: z.string().max(40).optional(), mode: z.enum(['sum', 'last', 'month']).optional(), targetValue: z.number().nullable().optional(), deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() })).max(10).optional(),
  contacts: z.array(z.object({ name: z.string().min(1).max(200), email: z.string().max(200).nullable().optional(), company: z.string().max(200).nullable().optional(), role: z.string().max(200).nullable().optional(), status: z.enum(['neu', 'kontaktiert', 'warm', 'gesperrt']).optional(), notes: z.string().max(2000).nullable().optional(), source: z.string().max(200).nullable().optional() })).max(300).optional(),
  memory: z.array(z.string().min(1).max(1000)).max(60).optional(),
  members: z.array(z.string().max(200)).max(20).optional(),
})

export type ProjectImport = z.infer<typeof projectImportSchema>

export async function importProject(db: Db, ws: typeof schema.workspaces.$inferSelect, userId: string, input: ProjectImport, slug?: string): Promise<{ id: string, slug: string, contacts: number, goals: number }> {
  const [exists] = slug ? await db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), eq(schema.projects.slug, slug))) : []
  if (exists) throw new Error(`Projekt ${slug} gibt es schon`)
  const p = await createProjectRecord(db, ws, userId, { name: input.name, url: input.url ?? null, description: input.description ?? null, color: input.color ?? null, onboarding: false, budget: input.budget ?? null })
  const autonomy = { ...input.autonomy }
  for (const k of FIXED_APPROVAL) autonomy[k] = 'approve'
  const setup = { ...p.setup, state: 'ready' as const, analysis: input.analysis ?? null, social: input.social ?? null, pacing: input.pacing ? { perPlatformPerDay: input.pacing } : null }
  await db.update(schema.projects).set({ ...(slug ? { slug } : {}), rules: input.rules ?? null, tonality: input.tonality ?? null, languages: input.languages ?? ['en'], autonomy, setup }).where(eq(schema.projects.id, p.id))
  const goals = input.goals?.length ? await saveGoals(db, ws.id, p.id, input.goals.map(g => ({ label: g.label, metricKey: g.metricKey ?? null, mode: g.mode ?? 'sum', targetValue: g.targetValue ?? null, deadline: g.deadline ?? null })), today(ws.timezone)) : []
  const goalKpis = (input.goals ?? []).filter(g => g.metricKey && /^[a-z0-9_]+$/.test(g.metricKey)).slice(0, 3).map(g => ({ key: g.metricKey!, label: g.label.slice(0, 40) }))
  if (goalKpis.length) await db.update(schema.projects).set({ kpis: goalKpis }).where(eq(schema.projects.id, p.id))
  let contacts = 0
  for (const c of input.contacts ?? []) {
    const email = c.email?.trim().toLowerCase() || null
    if (email) {
      const [dup] = await db.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ws.id), sql`lower(${schema.contacts.email}) = ${email}`))
      if (dup) {
        await db.update(schema.contacts).set({ status: c.status ?? 'neu', notes: c.notes ?? null, projectId: p.id }).where(eq(schema.contacts.id, dup.id))
        contacts++
        continue
      }
    }
    await db.insert(schema.contacts).values({ workspaceId: ws.id, projectId: p.id, name: c.name, email, company: c.company ?? null, role: c.role ?? null, status: c.status ?? 'neu', notes: c.notes ?? null, source: c.source ?? 'Import', legalBasis: 'berechtigtes Interesse (Presse/Kuratoren)' })
    contacts++
  }
  for (const m of input.memory ?? []) await db.insert(schema.projectMemory).values({ projectId: p.id, kind: 'fakt', text: m })
  for (const email of input.members ?? []) {
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).innerJoin(schema.memberships, and(eq(schema.memberships.userId, schema.users.id), eq(schema.memberships.workspaceId, ws.id))).where(sql`lower(${schema.users.email}) = ${email.toLowerCase()}`)
    if (u && u.id !== userId) await db.insert(schema.projectMembers).values({ projectId: p.id, userId: u.id, role: 'owner' }).onConflictDoNothing()
  }
  await logActivity(db, { workspaceId: ws.id, projectId: p.id, actor: 'user', userId, action: 'project_imported', detail: { title: input.name, contacts, goals: goals.length } })
  return { id: p.id, slug: slug ?? p.slug, contacts, goals: goals.length }
}
