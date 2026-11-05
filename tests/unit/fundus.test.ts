import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { addFundusItem, attachFundusItem, cleanTags, deleteFundusItem, guessFromUrl, importFundusFromUrls, listFundus, pickFundus, suggestFromFundus, updateFundusItem } from '../../server/lib/fundus'
import { checkMedia, MediaError, fileExists } from '../../server/lib/media'

const JPG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4])
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D])

const item = (o: Partial<{ id: string, mime: string, description: string, tags: string[], checked: boolean, usedCount: number, taskId: string | null, name: string }>) => ({ id: 'x', mime: 'image/jpeg', description: '', tags: [], checked: true, usedCount: 0, taskId: null, name: 'bild.jpg', ...o })

describe('Upload prüfen (Medien)', () => {
  it('nur echte Bilder und Videos, Größe je Art', () => {
    expect(checkMedia(JPG).mime).toBe('image/jpeg')
    expect(checkMedia(MP4).kind).toBe('video')
    expect(() => checkMedia(new TextEncoder().encode('%PDF-1.7'))).toThrow(MediaError)
    const big = new Uint8Array(8 * 1024 * 1024 + 1)
    big.set(PNG)
    expect(() => checkMedia(big)).toThrow(/zu groß/)
  })

  it('Tags säubern', () => {
    expect(cleanTags('Presse, #Studio,presse ; Weiß\u2014Licht')).toEqual(['presse', 'studio', 'weiß-licht'])
    expect(cleanTags(['a', '', '  b  '])).toEqual(['a', 'b'])
    expect(cleanTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length).toBe(12)
  })
})

describe('Fundus-Auswahl', () => {
  const items = [
    item({ id: 'studio', description: 'Band im weißen Studio', tags: ['studio', 'presse'] }),
    item({ id: 'live', description: 'Konzert in Wien, Bühne mit Licht', tags: ['live', 'konzert'] }),
    item({ id: 'video', mime: 'video/mp4', description: 'Teaser zum Album', tags: ['album', 'teaser'] }),
    item({ id: 'ungeprueft', description: 'Konzert Wien Backstage', tags: ['konzert', 'wien'], checked: false }),
  ]

  it('wählt nach Tags und Beschreibung, nie ungeprüfte', () => {
    expect(pickFundus(items, { text: 'Heute Abend Konzert in Wien!' })?.id).toBe('live')
    expect(pickFundus(items, { text: 'Neues Pressefoto aus dem Studio' })?.id).toBe('studio')
    expect(pickFundus(items, { text: 'Backstage' })).toBeNull()
  })

  it('beachtet die Art (Bild oder Video)', () => {
    expect(pickFundus(items, { text: 'Album Teaser', kind: 'image' })).toBeNull()
    expect(pickFundus(items, { text: 'Album Teaser', kind: 'video' })?.id).toBe('video')
    expect(pickFundus(items, { text: 'Album Teaser' })?.id).toBe('video')
  })

  it('ohne Treffer nur, wenn ein Medium nötig ist, dann das am wenigsten benutzte', () => {
    const list = [item({ id: 'a', usedCount: 3, description: 'Logo' }), item({ id: 'b', usedCount: 1, description: 'Portrait' })]
    expect(pickFundus(list, { text: 'Steuertipps' })).toBeNull()
    expect(pickFundus(list, { text: 'Steuertipps', need: true })?.id).toBe('b')
  })

  it('für die Aufgabe hochgeladenes Medium hat Vorrang, bei Gleichstand das seltener benutzte', () => {
    const list = [item({ id: 'a', tags: ['wien'], usedCount: 5 }), item({ id: 'b', tags: ['wien'], usedCount: 0 }), item({ id: 'c', taskId: 'T1' })]
    expect(pickFundus(list, { text: 'Wien', taskId: 'T1' })?.id).toBe('c')
    expect(pickFundus(list, { text: 'Wien' })?.id).toBe('b')
  })

  it('Beschreibung und Tags aus der Adresse', () => {
    expect(guessFromUrl('https://thewandererai.com/press/2026/the-wanderer-close-ups.jpg', 'The Wanderer Pressefoto')).toEqual({ description: 'The Wanderer Pressefoto - the wanderer close ups', tags: ['wanderer', 'close', 'ups'] })
  })
})

