import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blogApiToken, buildBlogApi, checkBlogApi, publicBlogApi, publishArticle } from '../../server/lib/blog-api'
import { publishTo } from '../../server/lib/blog'
import { frontmatterDate, gitArticleUrl, gitBlog, gitFilePath, gitMarkdown, imagePublicPath, normalizeGit, yamlString } from '../../server/lib/blog/git'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { resetSecretCache } from '../../server/lib/secret'

const TOKEN = 'github_pat_1234567890abcdef'
const GH = 'https://api.github.com/repos/kruger/site'
const GIT = { provider: 'github' as const, repo: 'kruger/site', branch: 'main', dir: 'src/content/blog', file: '{slug}.md', publicUrl: 'https://krugercompanion.example/{lang}/blog/{slug}' }
let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let seq = 0

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const article = { key: 'kruger-tipps', lang: 'de', slug: 'kruger-tipps', title: 'Kruger: 5 "Tipps"', description: 'Kurz: was hilft.', body: 'Text mit **fett**.\n\n## Teil\n\nMehr.', date: '2026-10-27', updated: '2026-10-27', aiGenerated: true, mainLang: 'de' }

function recorder(answer: (url: string, init: RequestInit) => [number, unknown]) {
  const calls: { url: string, method: string, headers: Record<string, string>, body: Record<string, unknown> | null }[] = []
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: typeof init.body === 'string' ? JSON.parse(init.body) : null })
    const [status, body] = answer(url, init)
    return new Response(JSON.stringify(body), { status })
  }
  return { fn, calls }
}
const decode = (c: { body: Record<string, unknown> | null }) => Buffer.from(String(c.body?.content), 'base64').toString('utf8')

async function reload() {
  ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
  project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
}
async function approvedArticle(variants: Record<string, string> = {}) {
  const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: `GIT-${++seq}`, title: 'Artikel: Kruger', category: 'content', status: 'freigegeben', draftKind: 'article', language: 'de', dueDate: '2026-10-27' }).returning()
  const [d] = await db.insert(schema.drafts).values({ taskId: t!.id, kind: 'article', subject: 'Kruger Tipps', body: 'Erster Absatz.\n\n## Mehr\n\nText.', variants, status: 'freigegeben', aiGenerated: true }).returning()
  return { task: t!, draft: d! }
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-27T09:00:00+01:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning())[0]!
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'kruger', name: 'Kruger', code: 'KRU', icon: 'globe', url: 'https://krugercompanion.example', languages: ['de', 'en'] }).returning())[0]!
  const blogApi = buildBlogApi(ws.id, project.id, null, { type: 'git', git: GIT, token: TOKEN })
  await db.update(schema.projects).set({ setup: { blog: 'https://krugercompanion.example/de/blog', blogApi } }).where(eq(schema.projects.id, project.id))
  await reload()
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('Git: Frontmatter', () => {
  it('escapt Strings sauber und setzt alle Felder', () => {
    expect(yamlString('a "b": c\nd\u2028')).toBe('"a \\"b\\": c\\nd\\u2028"')
    const md = gitMarkdown({ title: 'Kruger: 5 "Tipps"', description: '# kein Kommentar', date: '2026-10-01', updated: '2026-10-27', slug: 'kruger-tipps', lang: 'de', key: 'kruger-tipps', tags: ['Safari', 'a: b'], image: '/images/blog/x.jpg', canonical: 'https://k.example/de/blog/kruger-tipps', draft: true, aiGenerated: true }, '\r\nText\r\n')
    expect(md).toBe([
      '---',
      'title: "Kruger: 5 \\"Tipps\\""',
      'description: "# kein Kommentar"',
      'date: 2026-10-01',
      'updated: 2026-10-27',
      'slug: "kruger-tipps"',
      'lang: de',
      'translationKey: "kruger-tipps"',
      'tags: ["Safari", "a: b"]',
      'image: "/images/blog/x.jpg"',
      'canonical: "https://k.example/de/blog/kruger-tipps"',
      'draft: true',
      'ai_generated: true',
      '---',
      '',
      'Text',
      '',
    ].join('\n'))
    expect(gitMarkdown({ title: 't', description: 'd', date: '2026-10-01', updated: '2026-10-01', slug: 's', lang: 'en', canonical: 'https://x.example/s' }, 'B')).toContain('ai_generated: false\n---')
    expect(frontmatterDate(md)).toBe('2026-10-01')
    expect(frontmatterDate('kein frontmatter\ndate: 2020-01-01')).toBeNull()
  })
})

