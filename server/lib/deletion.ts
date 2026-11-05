import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import type { DeletionKind } from '../db/schema'
import { logActivity } from './activity'
import { now } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { extensionDeleteWorkspace } from './extensions'
import { purgeWorkspaceStorage, useStorage } from './storage'
import { queueSystemMail } from './system-mail'
import { updateSettings } from './connections'
import { hostedZernioKey } from './social'
import { cleanupZernioSafe, orphanedHostedAccounts, zernioCleanupOf } from './zernio'

// Löschen von Projekt und eigenem Konto. Die Datenbank löscht abhängige Zeilen per ON DELETE CASCADE; hier kommen dazu:
// Zeilen mit "set null" (Kontakte, Protokolle), Jobs, Dateien im Speicher, gehostete Social-Konten bei Zernio, die sonst
// niemand nutzt, und ein Eintrag im Lösch-Protokoll ohne Inhalte.
// Den Arbeitsbereich löscht der vorhandene Ablauf (gehostet: Einstellungen > Daten, 30 Tage Frist).

export interface DeletionActor {
  userId: string | null
  via?: 'web' | 'app'
}

export class DeletionError extends Error {
  constructor(public status: number, message: string, public data?: unknown) {
    super(message)
  }
}

async function logDeletion(db: DbOrTx, kind: DeletionKind, targetId: string, workspaceId: string | null, actor: DeletionActor, counts: Record<string, number> = {}): Promise<void> {
  await db.insert(schema.deletionLog).values({ kind, targetId, workspaceId, actorUserId: actor.userId, via: actor.via ?? 'web', counts, createdAt: now() })
  console.log(`[loeschen] ${kind} ${targetId} gelöscht von ${actor.userId ?? 'System'} (${actor.via ?? 'web'})`)
}

async function removeKeys(keys: Iterable<string>): Promise<number> {
  const storage = useStorage()
  let n = 0
  for (const k of new Set(keys)) {
    try {
      await storage.remove(k)
      n++
    }
    catch (err) {
      console.error(`[loeschen] Datei ${k} nicht gelöscht: ${(err as Error).message}`)
    }
  }
  return n
}

// Projekt

// Dateien des Projekts: Medien der Entwürfe, Unterlagen, Fundus und alles unter den Projekt- und Entwurfsordnern.
export async function projectFiles(db: DbOrTx, workspaceId: string, projectId: string): Promise<string[]> {
  const keys = new Set<string>()
  const prefixes = [`${workspaceId}/docs/${projectId}/`, `${workspaceId}/fundus/${projectId}/`]
  const taskIds = (await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.projectId, projectId), eq(schema.tasks.workspaceId, workspaceId)))).map(t => t.id)
  if (taskIds.length) {
    for (const d of await db.select({ id: schema.drafts.id, media: schema.drafts.media }).from(schema.drafts).where(inArray(schema.drafts.taskId, taskIds))) {
      prefixes.push(`${workspaceId}/${d.id}/`)
      for (const m of d.media ?? []) keys.add(m.file)
    }
  }
  for (const r of await db.select({ file: schema.projectDocuments.file }).from(schema.projectDocuments).where(eq(schema.projectDocuments.projectId, projectId))) keys.add(r.file)
  for (const r of await db.select({ file: schema.mediaLibrary.file }).from(schema.mediaLibrary).where(eq(schema.mediaLibrary.projectId, projectId))) keys.add(r.file)
  const storage = useStorage()
  for (const p of prefixes) {
    for (const o of await storage.list(p.slice(0, -1)).catch(() => [])) if (o.key.startsWith(p)) keys.add(o.key)
  }
  return [...keys].filter(k => k.startsWith(`${workspaceId}/`))
}