describe('Fundus mit Datenbank', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  let project: typeof schema.projects.$inferSelect

  beforeAll(async () => {
    process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), 'ma-fundus-'))
    ;({ db, close } = await openTestDb())
    ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { agentEnabled: false } }).returning())[0]!
    project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'tv', name: 'The Wanderer', code: 'TV', icon: 'T' }).returning())[0]!
  })
  afterAll(async () => {
    await close()
    delete process.env.MEDIA_DIR
  })

  it('hochladen, ändern, an Entwurf hängen (als Kopie), löschen', async () => {
    const it1 = await addFundusItem(db, ws, project, { name: 'studio.jpg', data: JPG, description: 'Band im Studio \u2013 weiß', tags: ['Studio'], checked: false })
    expect(it1.description).toBe('Band im Studio - weiß')
    expect(it1.tags).toEqual(['studio'])
    expect(await fileExists(it1.file)).toBe(true)
    await expect(addFundusItem(db, ws, project, { name: 'x.pdf', data: new TextEncoder().encode('%PDF-1') })).rejects.toThrow(MediaError)
    expect((await listFundus(db, project.id, { checkedOnly: true })).length).toBe(0)
    const it2 = await updateFundusItem(db, it1, { checked: true, tags: 'studio, presse' })
    expect(it2.checked).toBe(true)
    expect(it2.tags).toEqual(['studio', 'presse'])

    const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'TV-SOC-1', title: 'Pressefoto aus dem Studio posten', category: 'social', draftKind: 'post' }).returning()
    const [draft] = await db.insert(schema.drafts).values({ taskId: task!.id, kind: 'post', body: 'Neues Foto' }).returning()
    const picked = await suggestFromFundus(db, ws, task!, draft!.id, { body: 'Neues Foto aus dem Studio' })
    expect(picked?.id).toBe(it1.id)
    const [d2] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft!.id))
    expect(d2!.media.length).toBe(1)
    expect(d2!.media[0]!.file).not.toBe(it1.file)
    expect(await fileExists(d2!.media[0]!.file)).toBe(true)
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task!.id))
    expect(notes[0]!.text).toMatch(/^Bild aus dem Fundus angehängt: studio.jpg/)
    const [used] = await db.select().from(schema.mediaLibrary).where(eq(schema.mediaLibrary.id, it1.id))
    expect(used!.usedCount).toBe(1)
    expect(await suggestFromFundus(db, ws, task!, draft!.id, { body: 'Studio' })).toBeNull()

    await attachFundusItem(db, ws, d2!, used!)
    await deleteFundusItem(db, used!)
    expect(await fileExists(it1.file)).toBe(false)
    expect(await fileExists(d2!.media[0]!.file)).toBe(true)
  })

  it('Import per Adresse: ungeprüft, ohne Doppelte, Fehler übersprungen', async () => {
    const urls = ['https://thewandererai.com/press/2026/the-wanderer-flash.jpg', 'https://thewandererai.com/press/2026/the-wanderer-glass.jpg', 'https://example.org/kaputt.jpg']
    const fetcher = async (u: string) => (u.includes('kaputt') ? null : { name: u.split('/').pop()!, data: JPG })
    const r = await importFundusFromUrls(db, ws, project, urls, { tags: ['presse'], prefix: 'The Wanderer Pressefoto', fetcher })
    expect(r.added.map(a => a.name)).toEqual(['the-wanderer-flash.jpg', 'the-wanderer-glass.jpg'])
    expect(r.added[0]!.checked).toBe(false)
    expect(r.added[0]!.tags).toEqual(['presse', 'wanderer', 'flash'])
    expect(r.added[0]!.source).toBe(urls[0])
    expect(r.skipped).toEqual([{ url: urls[2], reason: 'nicht abrufbar oder kein Bild' }])
    const again = await importFundusFromUrls(db, ws, project, urls.slice(0, 1), { fetcher })
    expect(again.added).toEqual([])
    expect(again.skipped[0]!.reason).toBe('schon im Fundus')
  })
})
