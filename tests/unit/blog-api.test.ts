import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { articleSlug, articleVersions, splitTitle } from '../../shared/utils/article'
import { markdownToHtml } from '../../shared/utils/markdown'
import { publishTo } from '../../server/lib/blog'
import { runDraftTask } from '../../server/lib/agent'
import { blogApiToken, buildBlogApi, checkBlogApi, publicBlogApi, publishArticle, withdrawArticle } from '../../server/lib/blog-api'
import { aimarageBlog } from '../../server/lib/blog/aimarage'
import { saveMedia } from '../../server/lib/media'
import { updateTask } from '../../server/lib/tasks'
import { loadHistory } from '../../server/lib/history'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { decideArticle } from '../../server/lib/outlets'
import { resetSecretCache } from '../../server/lib/secret'

const API = 'https://chatsite.example/api/guides'
const TOKEN = 'guides-token-123456'
let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let seq = 0

async function reload() {
  ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
  project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
}
async function approvedArticle(variants: Record<string, string> = {}) {
  const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: `BA-${++seq}`, title: 'Artikel: Chatbot und DSGVO', category: 'content', status: 'freigegeben', draftKind: 'article', language: 'de', dueDate: '2026-10-13' }).returning()
  const [d] = await db.insert(schema.drafts).values({ taskId: t!.id, kind: 'article', subject: 'Chatbot und DSGVO: Was gilt?', body: 'Viele fragen sich, was gilt.\n\n## Kurz gesagt\n\nEs kommt darauf an.', variants, status: 'freigegeben' }).returning()
  return { task: t!, draft: d! }
}
function fakeApi(status = 201) {
  const calls: { url: string, auth: string, body: Record<string, string> }[] = []
  const fn = async (url: string, init: RequestInit) => {
    if (url !== API || init.method !== 'POST') return new Response('', { status: 404 })
    const body = JSON.parse(String(init.body)) as Record<string, string>
    calls.push({ url, auth: String((init.headers as Record<string, string>).Authorization), body })
    if (status >= 400) return new Response(JSON.stringify({ error: 'slug already used', key: 'x' }), { status })
    return new Response(JSON.stringify({ ok: true, url: `https://chatsite.example/${body.lang === 'de' ? 'de/ratgeber' : 'guides'}/${body.slug}` }), { status })
  }
  return { fn, calls }
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), 'ma-blog-media-'))
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning())[0]!
  await db.insert(schema.users).values({ email: 'p@test.local', name: 'Peter' })
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'chatsite', name: 'chatsite', code: 'AMW', icon: 'chat', url: 'https://chatsite.example', languages: ['de', 'en'] }).returning())[0]!
  const blogApi = buildBlogApi(ws.id, project.id, null, { url: API, token: TOKEN })
  await db.update(schema.projects).set({ setup: { blog: 'https://chatsite.example/guides', blogApi } }).where(eq(schema.projects.id, project.id))
  await reload()
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  delete process.env.MEDIA_DIR
  resetSecretCache()
  await close()
})

describe('Artikel-Fassungen', () => {
  it('Slug, Titel und Sprachen', () => {
    expect(articleSlug('EU AI Act: Was die Kennzeichnungspflicht für Chatbots bedeutet')).toBe('eu-ai-act-was-die-kennzeichnungspflicht-fuer-chatbots-bedeutet')
    expect(splitTitle('# Titel\n\nText', null)).toEqual({ title: 'Titel', body: 'Text' })
    const v = articleVersions({ subject: 'Chatbot und DSGVO', body: '# Chatbot und DSGVO\n\nErster Absatz.', variants: { en: '# Chatbots and GDPR\n\nFirst paragraph.', bluesky: 'kurz' } }, 'de', 'x')
    expect(v.map(x => [x.lang, x.title, x.slug, x.body, x.description])).toEqual([
      ['de', 'Chatbot und DSGVO', 'chatbot-und-dsgvo', 'Erster Absatz.', 'Erster Absatz.'],
      ['en', 'Chatbots and GDPR', 'chatbots-and-gdpr', 'First paragraph.', 'First paragraph.'],
    ])
    expect(articleVersions({ subject: 'Nur Liste', body: '- **Erster** Punkt\n- Zweiter', variants: {} }, 'de', 'x')[0]!.description).toBe('Erster Punkt')
    expect(articleVersions({ subject: 'Nur Überschrift', body: '## Abschnitt', variants: {} }, 'de', 'x')[0]!.description).toBe('Abschnitt')
  })
})