export async function deleteProject(db: Db, workspaceId: string, projectId: string, actor: DeletionActor): Promise<{ name: string, files: number }> {
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, workspaceId)))
  if (!p) throw new DeletionError(404, 'Projekt nicht gefunden')
  const files = await projectFiles(db, workspaceId, projectId)
  const taskIds = (await db.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.projectId, projectId))).map(t => t.id)
  const [ws0] = await db.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))
  const others = await db.select({ setup: schema.projects.setup }).from(schema.projects).where(and(eq(schema.projects.workspaceId, workspaceId), ne(schema.projects.id, projectId)))
  const orphans = !hostedZernioKey() ? [] : orphanedHostedAccounts(ws0?.settings?.social, p.setup?.social, others.map(o => o.setup?.social)).map(a => a.id)
  const counts: Record<string, number> = { tasks: taskIds.length, files: files.length, ...(orphans.length ? { socialAccounts: orphans.length } : {}) }
  await db.transaction(async (tx) => {
    // Zeilen, die beim Löschen des Projekts sonst ohne Projekt stehen blieben.
    await tx.delete(schema.contacts).where(and(eq(schema.contacts.projectId, projectId), eq(schema.contacts.workspaceId, workspaceId)))
    await tx.delete(schema.activity).where(and(eq(schema.activity.projectId, projectId), eq(schema.activity.workspaceId, workspaceId)))
    await tx.delete(schema.agentRuns).where(and(eq(schema.agentRuns.projectId, projectId), eq(schema.agentRuns.workspaceId, workspaceId)))
    await tx.delete(schema.mcpCalls).where(and(eq(schema.mcpCalls.projectId, projectId), eq(schema.mcpCalls.workspaceId, workspaceId)))
    const ids = sql.join([projectId, ...taskIds].map(id => sql`${id}`), sql`, `)
    await tx.delete(schema.jobs).where(and(eq(schema.jobs.workspaceId, workspaceId), ne(schema.jobs.status, 'running'), sql`(${schema.jobs.payload}->>'projectId' = ${projectId} or ${schema.jobs.payload}->>'taskId' in (${ids}))`))
    await tx.delete(schema.notifications).where(and(eq(schema.notifications.workspaceId, workspaceId), sql`${schema.notifications.payload}->>'projectId' = ${projectId}`))
    await tx.delete(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, workspaceId)))
    const [ws] = await tx.select({ settings: schema.workspaces.settings }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))
    const s = ws?.settings
    if (s && (s.mcpApprove?.offProjects?.includes(projectId) || s.oauthStates?.some(o => o.projectId === projectId))) {
      const next = {
        ...s,
        ...(s.mcpApprove ? { mcpApprove: { ...s.mcpApprove, offProjects: (s.mcpApprove.offProjects ?? []).filter(x => x !== projectId) } } : {}),
        ...(s.oauthStates ? { oauthStates: s.oauthStates.filter(o => o.projectId !== projectId) } : {}),
      }
      await tx.update(schema.workspaces).set({ settings: next }).where(eq(schema.workspaces.id, workspaceId))
    }
    await logActivity(tx, { workspaceId, actor: 'user', userId: actor.userId, action: 'project_deleted', detail: { title: p.name }, at: now() })
    await logDeletion(tx, 'project', projectId, workspaceId, actor, counts)
  })
  const removed = await removeKeys(files)
  if (orphans.length) {
    const gone = new Set(orphans)
    await updateSettings(db, workspaceId, s => ({ ...s, social: { ...s.social, accounts: (s.social?.accounts ?? []).filter(a => !gone.has(a.id)) } }))
    await cleanupZernioSafe(db, { accountIds: orphans }, `Projekt ${projectId}`)
  }
  return { name: p.name, files: removed }
}

// Arbeitsbereich des alleinigen Mitglieds beim Löschen des Kontos: mit dem Ablauf der Erweiterung (gehostet: vorgemerkt,
// Abo endet, nach 30 Tagen endgültig weg). Ohne Erweiterung (Selbstbetrieb) sofort samt Dateien.
export async function deleteSoleWorkspace(db: Db, workspaceId: string, actor: DeletionActor): Promise<'scheduled' | 'deleted'> {
  if (await extensionDeleteWorkspace(db, { workspaceId, notify: false })) {
    await logDeletion(db, 'workspace', workspaceId, workspaceId, actor, { scheduled: 1 })
    return 'scheduled'
  }
  const zernio = await zernioCleanupOf(db, workspaceId)
  await db.transaction(async (tx) => {
    await tx.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))
    await logDeletion(tx, 'workspace', workspaceId, workspaceId, actor)
  })
  await purgeWorkspaceStorage(workspaceId).catch(err => console.error(`[loeschen] Dateien von ${workspaceId} nicht gelöscht: ${(err as Error).message}`))
  await cleanupZernioSafe(db, zernio, `Arbeitsbereich ${workspaceId}`)
  return 'deleted'
}

