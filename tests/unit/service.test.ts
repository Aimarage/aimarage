import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accountKnown, cleanSteps, isForeignTask, needsServiceCheck, serviceName, type TaskService } from '../../shared/utils/service'
import { pickUrl, serviceQuestion } from '../../server/lib/service'
import { answeredQuestions, dropAnswered } from '../../shared/utils/talk'
import { runDraftTask } from '../../server/lib/agent'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { applyLlmUpdate } from '../../server/lib/llm'
import { resetSecretCache } from '../../server/lib/secret'

const base = { title: 'Prüfung: DailyPlaylists', category: 'verzeichnis', channel: 'DailyPlaylists', targetUrl: null, draftKind: 'text', humanStep: 'Eintrag im Formular einreichen' }
const svc = (o: Partial<TaskService> = {}): TaskService => ({ name: 'DailyPlaylists', what: null, why: null, cost: null, account: 'neu', register: null, steps: [], url: null, fits: true, fitReason: null, checkedAt: '2026-10-13T06:00:00.000Z', ...o })

describe('fremde Dienste', () => {
  it('erkennt Mensch-Aufgaben bei fremden Diensten', () => {
    expect(isForeignTask(base)).toBe(true)
    expect(isForeignTask({ ...base, humanStep: null })).toBe(false)
    expect(isForeignTask({ ...base, category: 'social', channel: 'Bluesky' })).toBe(false)
    expect(isForeignTask({ ...base, category: 'community', channel: 'r/SunoAI', title: 'Antwort in r/SunoAI' })).toBe(false)
    expect(isForeignTask({ ...base, category: 'community', channel: 'kvraudio.com', title: 'Forum: KVR' })).toBe(true)
  })

  it('prüft einmal, ohne Einreich-Seite nach 7 Tagen erneut', () => {
    const at = new Date('2026-10-13T08:00:00Z')
    expect(needsServiceCheck(base, at)).toBe(true)
    expect(needsServiceCheck({ ...base, service: svc({ url: 'https://dailyplaylists.com/submit-song/add-song' }) }, at)).toBe(false)
    expect(needsServiceCheck({ ...base, service: svc() }, at)).toBe(false)
    expect(needsServiceCheck({ ...base, service: svc({ checkedAt: '2026-10-01T08:00:00Z' }) }, at)).toBe(true)
    expect(needsServiceCheck({ ...base, targetUrl: 'https://x.example/add', service: svc({ checkedAt: '2026-10-01T08:00:00Z' }) }, at)).toBe(false)
  })

  it('Name aus Ort oder Titel', () => {
    expect(serviceName(base)).toBe('DailyPlaylists')
    expect(serviceName({ title: 'Prüfung: DailyPlaylists', channel: 'Verzeichnisse' }, ['Verzeichnisse'])).toBe('DailyPlaylists')
  })

  it('Konto nur, wenn bekannt', () => {
    expect(accountKnown('DailyPlaylists', ['Wir haben ein Konto bei DailyPlaylists (peter@...)'])).toBe(true)
    expect(accountKnown('DailyPlaylists', ['DailyPlaylists ist gratis'])).toBe(false)
    expect(accountKnown('DailyPlaylists', ['Kein Konto bei DailyPlaylists'])).toBe(false)
    expect(accountKnown('Bluesky', [], ['bluesky'])).toBe(true)
  })

  it('ohne Konto nie einloggen, höchstens 3 Schritte', () => {
    const steps = cleanSteps(['Mit deinem Konto einloggen', 'Song-Link einfügen', 'Texte einfügen', 'Absenden'], false, 'mit E-Mail, ca. 2 Min')
    expect(steps).toEqual(['Konto anlegen (mit E-Mail, ca. 2 Min)', 'Song-Link einfügen', 'Texte einfügen'])
    expect(cleanSteps(['Einloggen'], true, null)).toEqual(['Einloggen'])
  })

  it('URL nur aus Suchergebnissen', () => {
    const results = [{ url: 'https://dailyplaylists.com/' }]
    expect(pickUrl('https://dailyplaylists.com/submit-song/add-song', results, true)).toBe('https://dailyplaylists.com/submit-song/add-song')
    expect(pickUrl('https://erfunden.example/add', results, true)).toBeNull()
    expect(pickUrl('javascript:alert(1)', results, false)).toBeNull()
  })

  it('fragt ohne Einreich-Seite oder wenn es nicht passt', () => {
    expect(serviceQuestion({ category: 'verzeichnis' }, svc())).toMatch(/keine Einreich-Seite für DailyPlaylists/)
    expect(serviceQuestion({ category: 'verzeichnis' }, svc({ url: 'https://dailyplaylists.com/' }))).toBeNull()
    expect(serviceQuestion({ category: 'verzeichnis' }, svc({ url: 'https://x.example', fits: false, fitReason: 'Verbietet KI-Musik.' }))).toBe('Verbietet KI-Musik. Trotzdem bei DailyPlaylists einreichen?')
  })
})