describe('Veröffentlichen per API', () => {
  it('Token verschlüsselt, nie im Klartext nach außen', () => {
    expect(JSON.stringify(project.setup)).not.toContain(TOKEN)
    expect(JSON.stringify(publicBlogApi(project.setup.blogApi))).not.toContain(TOKEN)
    expect(blogApiToken(ws.id, project.id, project.setup.blogApi)).toBe(TOKEN)
    expect(blogApiToken(ws.id, project.id, { ...project.setup.blogApi!, url: 'https://evil.example/api' })).toBeNull()
    expect(buildBlogApi(ws.id, project.id, project.setup.blogApi, { url: API }).secret).toEqual(project.setup.blogApi!.secret)
    expect(buildBlogApi(ws.id, project.id, project.setup.blogApi, { url: 'https://other.example/api' }).secret).toBeNull()
  })

  it('Prüfen: GET-Liste mit Token, sonst leere Probe', async () => {
    const seen: string[] = []
    const list = await checkBlogApi(db, ws, project, async (url, init) => {
      seen.push(`${init.method} ${(init.headers as Record<string, string>).Authorization}`)
      return new Response('{"ok":true,"articles":[]}', { status: 200 })
    })
    expect(list).toEqual({ ok: true, error: null })
    expect(seen).toEqual([`GET Bearer ${TOKEN}`])
    const old: string[] = []
    const probe = await checkBlogApi(db, ws, project, async (_url, init) => {
      old.push(`${init.method} ${init.body ?? ''}`)
      return init.method === 'GET' ? new Response('{"error":"method not allowed"}', { status: 405 }) : new Response('{"error":"invalid fields"}', { status: 422 })
    })
    expect(probe.ok).toBe(true)
    expect(old).toEqual(['GET ', 'POST {}'])
  })

  it('Prüfen: 422 auf leere Anfrage heißt Token ok, 401 heißt abgelehnt', async () => {
    const ok = await checkBlogApi(db, ws, project, async () => new Response('{"error":"invalid fields"}', { status: 422 }))
    expect(ok).toEqual({ ok: true, error: null })
    const bad = await checkBlogApi(db, ws, project, async () => new Response('{"error":"unauthorized"}', { status: 401 }))
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('Token abgelehnt')
  })

  it('ohne "Posten nach außen" nur Trockenlauf', async () => {
    const { task, draft } = await approvedArticle()
    const api = fakeApi()
    const r = await publishArticle(db, ws, { taskId: task.id, draftId: draft.id }, api.fn)
    expect(r.summary).toContain('Trockenlauf')
    expect(api.calls).toHaveLength(0)
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)))[0]!.status).toBe('freigegeben')
  })

  it('veröffentlicht DE und EN unter einem Schlüssel, setzt Link, Aufgabe erledigt', async () => {
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, publishLive: true } }).where(eq(schema.workspaces.id, ws.id))
    await reload()
    const { task, draft } = await approvedArticle({ en: '# Chatbots and GDPR: what applies?\n\nMany ask what applies.' })
    const api = fakeApi()
    const r = await publishArticle(db, ws, { taskId: task.id, draftId: draft.id, mode: 'manual' }, api.fn)
    expect(r.status).toBe('ok')
    expect(api.calls.map(c => [c.url, c.auth, c.body.key, c.body.lang, c.body.slug, c.body.date])).toEqual([
      [API, `Bearer ${TOKEN}`, 'chatbot-und-dsgvo-was-gilt', 'de', 'chatbot-und-dsgvo-was-gilt', '2026-10-13'],
      [API, `Bearer ${TOKEN}`, 'chatbot-und-dsgvo-was-gilt', 'en', 'chatbots-and-gdpr-what-applies', '2026-10-13'],
    ])
    expect(api.calls[0]!.body.title).toBe('Chatbot und DSGVO: Was gilt?')
    expect(api.calls[0]!.body.description).toBe('Viele fragen sich, was gilt.')
    expect(api.calls[1]!.body.body).toBe('Many ask what applies.')
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(t!.status).toBe('erledigt')
    expect(t!.postedUrl).toBe('https://chatsite.example/de/ratgeber/chatbot-und-dsgvo-was-gilt')
    const links = await db.select().from(schema.taskLinks).where(eq(schema.taskLinks.taskId, task.id))
    expect(links.map(l => l.platform).sort()).toEqual(['blog:de', 'blog:en'])
    expect(links.find(l => l.platform === 'blog:de')!.url).toBe(t!.postedUrl)
    const h = await loadHistory(db, { workspaceId: ws.id, scope: eq(schema.tasks.id, task.id), from: '2026-10-01', to: '2026-10-31', timezone: ws.timezone })
    expect(h.entries).toHaveLength(1)
    expect(h.entries[0]!.links.map(l => l.label)).toEqual(['chatsite.example DE', 'chatsite.example EN'])
    expect(h.perDay.find(d => d.day === h.entries[0]!.day)!.n).toBe(1)
  })

  it('Fehler: zurück an den Menschen, ohne Token in der Meldung', async () => {
    const { task, draft } = await approvedArticle()
    const r = await publishArticle(db, ws, { taskId: task.id, draftId: draft.id }, fakeApi(409).fn)
    expect(r.status).toBe('error')
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id))
    expect(t!.status).toBe('entwurf_fertig')
    expect(d!.status).toBe('offen')
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))
    expect(notes.some(n => n.text.includes('Veröffentlichen fehlgeschlagen') && n.text.includes('409'))).toBe(true)
    expect(JSON.stringify(notes)).not.toContain(TOKEN)
  })

  it('geänderter Entwurf wird nicht veröffentlicht', async () => {
    const { task, draft } = await approvedArticle()
    await db.update(schema.drafts).set({ status: 'ersetzt' }).where(eq(schema.drafts.id, draft.id))
    const api = fakeApi()
    expect((await publishArticle(db, ws, { taskId: task.id, draftId: draft.id }, api.fn)).status).toBe('skipped')
    expect(api.calls).toHaveLength(0)
  })

  it('Update: kein date, nur updated; Bild der Projektseite wird hochgeladen', async () => {
    const { task, draft } = await approvedArticle()
    await db.update(schema.tasks).set({ postedUrl: 'https://chatsite.example/de/ratgeber/chatbot-und-dsgvo-was-gilt' }).where(eq(schema.tasks.id, task.id))
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0])
    const calls: { url: string, method: string, type: string, body: unknown }[] = []
    const fn = async (url: string, init: RequestInit) => {
      const type = (init.headers as Record<string, string>)['Content-Type'] ?? ''
      calls.push({ url, method: String(init.method), type, body: type === 'application/json' ? JSON.parse(String(init.body)) : init.body })
      if (url === 'https://chatsite.example/') return new Response('<html><head><meta property="og:image" content="/og.png"></head><body>x</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      if (url === 'https://chatsite.example/og.png') return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
      if (url.startsWith(`${API}/images`)) return new Response(JSON.stringify({ ok: true, url: 'https://chatsite.example/blog/media/og-1a2b3c4d5e.png', path: '/blog/media/og-1a2b3c4d5e.png' }), { status: 201 })
      if (url === API) return new Response(JSON.stringify({ ok: true, url: 'https://chatsite.example/de/ratgeber/chatbot-und-dsgvo-was-gilt', key: 'chatbot-und-dsgvo-was-gilt', lang: 'de' }), { status: 200 })
      return new Response('', { status: 404 })
    }
    const r = await publishArticle(db, ws, { taskId: task.id, draftId: draft.id }, fn)
    expect(r.summary).toContain('Aktualisiert')
    const up = calls.find(c => c.url.startsWith(`${API}/images`))!
    expect(up).toMatchObject({ method: 'POST', type: 'image/png', url: `${API}/images?name=og` })
    const post = calls.find(c => c.url === API)!.body as Record<string, string>
    expect(post.date).toBeUndefined()
    expect(post.updated).toBe('2026-10-13')
    expect(post.image).toBe('/blog/media/og-1a2b3c4d5e.png')
  })

  it('Bild aus dem Entwurf; 415 beim Bild nur Notiz', async () => {
    const { task, draft } = await approvedArticle()
    const media = await saveMedia(ws.id, draft.id, { name: 'cover.jpg', data: new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]) })
    await db.update(schema.drafts).set({ media: [media] }).where(eq(schema.drafts.id, draft.id))
    const posts: Record<string, string>[] = []
    const r = await publishArticle(db, ws, { taskId: task.id, draftId: draft.id }, async (url, init) => {
      if (url.includes('/images')) {
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg')
        return new Response('{"error":"unsupported image type"}', { status: 415 })
      }
      posts.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ ok: true, url: `https://chatsite.example/x/${posts.length}` }), { status: 201 })
    })
    expect(r.status).toBe('ok')
    expect(posts[0]!.image).toBeUndefined()
    expect(posts[0]!.date).toBe('2026-10-13')
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))
    expect(notes.some(n => n.text.includes('Beitragsbild nicht übernommen') && n.text.includes('415'))).toBe(true)
  })

  it('429: Retry-After respektiert, Job später erneut; beim zweiten Mal zurück an den Menschen', async () => {
    const { task, draft } = await approvedArticle()
    const busy = async () => new Response('{"error":"too many requests"}', { status: 429, headers: { 'Retry-After': '120' } })
    const r = await publishArticle(db, ws, { taskId: task.id, draftId: draft.id, mode: 'manual' }, busy)
    expect(r.summary).toContain('120 Sekunden')
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.dedupeKey, `publish_article:${draft.id}:retry`))
    expect(job!.payload).toMatchObject({ taskId: task.id, retried: true })
    expect(job!.runAt.toISOString()).toBe(new Date(new Date('2026-10-13T08:15:00+02:00').getTime() + 120_000).toISOString())
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)))[0]!.status).toBe('freigegeben')
    const again = await publishArticle(db, ws, { taskId: task.id, draftId: draft.id, retried: true }, busy)
    expect(again.status).toBe('error')
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)))[0]!.status).toBe('entwurf_fertig')
  })

  it('413 beim Artikel: verständliche Meldung', async () => {
    await expect(aimarageBlog.publish(project.setup.blogApi!, TOKEN, { key: 'k', lang: 'de', slug: 'k', title: 't', description: 'd', body: 'b', updated: '2026-10-13' }, async () => new Response('{"error":"too large"}', { status: 413 }))).rejects.toThrow(/zu groß/)
  })

  it('Zurückziehen: Verwerfen einer veröffentlichten Aufgabe ruft DELETE', async () => {
    const { task, draft } = await approvedArticle()
    await publishArticle(db, ws, { taskId: task.id, draftId: draft.id }, fakeApi().fn)
    const [done] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(done!.postedUrl).toBe('https://chatsite.example/de/ratgeber/chatbot-und-dsgvo-was-gilt')
    await updateTask(db, done!, { status: 'verworfen' }, { type: 'user' })
    const jobs = await db.select().from(schema.jobs).where(and(eq(schema.jobs.type, 'withdraw_article')))
    expect(jobs.map(j => j.payload.taskId)).toContain(task.id)
    const calls: string[] = []
    const r = await withdrawArticle(db, ws, { taskId: task.id }, async (url, init) => {
      calls.push(`${init.method} ${url}`)
      if (init.method === 'GET') return new Response(JSON.stringify({ ok: true, articles: [{ key: 'chatbot-und-dsgvo-was-gilt', lang: 'de', url: done!.postedUrl }] }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, key: 'chatbot-und-dsgvo-was-gilt', deleted: 2 }), { status: 200 })
    })
    expect(r.summary).toBe('Zurückgezogen')
    expect(calls).toEqual([`GET ${API}`, `DELETE ${API}?key=chatbot-und-dsgvo-was-gilt`])
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, publishLive: false } }).where(eq(schema.workspaces.id, ws.id))
    await reload()
    const none: string[] = []
    expect((await withdrawArticle(db, ws, { taskId: task.id }, async (url) => { none.push(url); return new Response('{}') })).summary).toContain('Trockenlauf')
    expect(none).toHaveLength(0)
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, publishLive: true } }).where(eq(schema.workspaces.id, ws.id))
    await reload()
  })

  it('Sprache, die die Website nicht annimmt (422 lang): überspringen, merken, Rest veröffentlichen', async () => {
    const { task, draft } = await approvedArticle({ en: '# Chatbots and GDPR\n\nMany ask.' })
    const sent: string[] = []
    const enOnly = async (url: string, init: RequestInit) => {
      if (url !== API) return new Response('', { status: 404 })
      const b = JSON.parse(String(init.body)) as Record<string, string>
      sent.push(b.lang!)
      if (b.lang === 'de') return new Response('{"error":"invalid fields","fields":["lang"]}', { status: 422 })
      return new Response(JSON.stringify({ ok: true, url: `https://linkbox.example/blog/${b.slug}` }), { status: 201 })
    }
    const r = await publishArticle(db, ws, { taskId: task.id, draftId: draft.id }, enOnly)
    expect(r.status).toBe('ok')
    expect(r.summary).toContain('übersprungen: DE')
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(t!.status).toBe('erledigt')
    expect(t!.postedUrl).toBe('https://linkbox.example/blog/chatbots-and-gdpr')
    await reload()
    expect(project.setup.blogApi!.skipLangs).toEqual(['de'])
    const next = await approvedArticle({ en: '# Second\n\nText.' })
    sent.length = 0
    await publishArticle(db, ws, { taskId: next.task.id, draftId: next.draft.id }, enOnly)
    expect(sent).toEqual(['en'])
    await db.update(schema.projects).set({ setup: { ...project.setup, blogApi: { ...project.setup.blogApi!, skipLangs: null } } }).where(eq(schema.projects.id, project.id))
    await reload()
  })

  it('Stufe "direkt raus": Agent übersetzt, gibt selbst frei und plant das Veröffentlichen', async () => {
    expect(decideArticle({ autonomy: {}, setup: project.setup })).toEqual({ action: 'approve', reason: 'level' })
    expect(decideArticle({ autonomy: { content: 'auto_report' }, setup: {} })).toEqual({ action: 'approve', reason: 'no_outlet' })
    expect(decideArticle({ autonomy: { content: 'auto_report' }, setup: project.setup })).toEqual({ action: 'publish', report: true })
    await db.update(schema.projects).set({ autonomy: { content: 'auto_report' } }).where(eq(schema.projects.id, project.id))
    await reload()
    const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: `BA-${++seq}`, title: 'Artikel: Chatbot-Kosten', category: 'content', status: 'geplant', draftKind: 'article', language: 'de', agentStep: 'Artikel entwerfen', dueDate: '2026-10-14', dueTime: '09:00' }).returning()
    const answers = [
      { kind: 'article', subject: 'Was kostet ein Chatbot?', body: 'Die Kosten hängen ab.\n\n## Posten\n\nHosting und KI.' },
      { problems: [] },
      { title: 'What does a chatbot cost?', body: 'Costs vary.\n\n## Items\n\nHosting and AI.' },
    ]
    const llm = async () => new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content: JSON.stringify(answers.shift() ?? { problems: [] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })
    const r = await runDraftTask(db, ws, t!.id, llm as unknown as typeof fetch)
    expect(r.summary).toContain('Veröffentlichen geplant')
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, t!.id))
    expect(d!.status).toBe('freigegeben')
    expect(d!.variants.en).toBe('# What does a chatbot cost?\n\nCosts vary.\n\n## Items\n\nHosting and AI.')
    const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'publish_article'))
    expect(jobs.filter(j => j.payload.taskId === t!.id).map(j => j.payload)).toEqual([expect.objectContaining({ taskId: t!.id, draftId: d!.id, mode: 'auto_report' })])
  })
})