describe('Git: Pfade und Sicherheit', () => {
  it('Dateipfad mit Platzhaltern, Sprache und Slug bereinigt', () => {
    expect(gitFilePath(GIT, { slug: 'kruger-tipps', lang: 'de', date: '2026-10-27' })).toBe('src/content/blog/kruger-tipps.md')
    expect(gitFilePath(GIT, { slug: 'kruger-tips', lang: 'en', date: '2026-10-27', mainLang: 'de' })).toBe('src/content/blog/kruger-tips.en.md')
    expect(gitFilePath({ dir: 'content/posts/', file: '{lang}/{date}-{slug}.mdx' }, { slug: 'x', lang: 'en', date: '2026-10-27', mainLang: 'de' })).toBe('content/posts/en/2026-10-27-x.mdx')
    expect(gitFilePath(GIT, { slug: '../../.github/workflows/evil', lang: 'de', date: '2026-10-27' })).toBe('src/content/blog/github-workflows-evil.md')
    expect(() => gitFilePath(GIT, { slug: '../..', lang: 'de', date: '2026-10-27' })).toThrow(/Slug/)
    expect(() => gitFilePath(GIT, { slug: 'x', lang: '../', date: '2026-10-27' })).toThrow(/Sprache/)
    expect(gitArticleUrl(GIT, { slug: 'kruger-tipps', lang: 'de', date: '2026-10-27' })).toBe('https://krugercompanion.example/de/blog/kruger-tipps')
    expect(imagePublicPath('public/images/blog', 'a.jpg')).toBe('/images/blog/a.jpg')
    expect(imagePublicPath('assets/img', 'a.jpg')).toBe('/assets/img/a.jpg')
  })

  it('lehnt unsichere Ordner, Muster und Repos ab', () => {
    const ok = normalizeGit({ ...GIT, dir: './src/content/blog/', file: '' })
    expect(ok).toMatchObject({ dir: 'src/content/blog', file: '{slug}.md', base: null, imageDir: null })
    expect(normalizeGit({ ...GIT, provider: 'gitlab', repo: 'https://gitlab.example.com/grp/sub/site.git', base: 'https://gitlab.example.com/' })).toMatchObject({ repo: 'grp/sub/site', base: 'https://gitlab.example.com' })
    for (const dir of ['../x', 'src/../..', '.github/workflows', 'src/.git', '', '/']) expect(() => normalizeGit({ ...GIT, dir }), dir).toThrow(/Ordner/)
    for (const file of ['post.md', '{slug}.html', '../{slug}.md', '{slug}/../../x.md', '{title}-{slug}.md', '{date}/{slug}.md']) expect(() => normalizeGit({ ...GIT, file }), file).toThrow()
    expect(() => normalizeGit({ ...GIT, repo: 'nur-name' })).toThrow(/owner\/name/)
    expect(() => normalizeGit({ ...GIT, branch: 'a..b' })).toThrow(/Branch/)
    expect(() => normalizeGit({ ...GIT, publicUrl: 'https://x.example/blog' })).toThrow(/\{slug\}/)
    expect(() => normalizeGit({ ...GIT, provider: 'gitlab', base: 'http://gitlab.example.com' })).toThrow(/https/)
    expect(() => normalizeGit({ ...GIT, imageDir: '../img' })).toThrow(/Bilder-Ordner/)
  })

  it('Token verschlüsselt, nie im Klartext, an Repo gebunden', () => {
    const b = project.setup.blogApi!
    expect(b.url).toBe('https://github.com/kruger/site')
    expect(JSON.stringify(project.setup)).not.toContain(TOKEN)
    expect(JSON.stringify(publicBlogApi(b))).not.toContain(TOKEN)
    expect(publicBlogApi(b)!.git).toMatchObject({ repo: 'kruger/site', dir: 'src/content/blog' })
    expect(blogApiToken(ws.id, project.id, b)).toBe(TOKEN)
    expect(buildBlogApi(ws.id, project.id, b, { type: 'git', git: { ...GIT, dir: 'content/blog', branch: 'live' } }).secret).toEqual(b.secret)
    expect(buildBlogApi(ws.id, project.id, b, { type: 'git', git: { ...GIT, repo: 'other/site' } }).secret).toBeNull()
  })
})

