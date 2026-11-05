import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { directoriesIn, doneDigest, isListingUpdate, listingConflict, listingDigest, listingRegister, taskDirectories } from '../../server/lib/listings'
import { listedIn, recentWork } from '../../server/lib/agent'
import { createTask } from '../../server/lib/tasks'
import { materializeRecurrences } from '../../server/lib/materialize'

let db: Db
let close: () => Promise<void>
let project: typeof schema.projects.$inferSelect
let ws: string

beforeAll(async () => {
  process.env.MA_NOW = '2026-11-01T12:00:00+01:00'
  ;({ db, close } = await openTestDb())
  const [w] = await db.insert(schema.workspaces).values({ name: 'Test', slug: 'test-listings' }).returning()
  ws = w!.id
  ;[project] = await db.insert(schema.projects).values({ workspaceId: ws, name: 'linkbox', slug: 'linkbox', code: 'BMX', icon: 'book', url: 'https://www.linkbox.net' }).returning()
})
afterAll(async () => {
  delete process.env.MA_NOW
  await close()
})

describe('Verzeichnis-Namen', () => {
  it('erkennt Domain und Namen, aber kein "alternative to" im Fließtext', () => {
    expect(directoriesIn('AlternativeTo-Eintrag aufwerten')).toEqual(['alternativeto.net'])
    expect(directoriesIn('Einträge: There\'s An AI For That, Futurepedia')).toEqual(['theresanaiforthat.com', 'futurepedia.io'])
    expect(directoriesIn('a good alternative to Pocket')).toEqual([])
    expect(taskDirectories({ title: 'Verzeichnisse', targetUrl: 'https://www.saashub.com/submit' }, 'linkbox.net')).toEqual(['saashub.com'])
    expect(taskDirectories({ title: 'Eintrag', targetUrl: 'https://neu-verzeichnis.example/add' }, 'linkbox.net')).toEqual(['neu-verzeichnis.example'])
    expect(isListingUpdate('AlternativeTo-Eintrag aktualisieren')).toBe(true)
    expect(isListingUpdate('AlternativeTo Eintrag')).toBe(false)
  })
})

describe('Register "wo stehen wir schon"', () => {
  it('sammelt erledigte Aufgaben, eigene Beiträge, Notizen ohne Verneinung und Besucherquellen', async () => {
    const done = await createTask(db, { workspaceId: ws, projectId: project.id, title: 'MCP Registry Eintrag', category: 'verzeichnis', dueDate: '2026-10-09' })
    await db.update(schema.tasks).set({ status: 'erledigt', doneAt: new Date('2026-10-09T10:00:00Z') }).where(eq(schema.tasks.id, done.id))
    const post = await createTask(db, { workspaceId: ws, projectId: project.id, title: 'Post: Bewertungen', category: 'social', dueDate: '2026-10-27' })
    await db.update(schema.tasks).set({ status: 'erledigt', doneAt: new Date('2026-10-27T10:00:00Z') }).where(eq(schema.tasks.id, post.id))
    await db.insert(schema.drafts).values({ taskId: post.id, body: 'Tell us on AlternativeTo: https://alternativeto.net/software/linkbox/about/', status: 'freigegeben' })
    await db.insert(schema.projectMemory).values([
      { projectId: project.id, text: 'Kein Konto bei Product Hunt (laut Antwort zu F-04).' },
      { projectId: project.id, text: 'linkbox steht 2x auf AlternativeTo.' },
    ])
    await db.insert(schema.utmStats).values({ projectId: project.id, day: '2026-10-20', source: 'saashub-com', visits: 3 })

    const reg = await listingRegister(db, project)
    const by = Object.fromEntries(reg.map(r => [r.domain, r.sources.map(s => s.kind)]))
    expect(by['registry.modelcontextprotocol.io']).toContain('aufgabe')
    expect(by['alternativeto.net']).toEqual(expect.arrayContaining(['beitrag', 'notiz']))
    expect(by['saashub.com']).toEqual(['besucher'])
    expect(by['producthunt.com']).toBeUndefined()
    expect(listingDigest(reg, 'linkbox')).toContain('AlternativeTo (alternativeto.net)')
    expect(await doneDigest(db, project.id)).toContain('MCP Registry Eintrag')
  })

  it('verbietet zweite Einträge und doppelte offene Aufgaben, erlaubt eine Aktualisierung', async () => {
    expect((await listingConflict(db, project, { title: 'AlternativeTo Eintrag' }))?.domain).toBe('alternativeto.net')
    expect(await listingConflict(db, project, { title: 'AlternativeTo-Eintrag aktualisieren' })).toBeNull()
    const a = await createTask(db, { workspaceId: ws, projectId: project.id, title: 'Eintrag european-alternatives.eu', category: 'verzeichnis', dueDate: '2026-11-10' })
    const b = await createTask(db, { workspaceId: ws, projectId: project.id, title: 'european-alternatives.eu', category: 'verzeichnis', dueDate: '2026-11-25' })
    expect(await listingConflict(db, project, a)).toBeNull()
    expect((await listingConflict(db, project, b))?.reason).toContain(a.code)
    expect(await listingConflict(db, project, { title: 'Verzeichnisse & Listings' })).toBeNull()
  })

  it('Entwurf mit bereits gelistetem Verzeichnis wird erkannt', async () => {
    const reg = await listingRegister(db, project)
    expect(listedIn({ body: 'SUBMIT IN 3 STEPS 1. Create a free AlternativeTo account', subject: null, targetUrl: null }, { title: 'Verzeichnisse & Listings' }, reg, project.url)?.domain).toBe('alternativeto.net')
    expect(listedIn({ body: 'Short description for Uneed', subject: null, targetUrl: 'https://www.uneed.best/submit' }, { title: 'Verzeichnisse & Listings' }, reg, project.url)).toBeNull()
  })

  it('Schon gemacht: auch andere Kanal-Schlüssel und erledigte Aufgaben ohne Entwurf', async () => {
    const t = await createTask(db, { workspaceId: ws, projectId: project.id, title: 'Verzeichnisse & Listings', category: 'verzeichnis', dueDate: '2026-11-20', strategyChannel: 'verzeichnisse-listings' })
    const lines = await recentWork(db, t)
    expect(lines.join('\n')).toContain('MCP Registry Eintrag (erledigt)')
  })

  it('Serie für ein schon belegtes Verzeichnis legt keine Aufgaben an, für ein neues höchstens eine', async () => {
    await db.insert(schema.recurrences).values([
      { workspaceId: ws, projectId: project.id, rule: 'weekly:MO', title: 'AlternativeTo', category: 'verzeichnis', strategyChannel: 'alt', startDate: '2026-11-01' },
      { workspaceId: ws, projectId: project.id, rule: 'weekly:TU', title: 'Uneed', category: 'verzeichnis', strategyChannel: 'uneed', startDate: '2026-11-01' },
    ])
    await materializeRecurrences(db, ws, '2026-11-02')
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, project.id))
    expect(rows.filter(r => r.title === 'AlternativeTo')).toHaveLength(0)
    expect(rows.filter(r => r.title === 'Uneed')).toHaveLength(1)
  })
})
