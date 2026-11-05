import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { DocumentError } from '../../server/lib/documents'
import { MediaError } from '../../server/lib/media'
import { classifyUpload, uploadHint, UploadError, uploadToProject, uploadToTask } from '../../server/lib/uploads'
import { talkLine } from '../../shared/utils/talk'

const JPG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4])
const pdf = new Uint8Array(readFileSync(new URL('./fixtures/unterlage.pdf', import.meta.url)))

describe('Upload-Validierung im Chat', () => {
  it('trennt Medien und Dokumente', () => {
    expect(classifyUpload({ name: 'foto.jpg', data: JPG })).toBe('media')
    expect(classifyUpload({ name: 'falsch.txt', data: JPG })).toBe('media')
    expect(classifyUpload({ name: 'presse.pdf', data: pdf })).toBe('document')
    expect(classifyUpload({ name: 'notiz.md', data: new TextEncoder().encode('# Hallo') })).toBe('document')
  })

  it('lehnt Unbekanntes und zu große Bilder ab', () => {
    expect(() => classifyUpload({ name: 'x.exe', data: new TextEncoder().encode('MZ') })).toThrow(DocumentError)
    const big = new Uint8Array(8 * 1024 * 1024 + 10)
    big.set(JPG)
    expect(() => classifyUpload({ name: 'riesig.jpg', data: big })).toThrow(MediaError)
  })

  it('Hinweis für den Agenten', () => {
    expect(uploadHint([{ name: 'a.jpg', kind: 'media', where: 'im Fundus' }, { name: 'b.pdf', kind: 'document', where: 'als Unterlage gespeichert' }])).toBe('Datei hochgeladen: a.jpg (im Fundus); b.pdf (als Unterlage gespeichert)')
  })
})

describe('Datei in den Chat ziehen', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  let project: typeof schema.projects.$inferSelect

  beforeAll(async () => {
    process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), 'ma-upload-'))
    ;({ db, close } = await openTestDb())
    ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { agentEnabled: false } }).returning())[0]!
    project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'tv', name: 'The Wanderer', code: 'TV', icon: 'T' }).returning())[0]!
  })
  afterAll(async () => {
    await close()
    delete process.env.MEDIA_DIR
  })

  it('Aufgabe mit Entwurf: Bild an den Entwurf, auf Wunsch auch in den Fundus, Hinweis im Gespräch', async () => {
    const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'TV-1', title: 'Post', category: 'social', draftKind: 'post' }).returning()
    const [draft] = await db.insert(schema.drafts).values({ taskId: task!.id, version: 2, kind: 'post', body: 'Text' }).returning()
    const r = await uploadToTask(db, ws, task!, null, [{ name: 'foto.jpg', data: JPG }, { name: 'presse.pdf', data: pdf }], { fundus: true })
    expect(r.map(x => x.where)).toEqual(['an Entwurf v2 gehängt, auch im Fundus', 'als Unterlage gespeichert'])
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft!.id))
    expect(d!.media.map(m => m.name)).toEqual(['foto.jpg'])
    const fundus = await db.select().from(schema.mediaLibrary).where(eq(schema.mediaLibrary.projectId, project.id))
    expect(fundus.map(f => [f.name, f.checked, f.taskId])).toEqual([['foto.jpg', true, task!.id]])
    expect((await db.select().from(schema.projectDocuments)).map(x => x.name)).toEqual(['presse.pdf'])
    const [note] = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task!.id))
    expect(talkLine(note!.text, false)?.text).toBe('Datei hochgeladen: foto.jpg (an Entwurf v2 gehängt, auch im Fundus); presse.pdf (als Unterlage gespeichert)')
  })

  it('Aufgabe ohne Entwurf: Bild für diese Aufgabe in den Fundus', async () => {
    const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'TV-2', title: 'Post 2', category: 'social', draftKind: 'post' }).returning()
    const r = await uploadToTask(db, ws, task!, null, [{ name: 'neu.jpg', data: JPG }])
    expect(r[0]!.where).toBe('im Fundus, wird beim nächsten Entwurf angehängt')
    const [item] = await db.select().from(schema.mediaLibrary).where(eq(schema.mediaLibrary.taskId, task!.id))
    expect(item!.checked).toBe(true)
  })

  it('ungültige Datei bricht ab, bevor etwas gespeichert wird', async () => {
    const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'TV-3', title: 'Post 3', category: 'social' }).returning()
    await expect(uploadToTask(db, ws, task!, null, [{ name: 'ok.jpg', data: JPG }, { name: 'x.exe', data: new Uint8Array([1, 2]) }])).rejects.toThrow(UploadError)
    expect(await db.select().from(schema.mediaLibrary).where(eq(schema.mediaLibrary.taskId, task!.id))).toEqual([])
    await expect(uploadToTask(db, ws, task!, null, [])).rejects.toThrow('Keine Datei')
  })

  it('Projekt-Chat: Bild in den Fundus, Dokument als Unterlage', async () => {
    const r = await uploadToProject(db, ws, project, null, [{ name: 'chat.jpg', data: JPG }, { name: 'notiz.txt', data: new TextEncoder().encode('Tour ab Mai') }])
    expect(r.map(x => x.where)).toEqual(['im Fundus, geprüft', 'als Unterlage gespeichert, 11 Zeichen Text'])
  })
})