describe('Entwurf mit Dienst-Recherche', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  let project: typeof schema.projects.$inferSelect

  beforeAll(async () => {
    process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
    process.env.APP_SECRET = 'test-secret'
    resetSecretCache()
    ;({ db, close } = await openTestDb())
    const [w] = await db.insert(schema.workspaces).values({ name: 'Test' }).returning()
    await db.update(schema.workspaces).set({ settings: { llm: applyLlmUpdate(undefined, { provider: 'anthropic', apiKey: 'sk-ant-test-0123456789abcdef' }, w!.id) } }).where(eq(schema.workspaces.id, w!.id))
    ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, w!.id)))[0]!
    const [p] = await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'theraw', name: 'The Raw', code: 'THE', icon: 'music' }).returning()
    project = p!
  })

  afterAll(async () => {
    delete process.env.MA_NOW
    delete process.env.APP_SECRET
    await close()
  })

  function mock(service: Record<string, unknown>) {
    const prompts: string[] = []
    const fn = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string, messages: { content: string | { text: string }[] }[] }
      const last = body.messages.at(-1)!.content
      const prompt = typeof last === 'string' ? last : last.map(c => c.text).join('\n')
      prompts.push(prompt)
      const text = prompt.includes('Recherchiere aus den Suchergebnissen')
        ? JSON.stringify(service)
        : body.model === 'claude-sonnet-5-5' ? JSON.stringify({ verdict: 'ok', reason: 'passt' }) : JSON.stringify({ kind: 'text', body: 'Kurz: Superposition, Indie-Elektro.\nLang: ...' })
      return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return { fn: fn as unknown as typeof fetch, prompts }
  }

  async function makeTask(code: string, targetUrl: string | null = null) {
    const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code, title: 'Prüfung: DailyPlaylists', description: 'End of Time prüfen', category: 'verzeichnis', channel: 'DailyPlaylists', status: 'geplant', draftKind: 'text', dueDate: '2026-10-15', agentStep: 'Eintragstexte vorbereiten', humanStep: 'Eintrag im Formular einreichen', targetUrl }).returning()
    return t!
  }

  it('speichert Dienst, Einreich-Seite und neue Beschreibung', async () => {
    const task = await makeTask('THE-DIR-001', 'https://dailyplaylists.com/submit-song/add-song')
    const web = (async () => new Response('<title>Add song</title><p>Free plan</p>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    const llm = mock({ name: 'DailyPlaylists', url: '', what: 'DailyPlaylists ist eine Plattform, auf der man Songs gratis an Playlist-Kuratoren schickt.', why: 'Mehr Hörer für Superposition.', cost: 'gratis (Gratis-Tarif)', register: 'mit E-Mail, ca. 2 Min', steps: ['Mit deinem Konto einloggen', 'Song einreichen'], fits: true, description: 'Superposition bei DailyPlaylists einreichen.' })
    await runDraftTask(db, ws, task.id, llm.fn, { webFetch: web })
    const t = (await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)))[0]!
    expect(t.targetUrl).toBe('https://dailyplaylists.com/submit-song/add-song')
    expect(t.description).toBe('Superposition bei DailyPlaylists einreichen.')
    expect(t.service?.account).toBe('neu')
    expect(t.service?.steps[0]).toBe('Konto anlegen (mit E-Mail, ca. 2 Min)')
    const [draft] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task.id))
    expect(draft?.targetUrl).toBe('https://dailyplaylists.com/submit-song/add-song')
    expect(llm.prompts.some(p => p.includes('Konto bei DailyPlaylists: keins bekannt'))).toBe(true)
  })

  it('ohne Einreich-Seite: Rückfrage statt Mensch-Schritt', async () => {
    await db.update(schema.tasks).set({ status: 'verworfen' }).where(eq(schema.tasks.code, 'THE-DIR-001'))
    const task = await makeTask('THE-DIR-002')
    const web = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    const llm = mock({ name: 'DailyPlaylists', url: 'https://dailyplaylists.com/erfunden', what: 'x', fits: true })
    await runDraftTask(db, ws, task.id, llm.fn, { webFetch: web })
    const t = (await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)))[0]!
    expect(t.targetUrl).toBeNull()
    expect(t.service?.url).toBeNull()
    const notes = (await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))).map(n => n.text)
    expect(notes.some(n => n.startsWith('Info nötig:') && n.includes('keine Einreich-Seite für DailyPlaylists'))).toBe(true)
  })

  it('beantwortete Rückfrage kommt bei der nächsten Fassung nicht wieder', async () => {
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.code, 'THE-DIR-002'))
    await db.insert(schema.taskNotes).values({ taskId: task!.id, byAgent: false, text: 'Zum Entwurf: Den Link kenne ich nicht, bitte trotzdem nur den Text vorbereiten.', createdAt: new Date(Date.now() + 1000) })
    const web = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    process.env.MA_NOW = '2026-10-13T08:20:00+02:00'
    await runDraftTask(db, ws, task!.id, mock({ name: 'DailyPlaylists', fits: true }).fn, { webFetch: web })
    const asked = (await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task!.id))).filter(n => n.text.startsWith('Info nötig:'))
    expect(asked).toHaveLength(1)
    expect((await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, task!.id))).length).toBe(2)
  })
})

