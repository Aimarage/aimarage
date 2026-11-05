import { and, desc, eq, inArray } from 'drizzle-orm'
import { TALK_PREFIX } from '../../shared/utils/talk'
import { logActivity } from './activity'
import { now } from './clock'
import type { Db } from './db'
import { schema } from './db'
import { DocumentError, saveDocument, validateDocument } from './documents'
import { addFundusItem } from './fundus'
import { assertStorage } from './limits'
import { checkMedia, MAX_MEDIA_PER_DRAFT, MediaError, saveMedia, sniff } from './media'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect
type Task = typeof schema.tasks.$inferSelect

export interface UploadFile {
  name: string
  data: Uint8Array
}

export class UploadError extends Error {}

export const MAX_UPLOAD_FILES = 10

export function classifyUpload(f: UploadFile): 'media' | 'document' {
  if (sniff(f.data)) {
    checkMedia(f.data)
    return 'media'
  }
  validateDocument(f.name, f.data)
  return 'document'
}

function fail(err: unknown): never {
  if (err instanceof MediaError || err instanceof DocumentError) throw new UploadError(err.message)
  throw err
}

export interface UploadResult {
  name: string
  kind: 'media' | 'document'
  where: string
}

export function uploadHint(results: UploadResult[]): string {
  return `Datei hochgeladen: ${results.map(r => `${r.name} (${r.where})`).join('; ')}`
}

export async function uploadToTask(db: Db, ws: Workspace, task: Task, userId: string | null, files: UploadFile[], opts: { fundus?: boolean } = {}): Promise<UploadResult[]> {
  if (!files.length) throw new UploadError('Keine Datei')
  if (files.length > MAX_UPLOAD_FILES) throw new UploadError(`Höchstens ${MAX_UPLOAD_FILES} Dateien auf einmal`)
  if (!task.projectId) throw new UploadError('Aufgabe gehört zu keinem Projekt')
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId))
  if (!project) throw new UploadError('Projekt nicht gefunden')
  const kinds = files.map((f) => {
    try {
      return classifyUpload(f)
    }
    catch (err) {
      return fail(err)
    }
  })
  const results: UploadResult[] = []
  for (const [i, f] of files.entries()) {
    try {
      if (kinds[i] === 'document') {
        const doc = await saveDocument(db, ws, project, { name: f.name, data: f.data, userId })
        results.push({ name: doc.name, kind: 'document', where: 'als Unterlage gespeichert' })
        continue
      }
      const [draft] = await db.select().from(schema.drafts).where(and(eq(schema.drafts.taskId, task.id), inArray(schema.drafts.status, ['offen', 'freigegeben']))).orderBy(desc(schema.drafts.version)).limit(1)
      if (draft && draft.media.length < MAX_MEDIA_PER_DRAFT) {
        await assertStorage(db, ws, f.data.byteLength)
        const m = await saveMedia(ws.id, draft.id, f)
        await db.update(schema.drafts).set({ media: [...draft.media, m] }).where(eq(schema.drafts.id, draft.id))
        if (opts.fundus) await addFundusItem(db, ws, project, { name: f.name, data: f.data, checked: true, source: 'chat', taskId: task.id, userId })
        results.push({ name: m.name, kind: 'media', where: `an Entwurf v${draft.version} gehängt${opts.fundus ? ', auch im Fundus' : ''}` })
      }
      else {
        const item = await addFundusItem(db, ws, project, { name: f.name, data: f.data, checked: true, source: 'chat', taskId: task.id, userId })
        results.push({ name: item.name, kind: 'media', where: draft ? 'im Fundus, Entwurf hat schon die Höchstzahl an Dateien' : 'im Fundus, wird beim nächsten Entwurf angehängt' })
      }
    }
    catch (err) {
      fail(err)
    }
  }
  const at = now()
  await db.insert(schema.taskNotes).values({ taskId: task.id, userId, text: `${TALK_PREFIX.user} ${uploadHint(results)}`, createdAt: at })
  await logActivity(db, { workspaceId: ws.id, projectId: task.projectId, taskId: task.id, actor: 'user', userId, action: 'note_added', detail: { title: task.title }, at })
  return results
}

export async function uploadToProject(db: Db, ws: Workspace, project: Project, userId: string | null, files: UploadFile[], opts: { fundus?: boolean } = {}): Promise<UploadResult[]> {
  if (!files.length) throw new UploadError('Keine Datei')
  if (files.length > MAX_UPLOAD_FILES) throw new UploadError(`Höchstens ${MAX_UPLOAD_FILES} Dateien auf einmal`)
  const kinds = files.map((f) => {
    try {
      return classifyUpload(f)
    }
    catch (err) {
      return fail(err)
    }
  })
  const results: UploadResult[] = []
  for (const [i, f] of files.entries()) {
    try {
      if (kinds[i] === 'document') {
        const doc = await saveDocument(db, ws, project, { name: f.name, data: f.data, userId })
        results.push({ name: doc.name, kind: 'document', where: doc.text ? `als Unterlage gespeichert, ${doc.text.length} Zeichen Text` : 'als Unterlage gespeichert, kein Text gefunden' })
      }
      else {
        const item = await addFundusItem(db, ws, project, { name: f.name, data: f.data, checked: opts.fundus !== false, source: 'chat', userId })
        results.push({ name: item.name, kind: 'media', where: item.checked ? 'im Fundus, geprüft' : 'im Fundus, noch nicht geprüft' })
      }
    }
    catch (err) {
      fail(err)
    }
  }
  return results
}