describe('Adapter: WordPress und Webflow', () => {
  const article = { key: 'k', lang: 'de', slug: 'chatbot-kosten', title: 'Was kostet ein Chatbot?', description: 'Kurz erklärt.', body: 'Die **Kosten** hängen ab.\n\n## Posten\n\n- Hosting\n- KI', date: '2026-10-13' }
  function recorder(answer: (url: string, init: RequestInit) => [number, unknown]) {
    const calls: { url: string, method: string, headers: Record<string, string>, body: unknown }[] = []
    const fn = async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
      const [status, body] = answer(url, init)
      return new Response(JSON.stringify(body), { status })
    }
    return { fn, calls }
  }

  it('Markdown wird zu sicherem HTML', () => {
    expect(markdownToHtml('## Titel\n\nText mit **fett** und [Link](https://a.example) <script>\n\n- a\n- b')).toBe('<h2>Titel</h2>\n<p>Text mit <strong>fett</strong> und <a href="https://a.example">Link</a> &lt;script&gt;</p>\n<ul><li>a</li><li>b</li></ul>\n')
    expect(markdownToHtml('[x](javascript:alert)')).toBe('<p>x</p>\n')
  })

  it('WordPress: Anwendungspasswort, neuer Beitrag, bei gleichem Slug Update', async () => {
    const t = buildBlogApi(ws.id, project.id, null, { type: 'wordpress', url: 'https://wp.example/', user: 'peter', token: 'abcd efgh ijkl mnop', status: 'draft', category: 7 })
    const r = recorder((url, init) => url.includes('/posts?slug=') ? [200, []] : init.method === 'POST' ? [201, { id: 5, link: 'https://wp.example/?p=5' }] : [404, {}])
    expect(await publishTo(t, 'abcd efgh ijkl mnop', article, r.fn)).toEqual({ url: 'https://wp.example/?p=5' })
    expect(r.calls[0]!.url).toBe('https://wp.example/wp-json/wp/v2/posts?slug=chatbot-kosten&status=publish,draft,future,pending,private&context=edit')
    expect(r.calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('peter:abcd efgh ijkl mnop').toString('base64')}`)
    expect(r.calls[1]).toMatchObject({ url: 'https://wp.example/wp-json/wp/v2/posts', method: 'POST', body: { title: 'Was kostet ein Chatbot?', slug: 'chatbot-kosten', status: 'draft', categories: [7], excerpt: 'Kurz erklärt.' } })
    expect((r.calls[1]!.body as { content: string }).content).toContain('<strong>Kosten</strong>')
    const u = recorder((url, init) => url.includes('/posts?slug=') ? [200, [{ id: 9 }]] : init.method === 'POST' ? [200, { id: 9, link: 'https://wp.example/chatbot-kosten/' }] : [404, {}])
    await publishTo(t, 'x', article, u.fn)
    expect(u.calls[1]!.url).toBe('https://wp.example/wp-json/wp/v2/posts/9')
    await expect(publishTo(t, 'x', article, recorder(() => [401, {}]).fn)).rejects.toThrow(/Anwendungspasswort falsch/)
  })

  it('Webflow: Item anlegen mit Feld-Zuordnung und veröffentlichen', async () => {
    const t = buildBlogApi(ws.id, project.id, null, { type: 'webflow', url: 'https://site.example/blog', collectionId: 'col123', token: 'wf-token-123456', fields: { title: 'name', slug: 'slug', body: 'inhalt', description: 'summary' } })
    const r = recorder((url) => url.includes('/items?slug=') ? [200, { items: [] }] : url.endsWith('/items') ? [202, { id: 'item1' }] : [202, {}])
    expect(await publishTo(t, 'wf-token-123456', article, r.fn)).toEqual({ url: 'https://site.example/blog/chatbot-kosten' })
    expect(r.calls.map(c => [c.method, c.url])).toEqual([
      ['GET', 'https://api.webflow.com/v2/collections/col123/items?slug=chatbot-kosten'],
      ['POST', 'https://api.webflow.com/v2/collections/col123/items'],
      ['POST', 'https://api.webflow.com/v2/collections/col123/items/publish'],
    ])
    expect(r.calls[1]!.body).toMatchObject({ isDraft: false, fieldData: { name: 'Was kostet ein Chatbot?', slug: 'chatbot-kosten', summary: 'Kurz erklärt.' } })
    expect(r.calls[2]!.body).toEqual({ itemIds: ['item1'] })
    expect(r.calls[0]!.headers.Authorization).toBe('Bearer wf-token-123456')
    const u = recorder((url) => url.includes('/items?slug=') ? [200, { items: [{ id: 'old' }] }] : [200, { id: 'old' }])
    await publishTo(t, 'x', article, u.fn)
    expect([u.calls[1]!.method, u.calls[1]!.url]).toEqual(['PATCH', 'https://api.webflow.com/v2/collections/col123/items/old'])
  })

  it('Zugangsdaten je Art getrennt, Prüfen über den Adapter', async () => {
    const t = buildBlogApi(ws.id, project.id, null, { type: 'wordpress', url: 'https://wp.example', user: 'peter', token: 'app-pass-123456' })
    expect(blogApiToken(ws.id, project.id, t)).toBe('app-pass-123456')
    expect(buildBlogApi(ws.id, project.id, t, { type: 'wordpress', url: 'https://wp.example', user: 'anna' }).secret).toBeNull()
    expect(() => buildBlogApi(ws.id, project.id, null, { type: 'webflow', url: 'https://a.example', token: 'xxxxxxxxxx' })).toThrow(/Collection-ID/)
    const p = { ...project, setup: { ...project.setup, blogApi: t } }
    expect(await checkBlogApi(db, ws, p, async () => new Response('{}', { status: 200 }))).toEqual({ ok: true, error: null })
    expect((await checkBlogApi(db, ws, p, async () => new Response('{}', { status: 401 }))).error).toContain('Anwendungspasswort')
  })
})
