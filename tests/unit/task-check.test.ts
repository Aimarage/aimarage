import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { checkAndClose, checkOpenTasks, checkTask, mentions, sameText, seoLines } from '../../server/lib/task-check'
import { updateTask as svcUpdateTask } from '../../server/lib/api/service'
import { checkKind, openFirst } from '../../shared/utils/task-check'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let user: string
let n = 0

const SITE = 'https://example.org'
const page = (o: { title?: string, desc?: string, h1?: string, hreflang?: boolean, body?: string }) => `<!doctype html><html lang="de"><head>${o.title ? `<title>${o.title}</title>` : ''}${o.desc ? `<meta name="description" content="${o.desc}">` : ''}${o.hreflang ? '<link rel="alternate" hreflang="en" href="https://example.org/en/">' : ''}</head><body>${o.h1 ? `<h1>${o.h1}</h1>` : ''}<p>${o.body ?? 'Text'}</p></body></html>`

function web(pages: Record<string, string | { status?: number, body: string, type?: string, headers?: Record<string, string> }>) {
  const calls: string[] = []
  const f = async (url: string) => {
    calls.push(url)
    const p = pages[url]
    if (p === undefined) return new Response('nicht da', { status: 404, headers: { 'content-type': 'text/html' } })
    const o = typeof p === 'string' ? { body: p } : p
    return new Response(o.body, { status: o.status ?? 200, headers: { 'content-type': o.type ?? 'text/html; charset=utf-8', ...o.headers } })
  }
  return { f, calls }
}

async function task(o: Partial<typeof schema.tasks.$inferInsert>) {
  n++
  const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: `TST-PFL-${String(n).padStart(3, '0')}`, title: `Aufgabe ${n}`, category: 'pflege', dueDate: '2026-10-13', ...o }).returning()
  return t!
}

const reload = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!
const history = async (id: string) => (await db.select().from(schema.activity).where(eq(schema.activity.taskId, id))).map(a => a.action)

const LONG = 'Ein sehr langer Seitentitel über alles, was diese Seite kann und noch viel mehr dazu'
const titleDesc = [
  'SEO-Prüfung: 2 Seiten. Der Seitentitel ...',
  '',
  'Auftrag für Claude Code oder Entwickler (kopieren):',
  `Im Code der Website ${SITE}: Seitentitel (<title>) ändern: höchstens 60 Zeichen.`,
  `- ${SITE}/about: Seitentitel zu lang (82 Zeichen, gut sind bis 60) -> "Über uns | Test"`,
  `- ${SITE}/preise: Seitentitel fehlt -> "Preise | Test"`,
  'Nur das ändern, dann veröffentlichen. Danach Aufgabe TST-PFL-001 in Aimarage erledigen (MCP: aufgabe_status).',
].join('\n')

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T09:00:00+02:00'
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
  user = (await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning())[0]!.id
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'tst', name: 'Testolino', code: 'TST', icon: 'T', url: SITE }).returning())[0]!
})
afterAll(async () => {
  delete process.env.MA_NOW
  await close()
})

describe('Prüfbare Aufgaben erkennen', () => {
  it('SEO, abgerutschte Seite, Verzeichnis und Community-Beitrag sind prüfbar, Einrichtung nicht', () => {
    expect(checkKind({ title: 'Seitentitel auf 2 Seiten verbessern', category: 'pflege', origin: 'seo-group:title' })).toBe('seo')
    expect(checkKind({ title: 'Seitentitel von /a kürzen', category: 'pflege', origin: 'seo:title_long:/a' })).toBe('seo')
    expect(checkKind({ title: 'Ladezeit verbessern', category: 'pflege', origin: 'seo-group:speed' })).toBeNull()
    expect(checkKind({ title: '/a überarbeiten', category: 'pflege', origin: 'seo-drop:/a' })).toBe('seo-drop')
    expect(checkKind({ title: 'Eintrag bei AlternativeTo', category: 'verzeichnis' })).toBe('directory')
    expect(checkKind({ title: 'Antwort in r/selfhosted', category: 'community', channel: 'Reddit', draftKind: 'post' })).toBe('post')
    expect(checkKind({ title: 'Recherche: passende Subreddits', category: 'community' })).toBeNull()
    expect(checkKind({ title: 'Bing Webmaster Tools einrichten', category: 'pflege' })).toBeNull()
  })

  it('liest Seiten und Art aus dem Auftrag', () => {
    const lines = seoLines(titleDesc, 'title', null, null)
    expect(lines.map(l => [l.url, l.code])).toEqual([[`${SITE}/about`, 'title_long'], [`${SITE}/preise`, 'title_missing']])
    const links = seoLines(`- ${SITE}/alt liefert Fehler 404, verlinkt auf /blog`, 'links', null, null)
    expect(links).toEqual([{ url: `${SITE}/alt`, code: 'http_error', from: '/blog' }])
    expect(seoLines(null, 'h1', null, `${SITE}/x`)).toEqual([{ url: `${SITE}/x`, code: 'h1_missing' }])
  })

  it('erkennt Eintrag und eigenen Text', () => {
    expect(mentions('<a href="https://www.example.org/">Link</a>', project)).toBe('domain')
    expect(mentions('<h2>Testolino</h2>', project)).toBe('name')
    expect(mentions('<p>Testolinos und mehr</p>', project)).toBeNull()
    expect(sameText('Ich nutze dafür Testolino, das spart mir jede Woche zwei Stunden Arbeit.', 'ich nutze dafür testolino - das spart mir jede woche zwei stunden arbeit!')).toBe(true)
    expect(sameText('Ich nutze dafür Testolino, das spart mir jede Woche zwei Stunden Arbeit.', 'Ganz anderer Kommentar über etwas anderes')).toBe(false)
    expect(openFirst([{ text: 'a', done: true }, { text: 'b', done: false }]).map(i => i.text)).toEqual(['b', 'a'])
  })
})

