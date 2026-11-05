import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDraftTask } from '../../server/lib/agent'
import { reviewerPrompt } from '../../server/lib/ai-reviewer'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { contentLink, crawlSite, pageKey, pagesStale, projectPages, relevantPages, savePages, type PageLike } from '../../server/lib/site-pages'
import { AD_RULES, draftPrompt, PAGES_HEAD, RESEARCH_RULE } from '../../server/prompts/de'

const html = (title: string, main: string, extra = '') => `<html><head><title>${title}</title></head><body><nav>Menü Login</nav>${extra}<main>${main}</main><footer>Impressum</footer></body></html>`

const SITE: Record<string, string> = {
  'https://band.example/': html('The Band', '<h1>Willkommen</h1><a href="/music/orbit">Orbit</a><a href="/privacy">Datenschutz</a><a href="https://open.spotify.com/album/1">Spotify</a>'),
  'https://band.example/music/orbit': html('Orbit - Album', '<h1>Orbit</h1><p>Unser Album Orbit.</p><a href="https://shop.example/artists/band/track/moonbase?utm_source=x">Moonbase</a><a href="https://shop.example/artists/band/track/dust">Dust</a><a href="https://shop.example/press/kit">Presse</a><a href="https://shop.example/">Shop</a>'),
  'https://shop.example/artists/band/track/moonbase': html('Moonbase - The Band (Lyrics)', '<h1>Moonbase</h1><p>from Orbit</p><h2>Lyrics</h2><p>I wake in the dome, dust on my boots</p>'),
  'https://shop.example/artists/band/track/dust': html('Dust - The Band (Lyrics)', '<h1>Dust</h1><p>from Orbit</p><h2>Lyrics</h2><p>Sixteen red panels blinking the truth</p>'),
}

function web() {
  const calls: string[] = []
  const fn = async (url: string) => {
    calls.push(url)
    if (url === 'https://shop.example/robots.txt') return new Response('User-agent: *\nDisallow: /press/', { status: 200, headers: { 'content-type': 'text/plain' } })
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 })
    const body = SITE[url]
    return body ? new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } })
  }
  return { fn: fn as unknown as typeof fetch, calls }
}

describe('Website einlesen', () => {
  it('liest eigene Seiten und direkt verlinkte Inhaltsseiten, beachtet robots.txt und lässt Plattformen weg', async () => {
    const w = web()
    const r = await crawlSite('band.example', { fetchImpl: w.fn, delayMs: 0 })
    const urls = r.pages.map(p => p.url)
    expect(urls).toEqual(['https://band.example/', 'https://band.example/music/orbit', 'https://shop.example/artists/band/track/moonbase', 'https://shop.example/artists/band/track/dust'])
    expect(w.calls).not.toContain('https://band.example/privacy')
    expect(w.calls.some(u => u.includes('spotify'))).toBe(false)
    expect(w.calls).not.toContain('https://shop.example/press/kit')
    const moon = r.pages.find(p => p.url.endsWith('/moonbase'))!
    expect(moon.text).toContain('I wake in the dome')
    expect(moon.text).not.toContain('Menü')
    expect(moon.linkedFrom).toBe('https://band.example/music/orbit')
  })

  it('erkennt Inhaltslinks und vereinheitlicht Adressen', () => {
    expect(contentLink('https://shop.example/artists/band/track/moonbase')).toBe(true)
    expect(contentLink('https://shop.example/')).toBe(false)
    expect(contentLink('https://music.apple.com/us/album/1')).toBe(false)
    expect(contentLink('https://www.instagram.com/band')).toBe(false)
    expect(contentLink('https://shop.example/terms')).toBe(false)
    expect(pageKey('https://a.example/x/?utm_source=x#top')).toBe('https://a.example/x')
  })

  it('wählt passende Seiten zur Aufgabe, verlinkte Seiten einer Trefferseite zählen mit', () => {
    const pages: PageLike[] = [
      { url: 'https://band.example/', title: 'The Band', description: null, text: 'Willkommen', image: null, linkedFrom: null },
      { url: 'https://band.example/music/orbit', title: 'Orbit - Album', description: null, text: 'Unser Album Orbit', image: null, linkedFrom: 'https://band.example/' },
      { url: 'https://shop.example/track/moonbase', title: 'Moonbase', description: null, text: 'from Orbit. Lyrics: I wake in the dome', image: 'https://shop.example/m.jpg', linkedFrom: 'https://band.example/music/orbit' },
      { url: 'https://band.example/blog/tour', title: 'Tour', description: null, text: 'Konzerte im Herbst', image: null, linkedFrom: 'https://band.example/' },
    ]
    const sel = relevantPages(pages, 'Orbit: Track by Track', 10_000).map(x => x.page.url)
    expect(sel).toContain('https://band.example/music/orbit')
    expect(sel).toContain('https://shop.example/track/moonbase')
    expect(sel).not.toContain('https://band.example/blog/tour')
    expect(relevantPages(pages, 'Orbit', 10, {}).length).toBe(0)
    expect(relevantPages(pages, 'xyz', 10_000, { pick: ['https://band.example/blog/tour/'] }).map(x => x.page.url)).toEqual(['https://band.example/blog/tour'])
  })
})