// Eigenes Konto

export interface AccountPlanItem {
  id: string
  name: string
  role: string
  members: number
}

export interface AccountPlan {
  leave: AccountPlanItem[]
  remove: AccountPlanItem[]
  blocked: AccountPlanItem[]
}

// Was mit den Arbeitsbereichen passiert: verlassen, mitlöschen (alleiniges Mitglied) oder blockiert (alleiniger Inhaber mit weiteren Mitgliedern).
export async function accountDeletionPlan(db: DbOrTx, userId: string): Promise<AccountPlan> {
  const rows = await db.execute(sql`
    select w.id, w.name, m.role,
      (select count(*)::int from memberships x where x.workspace_id = w.id) as members,
      (select count(*)::int from memberships x where x.workspace_id = w.id and x.role = 'owner') as owners
    from memberships m join workspaces w on w.id = m.workspace_id
    where m.user_id = ${userId}
    order by w.name`)
  const plan: AccountPlan = { leave: [], remove: [], blocked: [] }
  for (const r of (rows as unknown as { rows: { id: string, name: string, role: string, members: number, owners: number }[] }).rows) {
    const item = { id: r.id, name: r.name, role: r.role, members: Number(r.members) }
    if (item.members <= 1) plan.remove.push(item)
    else if (r.role === 'owner' && Number(r.owners) <= 1) plan.blocked.push(item)
    else plan.leave.push(item)
  }
  return plan
}

export async function deleteAccount(db: Db, userId: string, actor: DeletionActor): Promise<{ plan: AccountPlan }> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId))
  if (!user) throw new DeletionError(404, 'Konto nicht gefunden')
  const plan = await accountDeletionPlan(db, userId)
  if (plan.blocked.length) {
    throw new DeletionError(409, `Du bist alleiniger Inhaber von ${plan.blocked.map(b => b.name).join(', ')}. Übertrage dort zuerst die Inhaberschaft unter Team.`, { blocked: plan.blocked })
  }
  for (const w of plan.remove) await deleteSoleWorkspace(db, w.id, actor)
  await db.transaction(async (tx) => {
    await tx.delete(schema.users).where(eq(schema.users.id, userId))
    await logDeletion(tx, 'account', userId, null, actor, { left: plan.leave.length, workspaces: plan.remove.length })
  })
  if (user.email.includes('@')) {
    const en = user.locale === 'en'
    await queueSystemMail(db, user.email, 'generic-notice', {
      name: user.name,
      subject: en ? 'Your Aimarage account was deleted' : 'Dein Aimarage-Konto ist gelöscht',
      body: en
        ? `Your account ${user.email} was deleted with passkeys, sessions and API keys.${plan.leave.length ? ` You left: ${plan.leave.map(w => w.name).join(', ')}.` : ''}${plan.remove.length ? ` Workspaces where you were the only member are deleted: ${plan.remove.map(w => w.name).join(', ')}.` : ''}`
        : `Dein Konto ${user.email} ist mit Passkeys, Sitzungen und API-Schlüsseln gelöscht.${plan.leave.length ? ` Verlassen: ${plan.leave.map(w => w.name).join(', ')}.` : ''}${plan.remove.length ? ` Arbeitsbereiche, in denen du allein warst, werden gelöscht: ${plan.remove.map(w => w.name).join(', ')}.` : ''}`,
    }, user.locale, { dedupeKey: `account_deleted:${userId}` })
  }
  return { plan }
}