describe('Prüfen und abhaken', () => {
  it('SEO-Titel: offen mit Begründung, nach der Korrektur erledigt mit Verlauf', async () => {
    const t = await task({ title: 'Seitentitel auf 2 Seiten verbessern', origin: 'seo-group:title', description: titleDesc, targetUrl: `${SITE}/about` })
    const before = web({ [`${SITE}/about`]: page({ title: LONG }), [`${SITE}/preise`]: page({ title: 'Preise | Test' }) })
    const r = await checkAndClose(db, ws, t, { type: 'user', userId: user }, { fetchImpl: before.f })
    expect(r.ok).toBe(false)
    expect(r.closed).toBe(false)
    expect(r.items[0]).toEqual({ text: `Titel auf /about hat ${LONG.length} Zeichen (gut sind bis 60)`, done: false })
    expect(r.items[1]!.done).toBe(true)
    expect((await reload(t.id)).status).toBe('geplant')
    const after = web({ [`${SITE}/about`]: page({ title: 'Über uns | Test' }), [`${SITE}/preise`]: page({ title: 'Preise | Test' }) })
    const ok = await checkAndClose(db, ws, t, { type: 'user', userId: user }, { fetchImpl: after.f })
    expect(ok.closed).toBe(true)
    expect((await reload(t.id)).status).toBe('erledigt')
    expect(await history(t.id)).toContain('task_checked')
  })

  it('kaputter Link gilt als erledigt, wenn die verlinkende Seite ihn nicht mehr enthält', async () => {
    const t = await task({ title: 'Kaputten Link reparieren: /alt', origin: 'seo-group:links', description: `- ${SITE}/alt liefert Fehler 404, verlinkt auf /blog` })
    const still = web({ [`${SITE}/blog`]: page({ body: '<a href="/alt">alt</a>' }) })
    expect((await checkTask(db, ws, t, { fetchImpl: still.f })).ok).toBe(false)
    const gone = web({ [`${SITE}/blog`]: page({ body: '<a href="/neu">neu</a>' }) })
    const r = await checkTask(db, ws, t, { fetchImpl: gone.f })
    expect(r.ok).toBe(true)
    expect(r.items[0]!.text).toBe('Link auf /alt von /blog entfernt')
  })

  it('abgerutschte Seite: erledigt erst nach erkennbarer Änderung', async () => {
    const t = await task({ title: '/funktionen überarbeiten: in Google abgerutscht', origin: 'seo-drop:/funktionen', targetUrl: `${SITE}/funktionen`, createdAt: new Date('2026-10-10T08:00:00Z') })
    const same = web({ [`${SITE}/funktionen`]: { body: page({ title: 'Funktionen' }), headers: { 'last-modified': 'Mon, 05 Oct 2026 10:00:00 GMT' } } })
    const r1 = await checkTask(db, ws, t, { fetchImpl: same.f })
    expect(r1.ok).toBe(false)
    expect(r1.items[0]!.text).toBe('Keine Änderung an /funktionen seit 10.10. erkennbar')
    const fresh = web({ [`${SITE}/funktionen`]: { body: page({ title: 'Funktionen' }), headers: { 'last-modified': 'Mon, 12 Oct 2026 10:00:00 GMT' } } })
    expect((await checkTask(db, ws, t, { fetchImpl: fresh.f })).ok).toBe(true)
  })

  it('Verzeichnis: ohne Link wird nach dem Link gefragt, gefundener Eintrag wird gespeichert', async () => {
    const t = await task({ title: 'Eintrag bei ToolVerzeichnis', category: 'verzeichnis', channel: 'Verzeichnisse' })
    const none = await checkTask(db, ws, t, { fetchImpl: web({}).f })
    expect(none.needLink).toBe(true)
    expect(none.ok).toBe(false)
    const dir = web({ 'https://tools.test/software/testolino': page({ h1: 'Testolino', body: '<a href="https://example.org/?ref=tools">Website</a>' }), 'https://tools.test/neu': page({ h1: 'Neue Tools' }) })
    const miss = await checkTask(db, ws, t, { fetchImpl: dir.f, link: 'https://tools.test/neu' })
    expect(miss.items[0]!.text).toBe('Auf tools.test kein Eintrag für Testolino gefunden')
    const r = await checkAndClose(db, ws, t, { type: 'user', userId: user }, { fetchImpl: dir.f, link: 'https://tools.test/software/testolino' })
    expect(r.closed).toBe(true)
    const row = await reload(t.id)
    expect(row.status).toBe('erledigt')
    expect(row.postedUrl).toBe('https://tools.test/software/testolino')
  })

  it('Reddit-Antwort: findet den eigenen Kommentar im Thread und speichert den Link', async () => {
    const thread = 'https://www.reddit.com/r/selfhosted/comments/abc123/welches_tool/'
    const body = 'Ich nutze dafür Testolino, das spart mir jede Woche zwei Stunden Arbeit beim Planen.'
    const t = await task({ title: 'Antwort in r/selfhosted', category: 'community', channel: 'Reddit r/selfhosted', draftKind: 'post', status: 'freigegeben', targetUrl: thread })
    await db.insert(schema.drafts).values({ taskId: t.id, kind: 'post', body, status: 'freigegeben', targetUrl: thread })
    const json = [
      { kind: 'Listing', data: { children: [{ kind: 't3', data: { title: 'Welches Tool?', selftext: 'Frage', permalink: '/r/selfhosted/comments/abc123/welches_tool/' } }] } },
      { kind: 'Listing', data: { children: [
        { kind: 't1', data: { body: 'Anderer Kommentar ohne Bezug', permalink: '/r/selfhosted/comments/abc123/welches_tool/c1/', replies: { kind: 'Listing', data: { children: [
          { kind: 't1', data: { body: 'ich nutze dafür testolino, das spart mir jede woche zwei stunden arbeit beim planen', permalink: '/r/selfhosted/comments/abc123/welches_tool/c2/', replies: '' } },
        ] } } } },
      ] } },
    ]
    const reddit = web({ 'https://www.reddit.com/r/selfhosted/comments/abc123/welches_tool.json?raw_json=1&limit=500': { body: JSON.stringify(json), type: 'application/json' } })
    const r = await checkAndClose(db, ws, t, { type: 'user', userId: user }, { fetchImpl: reddit.f })
    expect(r.closed).toBe(true)
    expect((await reload(t.id)).postedUrl).toBe('https://www.reddit.com/r/selfhosted/comments/abc123/welches_tool/c2/')
  })

  it('Reddit ohne Fund: fragt nach dem Link, eingetragener Link wird geprüft', async () => {
    const t = await task({ title: 'Beitrag in r/test', category: 'community', channel: 'Reddit r/test', draftKind: 'post', status: 'freigegeben' })
    await db.insert(schema.drafts).values({ taskId: t.id, kind: 'post', body: 'Ein ganz eigener Beitrag über Testolino und seine Planungsfunktionen für kleine Teams.', status: 'freigegeben' })
    const empty = web({ 'https://www.reddit.com/r/test/new.json?raw_json=1&limit=500': { body: JSON.stringify({ kind: 'Listing', data: { children: [] } }), type: 'application/json' } })
    const r = await checkTask(db, ws, t, { fetchImpl: empty.f })
    expect(r).toMatchObject({ ok: false, needLink: true })
    const post = web({ 'https://www.reddit.com/r/test/comments/zz9/mein_beitrag.json?raw_json=1&limit=500': { body: JSON.stringify([{ kind: 'Listing', data: { children: [{ kind: 't3', data: { title: 'Mein Beitrag', selftext: 'x', permalink: '/r/test/comments/zz9/mein_beitrag/' } }] } }]), type: 'application/json' } })
    const ok = await checkTask(db, ws, t, { fetchImpl: post.f, link: 'https://www.reddit.com/r/test/comments/zz9/mein_beitrag/' })
    expect(ok.ok).toBe(true)
  })

  it('täglicher Lauf hakt schon Erledigtes ab und lässt Offenes und Nicht-Prüfbares stehen', async () => {
    const done = await task({ title: 'H1 auf /team ergänzen', origin: 'seo-group:h1', description: `- ${SITE}/team: Hauptüberschrift (H1) fehlt -> "Team"`, dueDate: '2026-10-15' })
    const open = await task({ title: 'Meta-Beschreibung für /kontakt ergänzen', origin: 'seo-group:desc', description: `- ${SITE}/kontakt: Meta-Beschreibung fehlt (Text unter dem Link in Google)` })
    const other = await task({ title: 'Bing einrichten' })
    const far = await task({ title: 'H1 auf /fern ergänzen', origin: 'seo-group:h1', description: `- ${SITE}/fern: Hauptüberschrift (H1) fehlt`, dueDate: '2026-12-01' })
    const site = web({ [`${SITE}/team`]: page({ h1: 'Unser Team' }), [`${SITE}/kontakt`]: page({ title: 'Kontakt' }), [`${SITE}/fern`]: page({ h1: 'Fern' }) })
    const r = await checkOpenTasks(db, ws, { fetchImpl: site.f })
    expect(r.closed).toContain(done.code)
    expect(r.closed).not.toContain(open.code)
    expect((await reload(done.id)).status).toBe('erledigt')
    expect(await history(done.id)).toContain('task_checked_auto')
    expect((await reload(open.id)).status).toBe('geplant')
    expect((await reload(other.id)).status).toBe('geplant')
    expect((await reload(far.id)).status).toBe('geplant')
    expect(site.calls).not.toContain(`${SITE}/fern`)
  })

  it('MCP aufgabe_status erledigt prüft zuerst und hakt bei Fehlschlag nicht ab', async () => {
    const t = await task({ title: 'Sprachverweise ergänzen', origin: 'seo-group:hreflang', description: `- ${SITE}/en-test: Keine Sprachverweise (hreflang) trotz mehrerer Sprachen` })
    const real = globalThis.fetch
    globalThis.fetch = (async (url: string) => web({ [`${SITE}/en-test`]: page({ title: 'EN' }) }).f(url)) as typeof fetch
    try {
      const actor = { workspace: ws, userId: user, userName: 'Peter', role: 'owner' as const, access: { all: true, ids: [] } }
      const r = await svcUpdateTask(db, actor, t.code, { status: 'erledigt' }) as { abgehakt?: boolean, pruefung?: { punkte: string[] } }
      expect(r.abgehakt).toBe(false)
      expect(r.pruefung?.punkte[0]).toBe('offen: Keine Sprachverweise (hreflang) auf /en-test')
      expect((await reload(t.id)).status).toBe('geplant')
      globalThis.fetch = (async (url: string) => web({ [`${SITE}/en-test`]: page({ title: 'EN', hreflang: true }) }).f(url)) as typeof fetch
      const ok = await svcUpdateTask(db, actor, t.code, { status: 'erledigt' }) as { abgehakt?: boolean }
      expect(ok.abgehakt).toBe(true)
      expect((await reload(t.id)).status).toBe('erledigt')
    }
    finally {
      globalThis.fetch = real
    }
  })

  it('MCP aufgabe_status erledigt mit notiz: Claude als Erlediger, Notiz gespeichert', async () => {
    const t = await task({ title: 'Impressum ergänzen' })
    const actor = { workspace: ws, userId: user, userName: 'Peter', role: 'owner' as const, access: { all: true, ids: [] } }
    await svcUpdateTask(db, actor, t.code, { status: 'erledigt', force: true, note: 'Impressum um UID ergänzt \u2013 Commit abc123.' })
    expect((await reload(t.id)).status).toBe('erledigt')
    const ev = (await db.select().from(schema.activity).where(eq(schema.activity.taskId, t.id))).find(a => a.action === 'status:erledigt')
    expect(ev?.actor).toBe('mcp')
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, t.id))
    expect(notes.map(n => n.text)).toEqual(['Impressum um UID ergänzt - Commit abc123.'])
  })
})
