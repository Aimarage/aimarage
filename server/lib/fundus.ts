import { and, desc, eq, sql } from 'drizzle-orm'
import type { DraftMedia } from '../db/schema'
import { logActivity } from './activity'
import { now } from './clock'
import type { Db, DbOrTx } from './db'
import { schema } from './db'
import { words } from './documents'
import { assertStorage } from './limits'
import { MAX_MEDIA_PER_DRAFT, MediaError, copyMedia, fetchImage, removeFile, storeMedia } from './media'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
export type FundusItem = typeof schema.mediaLibrary.$inferSelect

export const MAX_FUNDUS_PER_PROJECT = 500

export function cleanTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\n]/) : []
  return [...new Set(list.map(t => String(t).trim().toLowerCase().replace(/^#/, '').replace(/[\u2013\u2014]/g, '-').slice(0, 40)).filter(Boolean))].slice(0, 12)
}

export function cleanDescription(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/[\u2013\u2014]/g, '-').slice(0, 500) : ''
}

export async function addFundusItem(db: Db, ws: Workspace, project: Pick<Project, 'id'>, input: { name: string, data: Uint8Array, description?: string, tags?: string[], checked?: boolean, source?: string | null, taskId?: string | null, userId?: string | null }): Promise<FundusItem> {
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.mediaLibrary).where(eq(schema.mediaLibrary.projectId, project.id))
  if (n >= MAX_FUNDUS_PER_PROJECT) throw new MediaError(`Fundus ist voll (höchstens ${MAX_FUNDUS_PER_PROJECT} Dateien)`)
  await assertStorage(db, ws, input.data.byteLength)
  const m = await storeMedia([ws.id, 'fundus', project.id], input)
  const [row] = await db.insert(schema.mediaLibrary).values({
    workspaceId: ws.id,
    projectId: project.id,
    taskId: input.taskId ?? null,
    name: m.name,
    mime: m.mime,
    size: m.size,
    file: m.file,
    description: cleanDescription(input.description),
    tags: cleanTags(input.tags ?? []),
    checked: !!input.checked,
    source: input.source ?? null,
    createdByUserId: input.userId ?? null,
    createdAt: now(),
  }).returning()
  return row!
}

export async function listFundus(db: DbOrTx, projectId: string, opts: { checkedOnly?: boolean } = {}): Promise<FundusItem[]> {
  return db.select().from(schema.mediaLibrary).where(and(eq(schema.mediaLibrary.projectId, projectId), opts.checkedOnly ? eq(schema.mediaLibrary.checked, true) : undefined)).orderBy(desc(schema.mediaLibrary.createdAt)).limit(MAX_FUNDUS_PER_PROJECT)
}

export async function updateFundusItem(db: Db, item: FundusItem, patch: { description?: unknown, tags?: unknown, checked?: unknown }): Promise<FundusItem> {
  const set: Partial<typeof schema.mediaLibrary.$inferInsert> = {}
  if (patch.description !== undefined) set.description = cleanDescription(patch.description)
  if (patch.tags !== undefined) set.tags = cleanTags(patch.tags)
  if (typeof patch.checked === 'boolean') set.checked = patch.checked
  if (!Object.keys(set).length) return item
  const [row] = await db.update(schema.mediaLibrary).set(set).where(eq(schema.mediaLibrary.id, item.id)).returning()
  return row!
}

export async function deleteFundusItem(db: Db, item: FundusItem): Promise<void> {
  await db.delete(schema.mediaLibrary).where(eq(schema.mediaLibrary.id, item.id))
  await removeFile(item.file).catch(() => {})
}

export interface PickInput {
  text: string
  taskId?: string | null
  kind?: 'image' | 'video' | null
  need?: boolean
}

type Pickable = Pick<FundusItem, 'id' | 'mime' | 'description' | 'tags' | 'checked' | 'usedCount' | 'taskId' | 'name'>

export function fundusScore(item: Pickable, q: Set<string>, input: PickInput): number {
  if (!item.checked) return -1
  if (input.taskId && item.taskId === input.taskId) return 1000
  let score = 0
  for (const tag of item.tags) {
    const tw = words(tag)
    if (tw.size && [...tw].every(w => q.has(w))) score += 3
  }
  const d = words(`${item.description} ${item.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ')}`)
  for (const w of d) if (q.has(w)) score += 1
  return score
}

export function pickFundus<T extends Pickable>(items: T[], input: PickInput): T | null {
  const q = words(input.text)
  const kind = input.kind ?? null
  const pool = items.filter(i => i.checked && (!kind || i.mime.startsWith(`${kind}/`)))
  if (!pool.length) return null
  const ranked = pool.map(item => ({ item, score: fundusScore(item, q, input) })).sort((a, b) => b.score - a.score || a.item.usedCount - b.item.usedCount)
  const best = ranked[0]!
  if (best.score > 0) return best.item
  if (!input.need) return null
  return [...pool].sort((a, b) => a.usedCount - b.usedCount)[0] ?? null
}

export async function attachFundusItem(db: Db, ws: Workspace, draft: Pick<typeof schema.drafts.$inferSelect, 'id' | 'media'>, item: FundusItem): Promise<DraftMedia[]> {
  if (draft.media.length >= MAX_MEDIA_PER_DRAFT) throw new MediaError(`Höchstens ${MAX_MEDIA_PER_DRAFT} Dateien`)
  const m = await copyMedia(ws.id, draft.id, item)
  const media = [...draft.media, m]
  await db.update(schema.drafts).set({ media }).where(eq(schema.drafts.id, draft.id))
  await db.update(schema.mediaLibrary).set({ usedCount: sql`${schema.mediaLibrary.usedCount} + 1`, lastUsedAt: now() }).where(eq(schema.mediaLibrary.id, item.id))
  return media
}

export async function suggestFromFundus(db: Db, ws: Workspace, task: Pick<typeof schema.tasks.$inferSelect, 'id' | 'projectId' | 'title' | 'description' | 'channel'>, draftId: string, opts: { body: string, kind?: 'image' | 'video' | null, need?: boolean, log?: string[] }): Promise<FundusItem | null> {
  if (!task.projectId) return null
  try {
    const items = await listFundus(db, task.projectId, { checkedOnly: true })
    const pick = pickFundus(items, { text: [task.title, task.description ?? '', task.channel ?? '', opts.body].join('\n'), taskId: task.id, kind: opts.kind, need: opts.need })
    if (!pick) return null
    const [draft] = await db.select({ id: schema.drafts.id, media: schema.drafts.media }).from(schema.drafts).where(eq(schema.drafts.id, draftId))
    if (!draft || draft.media.length) return null
    await attachFundusItem(db, ws, draft, pick)
    await db.insert(schema.taskNotes).values({ taskId: task.id, byAgent: true, text: `${pick.mime.startsWith('video/') ? 'Video' : 'Bild'} aus dem Fundus angehängt: ${pick.name}${pick.description ? ` (${pick.description})` : ''}. Passt es nicht, in der Freigabe entfernen oder ein anderes wählen.`, createdAt: now() })
    return pick
  }
  catch (err) {
    opts.log?.push(`Fundus-Bild nicht übernommen: ${(err as Error).message.slice(0, 200)}`)
    return null
  }
}

export function guessFromUrl(url: string, prefix = ''): { description: string, tags: string[] } {
  const base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').replace(/\.[a-z0-9]+$/i, '')
  const parts = base.split(/[-_]+/).filter(Boolean)
  const label = parts.join(' ')
  return { description: [prefix, label].filter(Boolean).join(' - '), tags: cleanTags([...words(label)]) }
}

export type ImageFetcher = (url: string) => Promise<{ name: string, data: Uint8Array } | null>

export async function importFundusFromUrls(db: Db, ws: Workspace, project: Project, urls: string[], opts: { checked?: boolean, tags?: string[], prefix?: string, userId?: string | null, fetcher?: ImageFetcher } = {}): Promise<{ added: FundusItem[], skipped: { url: string, reason: string }[] }> {
  const fetcher = opts.fetcher ?? (u => fetchImage(u))
  const existing = new Set((await listFundus(db, project.id)).map(i => i.source).filter(Boolean))
  const added: FundusItem[] = []
  const skipped: { url: string, reason: string }[] = []
  for (const url of urls) {
    if (existing.has(url)) {
      skipped.push({ url, reason: 'schon im Fundus' })
      continue
    }
    try {
      const img = await fetcher(url)
      if (!img) {
        skipped.push({ url, reason: 'nicht abrufbar oder kein Bild' })
        continue
      }
      const g = guessFromUrl(url, opts.prefix ?? project.name)
      added.push(await addFundusItem(db, ws, project, { name: img.name, data: img.data, description: g.description, tags: [...(opts.tags ?? []), ...g.tags], checked: opts.checked ?? false, source: url, userId: opts.userId ?? null }))
    }
    catch (err) {
      skipped.push({ url, reason: (err as Error).message.slice(0, 200) })
    }
  }
  if (added.length) await logActivity(db, { workspaceId: ws.id, projectId: project.id, actor: 'system', action: 'fundus_imported', detail: { title: project.name, count: added.length }, at: now() })
  return { added, skipped }
}

export function fundusView(i: FundusItem) {
  return { id: i.id, name: i.name, mime: i.mime, kind: i.mime.startsWith('video/') ? 'video' as const : 'image' as const, size: i.size, description: i.description, tags: i.tags, checked: i.checked, source: i.source, taskId: i.taskId, usedCount: i.usedCount, createdAt: i.createdAt.toISOString() }
}