describe('Git: GitHub', () => {
  const t = buildBlogApi('w', 'p', null, { type: 'git', git: GIT, token: TOKEN })

  it('legt neue Datei an', async () => {
    const r = recorder((url, init) => init.method === 'GET' ? [404, { message: 'Not Found' }] : [201, { content: { sha: 'new' } }])
    expect(await publishTo(t, TOKEN, article, r.fn)).toEqual({ url: 'https://krugercompanion.example/de/blog/kruger-tipps' })
    expect(r.calls.map(c => [c.method, c.url])).toEqual([
      ['GET', `${GH}/contents/src/content/blog/kruger-tipps.md?ref=main`],
      ['PUT', `${GH}/contents/src/content/blog/kruger-tipps.md`],
    ])
    expect(r.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(r.calls[1]!.body).toMatchObject({ message: 'Aimarage: Artikel Kruger: 5 "Tipps"', branch: 'main' })
    expect(r.calls[1]!.body).not.toHaveProperty('sha')
    const md = decode(r.calls[1]!)
    expect(md).toContain('title: "Kruger: 5 \\"Tipps\\""\n')
    expect(md).toContain('canonical: "https://krugercompanion.example/de/blog/kruger-tipps"\n')
    expect(md).toContain('ai_generated: true\n---\n\nText mit **fett**.')
  })

  it('aktualisiert dieselbe Datei mit sha und behält das erste Datum', async () => {
    const old = gitMarkdown({ title: 'Alt', description: 'd', date: '2026-10-01', updated: '2026-10-01', slug: 'kruger-tipps', lang: 'de', canonical: 'https://x.example' }, 'Alt')
    const r = recorder((url, init) => init.method === 'GET' ? [200, { sha: 'abc123', content: b64(old) }] : [200, {}])
    await publishTo(t, TOKEN, { ...article, date: null }, r.fn)
    expect(r.calls[1]!.body).toMatchObject({ sha: 'abc123' })
    expect(decode(r.calls[1]!)).toContain('date: 2026-10-01\nupdated: 2026-10-27\n')
  })

  it('ohne Änderung kein Commit', async () => {
    const first = recorder((url, init) => init.method === 'GET' ? [404, {}] : [201, {}])
    await publishTo(t, TOKEN, article, first.fn)
    const same = decode(first.calls[1]!)
    const r = recorder(() => [200, { sha: 's', content: b64(same) }])
    await publishTo(t, TOKEN, article, r.fn)
    expect(r.calls.map(c => c.method)).toEqual(['GET'])
  })

  it('{date} im Dateinamen findet die vorhandene Datei', async () => {
    const td = buildBlogApi('w', 'p', null, { type: 'git', git: { ...GIT, file: '{date}-{slug}.md' }, token: TOKEN })
    const r = recorder((url, init) => url.includes('/contents/src/content/blog?') ? [200, [{ type: 'file', name: '2026-10-01-kruger-tipps.md' }, { type: 'file', name: '2026-10-02-anderer.md' }]] : init.method === 'GET' ? [200, { sha: 'x', content: b64('---\ndate: 2026-10-01\n---\nalt') }] : [200, {}])
    await publishTo(td, TOKEN, { ...article, date: null }, r.fn)
    expect(r.calls.map(c => [c.method, c.url])).toEqual([
      ['GET', `${GH}/contents/src/content/blog?ref=main`],
      ['GET', `${GH}/contents/src/content/blog/2026-10-01-kruger-tipps.md?ref=main`],
      ['PUT', `${GH}/contents/src/content/blog/2026-10-01-kruger-tipps.md`],
    ])
  })

  it('Fehler ohne Token im Text', async () => {
    await expect(publishTo(t, TOKEN, article, recorder(() => [401, {}]).fn)).rejects.toThrow(/Token abgelehnt/)
    const r = recorder((url, init) => init.method === 'GET' ? [404, {}] : [403, { message: `bad ${TOKEN}` }])
    await expect(publishTo(t, TOKEN, article, r.fn)).rejects.toThrow(/Contents: Read and write/)
  })

  it('Prüfen: Repo, Branch und Schreibrecht ohne Commit', async () => {
    const r = recorder((url, init) => init.method === 'POST' ? [201, { sha: 'e69de29' }] : [200, {}])
    await gitBlog.check(t, TOKEN, r.fn)
    expect(r.calls.map(c => [c.method, c.url])).toEqual([
      ['GET', GH],
      ['GET', `${GH}/branches/main`],
      ['POST', `${GH}/git/blobs`],
    ])
    expect(r.calls.some(c => c.method === 'PUT' || c.url.includes('/commits') || c.url.includes('/refs'))).toBe(false)
    await expect(gitBlog.check(t, TOKEN, recorder((url) => url.endsWith('/branches/main') ? [404, {}] : [200, {}]).fn)).rejects.toThrow(/Branch main/)
    await expect(gitBlog.check(t, TOKEN, recorder((url, init) => init.method === 'POST' ? [403, {}] : [200, {}]).fn)).rejects.toThrow(/schreiben/)
  })

  it('Bild in den Bilder-Ordner, öffentlicher Pfad', async () => {
    const ti = buildBlogApi('w', 'p', null, { type: 'git', git: { ...GIT, imageDir: 'public/images/blog' }, token: TOKEN })
    const r = recorder((url, init) => init.method === 'GET' ? [404, {}] : [201, {}])
    const path = await gitBlog.uploadImage!(ti, TOKEN, { name: 'Elefant am Fluss.JPG', mime: 'image/jpeg', data: new Uint8Array([1, 2, 3]) }, r.fn)
    expect(path).toMatch(/^\/images\/blog\/elefant-am-fluss-[0-9a-f]{10}\.jpg$/)
    expect(r.calls[1]!.url).toMatch(/\/contents\/public\/images\/blog\/elefant-am-fluss-[0-9a-f]{10}\.jpg$/)
  })
})

describe('Git: GitLab', () => {
  const GL = 'https://gitlab.example.com/api/v4/projects/grp%2Fsite'
  const t = buildBlogApi('w', 'p', null, { type: 'git', git: { ...GIT, provider: 'gitlab', base: 'https://gitlab.example.com', repo: 'grp/site' }, token: 'glpat-1234567890' })

  it('legt an mit POST und aktualisiert mit PUT und last_commit_id', async () => {
    expect(t.url).toBe('https://gitlab.example.com/grp/site')
    const r = recorder((url, init) => init.method === 'GET' ? [404, { message: '404 File Not Found' }] : [201, { file_path: 'x' }])
    await publishTo(t, 'glpat-1234567890', article, r.fn)
    expect(r.calls.map(c => [c.method, c.url])).toEqual([
      ['GET', `${GL}/repository/files/src%2Fcontent%2Fblog%2Fkruger-tipps.md?ref=main`],
      ['POST', `${GL}/repository/files/src%2Fcontent%2Fblog%2Fkruger-tipps.md`],
    ])
    expect(r.calls[0]!.headers['PRIVATE-TOKEN']).toBe('glpat-1234567890')
    expect(r.calls[1]!.body).toMatchObject({ branch: 'main', encoding: 'base64', commit_message: 'Aimarage: Artikel Kruger: 5 "Tipps"' })
    const u = recorder((url, init) => init.method === 'GET' ? [200, { content: b64('---\ndate: 2026-09-30\n---\nalt'), last_commit_id: 'c0ffee' }] : [200, {}])
    await publishTo(t, 'x', { ...article, date: null }, u.fn)
    expect(u.calls[1]!.method).toBe('PUT')
    expect(u.calls[1]!.body).toMatchObject({ last_commit_id: 'c0ffee' })
    expect(decode(u.calls[1]!)).toContain('date: 2026-09-30\n')
  })

  it('Prüfen: Bereich api und can_push', async () => {
    const ok = recorder((url) => url.endsWith('/personal_access_tokens/self') ? [200, { scopes: ['api'] }] : url.includes('/branches/') ? [200, { can_push: true }] : [200, {}])
    await gitBlog.check(t, 'x', ok.fn)
    expect(ok.calls.every(c => c.method === 'GET')).toBe(true)
    await expect(gitBlog.check(t, 'x', recorder((url) => url.endsWith('/self') ? [200, { scopes: ['write_repository'] }] : [200, {}]).fn)).rejects.toThrow(/Bereich api/)
    await expect(gitBlog.check(t, 'x', recorder((url) => url.includes('/branches/') ? [200, { can_push: false }] : [200, { scopes: ['api'] }]).fn)).rejects.toThrow(/nicht auf main schreiben/)
  })
})

describe('Git: Veröffentlichen nach Freigabe', () => {
  it('Trockenlauf committet nichts', async () => {
    const { task, draft } = await approvedArticle()
    const r = recorder(() => [500, {}])
    const res = await publishArticle(db, ws, { taskId: task.id, draftId: draft.id }, r.fn)
    expect(res.summary).toContain('Trockenlauf')
    expect(res.summary).toContain('krugercompanion.example')
    expect(r.calls).toHaveLength(0)
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))
    expect(notes.map(n => n.text).join('\n')).toContain('Commit in kruger/site')
  })

  it('live: eine Datei je Sprache, Link und KI-Kennzeichnung', async () => {
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, publishLive: true } }).where(eq(schema.workspaces.id, ws.id))
    await reload()
    const { task, draft } = await approvedArticle({ en: '# Kruger tips\n\nFirst paragraph.' })
    const r = recorder((url, init) => init.method === 'GET' ? [404, {}] : [201, {}])
    const res = await publishArticle(db, ws, { taskId: task.id, draftId: draft.id }, r.fn)
    expect(res.status).toBe('ok')
    const puts = r.calls.filter(c => c.method === 'PUT')
    expect(puts.map(c => c.url)).toEqual([`${GH}/contents/src/content/blog/kruger-tipps.md`, `${GH}/contents/src/content/blog/kruger-tips.en.md`])
    expect(decode(puts[1]!)).toContain('lang: en\ntranslationKey: "kruger-tipps"\n')
    expect(puts.every(c => decode(c).includes('ai_generated: true'))).toBe(true)
    const [after] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(after!.status).toBe('erledigt')
    expect(after!.postedUrl).toBe('https://krugercompanion.example/de/blog/kruger-tipps')
    expect(await checkBlogApi(db, ws, project, recorder((url, init) => init.method === 'POST' ? [201, {}] : [200, {}]).fn)).toEqual({ ok: true, error: null })
  })
})