describe('Artikel und beantwortete Fragen', () => {
  it('Artikel und Blog-Aufgaben sind kein Einreich-Dienst', () => {
    const article = { title: 'SEO & Ratgeber', category: 'content', channel: 'SEO & Ratgeber', targetUrl: null, draftKind: 'article', humanStep: 'Prüfen, ergänzen, veröffentlichen' }
    expect(isForeignTask(article)).toBe(false)
    expect(isForeignTask({ ...article, draftKind: 'text' })).toBe(false)
    expect(isForeignTask({ ...article, category: 'verzeichnis', draftKind: 'article' })).toBe(false)
    expect(needsServiceCheck(article, new Date('2026-11-04T08:00:00Z'))).toBe(false)
  })

  it('beantwortete Fragen fallen weg, offene bleiben', () => {
    const q = 'Es gibt keinen externen Dienst mit Einreichformular; Massen-Submit-Seiten sind Spam. Trotzdem bei SEO & Ratgeber einreichen?'
    const notes = [
      { text: `Info nötig: ${q}`, byAgent: true, createdAt: '2026-11-02T04:56:06Z' },
      { text: 'Zum Entwurf: Nein, nirgends einreichen.', byAgent: false, createdAt: '2026-11-03T14:10:11Z' },
      { text: 'Info nötig: Welches Bild?', byAgent: true, createdAt: '2026-11-03T14:10:59Z' },
    ]
    expect(answeredQuestions(notes)).toEqual([q])
    expect(dropAnswered([q, 'Welches Bild?', 'Welcher Termin?'], notes)).toEqual(['Welches Bild?', 'Welcher Termin?'])
    expect(dropAnswered([q], notes.slice(0, 1))).toEqual([q])
  })
})