describe('Prompts', () => {
  const task = { code: 'T-1', title: 'Orbit: Track by Track', description: null, category: 'content', channel: 'Blog', language: 'en', agentStep: null, humanStep: null, draftKind: 'article', targetUrl: null, metric: null }

  it('Artikel bekommt die öffentlichen Seiten und den Recherche-Auftrag', () => {
    const p = draftPrompt({ project: null, task, memory: [], notes: [], previous: null, utmUrl: null, type: 'article', pages: ['Seite https://shop.example/track/moonbase (Moonbase):\nI wake in the dome'] })
    expect(p).toContain(PAGES_HEAD)
    expect(p).toContain('I wake in the dome')
    expect(p).toContain(RESEARCH_RULE)
    expect(draftPrompt({ project: null, task, memory: [], notes: [], previous: null, utmUrl: null, type: 'article' })).not.toContain(RESEARCH_RULE)
  })

  it('Social-Posts sollen abwechseln statt nummerierter Serien', () => {
    expect(AD_RULES).toContain('Track 3 of 12')
    expect(AD_RULES).toContain('Abwechslung')
  })

  it('KI-Prüfer lässt belegte Deutungen stehen', () => {
    const p = reviewerPrompt({ task: { title: 'Artikel', description: null, category: 'content', channel: null, language: 'en' }, type: 'article', platform: null, kind: 'article', draft: { subject: 'x', body: 'y', variants: {}, recipient: null }, platforms: [], rules: null, facts: { known: [], avoid: [] }, projectData: 'a'.repeat(30_000), release: null, subreddit: null, recent: [], lessons: [] })
    expect(p).toContain('Deutungen und Beschreibungen von Inhalten')
    expect(p).toContain('a'.repeat(30_000))
  })
})

describe('Projektwissen in der Datenbank und beim Artikel', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  let project: typeof schema.projects.$inferSelect

  beforeAll(async () => {
    ;({ db, close } = await openTestDb())
    ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning())[0]!
    project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'band', name: 'The Band', code: 'BND', icon: 'B', url: 'https://band.example/', languages: ['en'] }).returning())[0]!
  })
  afterAll(async () => {
    await close()
  })

  it('speichert Seiten, ersetzt sie beim nächsten Lauf und merkt sich das Alter', async () => {
    expect(pagesStale([])).toBe(true)
    await savePages(db, project.id, [{ url: 'https://band.example/alt', title: 'Alt', description: null, text: 'alt', image: null, linkedFrom: null }])
    const r = await crawlSite('https://band.example/', { fetchImpl: web().fn, delayMs: 0 })
    expect(await savePages(db, project.id, r.pages)).toBe(4)
    const stored = await projectPages(db, project.id)
    expect(stored.map(p => p.url)).not.toContain('https://band.example/alt')
    expect(pagesStale(stored)).toBe(false)
    expect(pagesStale(stored, new Date(Date.now() + 8 * 86_400_000))).toBe(true)
    await db.delete(schema.projectPages).where(eq(schema.projectPages.projectId, project.id))
  })

  it('Artikel: liest die Website ein, recherchiert und gibt die Lyrics in den Prompt', async () => {
    const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'BND-1', title: 'Orbit: Track by Track', category: 'content', status: 'geplant', dueDate: '2026-10-30', agentStep: 'Artikel schreiben', draftKind: 'article', language: 'en' }).returning()
    const prompts: string[] = []
    const answer = (content: string) => new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 })
    const llm = (async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { messages: { role: string, content: string }[] }
      const user = b.messages.find(m => m.role === 'user')!.content
      prompts.push(user)
      if (user.startsWith('Recherche für einen Blog-Artikel')) return answer(JSON.stringify({ urls: ['https://shop.example/artists/band/track/dust'] }))
      if (user.startsWith('Prüfe diesen')) return answer('{"problems": []}')
      return answer(JSON.stringify({ kind: 'article', subject: 'Orbit, track by track', body: '## Dust\nSixteen red panels.' }))
    }) as unknown as typeof fetch
    const out = await runDraftTask(db, ws, t!.id, llm, { webFetch: web().fn })
    expect(out.status).toBe('ok')
    expect((await projectPages(db, project.id)).length).toBe(4)
    const draft = prompts.find(p => p.startsWith('Erstelle einen fertigen Entwurf'))!
    expect(draft).toContain(PAGES_HEAD)
    expect(draft).toContain('Sixteen red panels blinking the truth')
    expect(draft).toContain('I wake in the dome')
    expect(draft).toContain(RESEARCH_RULE)
  })
})

describe('Social-Post ohne passendes Thema', () => {
  it('wechselt die Inhaltsseiten je Aufgabe', async () => {
    const { rotatePages } = await import('../../server/lib/agent')
    const pages = Array.from({ length: 6 }, (_, i) => ({ url: `https://a.example/p${i}`, text: 'x'.repeat(i === 5 ? 100 : 600) }))
    const a = rotatePages(pages, 'task-a')
    expect(a).toHaveLength(2)
    expect(a).not.toContain('https://a.example/p5')
    expect(new Set(['t1', 't2', 't3', 't4', 't5', 't6'].map(s => rotatePages(pages, s)[0])).size).toBeGreaterThan(1)
    expect(rotatePages([], 'x')).toEqual([])
  })
})
