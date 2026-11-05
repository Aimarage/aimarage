import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { llmConfig } from '../../server/lib/llm'
import { matchChannel } from '../../server/lib/channel-match'
import { reconcileNews, reconcileProject } from '../../server/lib/reconcile'
import { activateStrategy, createStrategyVersion, reconcileKey, strategyShifted } from '../../server/lib/strategy'
import { updateTask } from '../../server/lib/tasks'
import { openStaleHint, STALE_DROP, STALE_HINT, STALE_KEEP } from '../../shared/utils/stale'
import type { StrategyChannel } from '../../server/db/schema'

const ch = (key: string, name: string, category: string, extra: Partial<StrategyChannel> = {}): StrategyChannel => ({ key, name, category, why: 'w', goalIds: [], weight: 3, days: ['TU'], active: true, places: [], topics: [], ...extra })

describe('Strategie-Änderung erkennen (ohne Datenbank)', () => {
  it('nur Takt geändert zählt nicht, Kanal weg, pausiert, Themen oder Kurzfassung schon', () => {
    const a = { summary: 'S', channels: [ch('a', 'A', 'social', { topics: ['x'] }), ch('b', 'B', 'community')] }
    expect(strategyShifted(a, { ...a, channels: a.channels.map(c => ({ ...c, weight: 6 })) })).toBe(false)
    expect(strategyShifted(a, { ...a, channels: [a.channels[0]!] })).toBe(true)
    expect(strategyShifted(a, { ...a, channels: [a.channels[0]!, { ...a.channels[1]!, active: false }] })).toBe(true)
    expect(strategyShifted(a, { ...a, channels: [{ ...a.channels[0]!, topics: ['y'] }, a.channels[1]!] })).toBe(true)
    expect(strategyShifted(a, { ...a, summary: 'Neu' })).toBe(true)
  })

  it('offener Hinweis bis zur Entscheidung Behalten', () => {
    const hint = { text: `${STALE_HINT} Kanal weg. Verwerfen?`, createdAt: '2026-10-12T08:00:00Z' }
    expect(openStaleHint([hint])).toBe('Kanal weg.')
    expect(openStaleHint([hint, { text: `${STALE_KEEP} passt weiter`, createdAt: '2026-10-12T09:00:00Z' }])).toBeNull()
    expect(openStaleHint([{ text: 'Info nötig: x', createdAt: '2026-10-12T08:00:00Z' }])).toBeNull()
  })
})

describe('Abgleich offener Aufgaben bei Planänderung', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  let project: typeof schema.projects.$inferSelect
  let userId: string
  const prompts: string[] = []
  let answer = ''
  const llmFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[] }
    prompts.push(body.messages.at(-1)!.content)
    return new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content: answer } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const llm = llmConfig({ provider: 'ollama', model: 'mock' })

  beforeAll(async () => {
    process.env.MA_NOW = '2026-10-01T09:00:00+02:00'
    ;({ db, close } = await openTestDb())
    ws = (await db.insert(schema.workspaces).values({ name: 'Test' }).returning())[0]!
    const [u] = await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning()
    userId = u!.id
    project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'tv', name: 'The Wanderer', code: 'TVS', icon: 'T' }).returning())[0]!
    const v1 = await createStrategyVersion(db, project, { channels: [ch('posts', 'Release-Posts', 'verzeichnis'), ch('reddit', 'Reddit', 'community')], summary: 'Altes Album', status: 'vorschlag', kind: 'initial', byAgent: true })
    await activateStrategy(db, project, v1, '2026-10-01', { userId })
    process.env.MA_NOW = '2026-10-12T09:00:00+02:00'
  })
  afterAll(async () => {
    delete process.env.MA_NOW
    await close()
  })

  it('verwirft Agenten-Aufgaben ohne menschliche Spuren, schlägt den Rest nur vor', async () => {
    const base = { workspaceId: ws.id, projectId: project.id, category: 'community' as const, dueDate: '2026-10-15', agentStep: 'Entwurf', draftKind: 'text' as const }
    const rows = await db.insert(schema.tasks).values([
      { ...base, code: 'TVS-COM-901', title: 'Antwort in r/music', strategyChannel: 'reddit' },
      { ...base, code: 'TVS-COM-902', title: 'Thread in r/indie', strategyChannel: 'reddit' },
      { ...base, code: 'TVS-VER-903', title: 'Teaser zum alten Album', category: 'verzeichnis', strategyChannel: 'posts' },
      { ...base, code: 'TVS-VER-904', title: 'Neues Album eintragen', category: 'verzeichnis', strategyChannel: 'posts' },
      { ...base, code: 'TVS-VER-905', title: 'Albumcover-Aktion', category: 'verzeichnis', strategyChannel: 'posts', createdByUserId: userId },
      { ...base, code: 'TVS-VER-906', title: 'Freigegebenes zum alten Album', category: 'verzeichnis', strategyChannel: 'posts', status: 'freigegeben' },
      { ...base, code: 'TVS-VER-907', title: 'Entwurf vom Menschen', category: 'verzeichnis', strategyChannel: 'posts', status: 'entwurf_fertig' },
    ]).returning()
    const id = (code: string) => rows.find(r => r.code === code)!.id
    await db.insert(schema.taskNotes).values({ taskId: id('TVS-COM-902'), byAgent: false, userId, text: 'Bitte mit Link zum Shop' })
    await db.insert(schema.drafts).values({ taskId: id('TVS-VER-907'), body: 'Selbst geschrieben', byAgent: false })

    const v2 = await createStrategyVersion(db, project, { channels: [ch('posts', 'Release-Posts', 'verzeichnis', { topics: ['Neues Album'] })], summary: 'Neues Album zuerst', status: 'vorschlag', kind: 'rethink', byAgent: true })
    await activateStrategy(db, project, v2, '2026-10-12', { userId })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.dedupeKey, reconcileKey(project.id, v2.id, '2026-10-12')))
    expect(job?.type).toBe('reconcile_tasks')

    answer = JSON.stringify({ decisions: [
      { code: 'TVS-VER-903', action: 'drop', reason: 'Altes Album, Strategie dreht sich um das neue.' },
      { code: 'TVS-VER-904', action: 'keep', reason: '' },
      { code: 'TVS-VER-905', action: 'drop', reason: 'Anlass vorbei.' },
      { code: 'TVS-VER-907', action: 'drop', reason: 'Doppelt.' },
    ] })
    const r = await reconcileProject(db, ws, project, { llm, llmFetch })
    expect(r.dropped.filter(c => /-9\d\d$/.test(c)).sort()).toEqual(['TVS-COM-901', 'TVS-VER-903'])
    expect(r.suggested.sort()).toEqual(['TVS-COM-902', 'TVS-VER-905', 'TVS-VER-907'])
    expect(prompts.at(-1)).toContain('Neues Album zuerst')
    expect(prompts.at(-1)).toContain('TVS-VER-904')
    expect(prompts.at(-1)).not.toContain('TVS-COM-901')
    expect(prompts.at(-1)).not.toContain('TVS-VER-906')

    const st = Object.fromEntries((await db.select().from(schema.tasks).where(inArray(schema.tasks.id, rows.map(x => x.id)))).map(t => [t.code, t.status]))
    expect(st).toEqual({ 'TVS-COM-901': 'verworfen', 'TVS-COM-902': 'geplant', 'TVS-VER-903': 'verworfen', 'TVS-VER-904': 'geplant', 'TVS-VER-905': 'geplant', 'TVS-VER-906': 'freigegeben', 'TVS-VER-907': 'entwurf_fertig' })
    const [drop] = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, id('TVS-COM-901')))
    expect(drop!.text).toBe(`${STALE_DROP} Kanal "Reddit" steht nicht mehr in der Strategie. Zurückholen: Status auf "geplant" setzen.`)
    const hint = (await db.select().from(schema.taskNotes).where(and(eq(schema.taskNotes.taskId, id('TVS-VER-905')), eq(schema.taskNotes.byAgent, true))))[0]!
    expect(hint.text).toBe(`${STALE_HINT} Anlass vorbei. Verwerfen?`)
    expect(openStaleHint([{ text: hint.text, createdAt: hint.createdAt }])).toBe('Anlass vorbei.')

    const news = await reconcileNews(db, ws.id, new Date('2026-10-01T00:00:00Z'))
    expect(news).toContain(`The Wanderer: ${r.dropped.length} veraltete Aufgaben nach Strategie-Änderung entfernt`)
    expect(news.some(n => n.startsWith('The Wanderer: 3 Aufgaben passen evtl. nicht mehr'))).toBe(true)

    const restored = await updateTask(db, rows.find(x => x.code === 'TVS-VER-903')!, { status: 'verworfen' }, { type: 'agent' }).then(t => updateTask(db, t, { status: 'geplant' }, { type: 'user', userId }))
    expect(restored.status).toBe('geplant')
  })

  it('zweiter Lauf: kein doppelter Hinweis, wiederhergestellte Aufgabe gilt als vom Menschen', async () => {
    answer = JSON.stringify({ decisions: [{ code: 'TVS-VER-903', action: 'drop', reason: 'Altes Album.' }] })
    const r = await reconcileProject(db, ws, project, { llm, llmFetch })
    expect(r.dropped).toEqual([])
    expect(r.suggested).toEqual(['TVS-VER-903'])
    expect(prompts.at(-1)).not.toContain('TVS-VER-905')
  })

  it('ohne KI nur die festen Regeln, abgeschalteter Agent macht nichts', async () => {
    const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'TVS-COM-908', title: 'Noch ein Reddit-Thread', category: 'community', dueDate: '2026-10-20', agentStep: 'Entwurf', strategyChannel: 'reddit' }).returning()
    const off = { ...ws, settings: { ...ws.settings, agentEnabled: false } }
    expect((await reconcileProject(db, off, project, { llm: null })).dropped).toEqual([])
    const n = prompts.length
    const r = await reconcileProject(db, ws, project, { llm: null })
    expect(r.dropped).toEqual(['TVS-COM-908'])
    expect(prompts.length).toBe(n)
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, t!.id)))[0]!.status).toBe('verworfen')
  })

  it('Artikel mit fertigem Entwurf nie automatisch verwerfen, nur Hinweis', async () => {
    const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: 'TVS-CON-909', title: 'Artikel: Bandcamp-Alternative', category: 'content', draftKind: 'article', status: 'entwurf_fertig', dueDate: '2026-10-21', agentStep: 'Entwurf', strategyChannel: 'reddit' }).returning()
    await db.insert(schema.drafts).values({ taskId: t!.id, kind: 'article', body: 'Fertiger Artikel', byAgent: true })
    const r = await reconcileProject(db, ws, project, { llm: null })
    expect(r.dropped).not.toContain('TVS-CON-909')
    expect(r.suggested).toContain('TVS-CON-909')
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, t!.id)))[0]!.status).toBe('entwurf_fertig')
  })
})

describe('Kanal umbenannt oder neu geschnitten', () => {
  const v8 = [
    ch('video', 'Video-Social (Instagram & Facebook)', 'social', { places: ['Instagram @the_wanderer_ai (Reels)', 'Facebook'] }),
    ch('nische', 'X und Bluesky (Nische)', 'social', { places: ['X @thewandererai', 'Bluesky @thewandererai.bsky.social'] }),
    ch('blog', 'Blog und Ratgeber', 'content', { places: ['https://thewandererai.com/blog'] }),
  ]

  it('ordnet nach Plattform bzw. Inhaltsart zu, nicht nach dem Namen', () => {
    const post = { category: 'social', channel: 'Social Media', title: 'Social-Posts zum Artikel: Superposition' }
    expect(matchChannel(post, ['bluesky', 'x', 'instagram'], v8, 'Social Media')).toEqual({ channel: v8[1], covered: true })
    expect(matchChannel(post, ['instagram'], v8, 'Social Media').channel?.key).toBe('video')
    expect(matchChannel({ category: 'content', channel: 'Content & Blog', title: 'Ratgeber: Lossless', draftKind: 'article' }, [], v8, 'Content & Blog').channel?.key).toBe('blog')
    expect(matchChannel({ category: 'social', channel: 'Social Media', title: 'Post auf Mastodon' }, [], v8, 'Social Media')).toEqual({ channel: null, covered: false })
    expect(matchChannel({ category: 'social', channel: 'Social Media', title: 'Post' }, ['mastodon'], v8)).toEqual({ channel: null, covered: false })
  })

  it('hängt Aufgaben beim Übernehmen um, Hinweis nur ohne passende Plattform', async () => {
    process.env.MA_NOW = '2026-11-02T09:00:00+01:00'
    const { db, close } = await openTestDb()
    try {
      const [ws] = await db.insert(schema.workspaces).values({ name: 'Test' }).returning()
      const [u] = await db.insert(schema.users).values({ email: 'p@test.local', name: 'Peter' }).returning()
      const [project] = await db.insert(schema.projects).values({ workspaceId: ws!.id, slug: 'tv2', name: 'The Wanderer', code: 'THE', icon: 'T' }).returning()
      const v1 = await createStrategyVersion(db, project!, { channels: [ch('social-media', 'Social Media', 'social'), ch('content-blog', 'Content & Blog', 'content')], summary: 'Alt', status: 'vorschlag', kind: 'initial', byAgent: true })
      await activateStrategy(db, project!, v1, '2026-11-02', { userId: u!.id })
      const base = { workspaceId: ws!.id, projectId: project!.id, dueDate: '2026-11-05', agentStep: 'Entwurf' }
      const rows = await db.insert(schema.tasks).values([
        { ...base, code: 'THE-SOC-050', title: 'Social-Posts zum Artikel: Superposition', category: 'social', channel: 'Social Media', draftKind: 'post', status: 'freigegeben', strategyChannel: 'social-media' },
        { ...base, code: 'THE-CON-015', title: 'Ratgeber: Lossless direkt vom Künstler', category: 'content', channel: 'Content & Blog', draftKind: 'article', status: 'entwurf_fertig', strategyChannel: 'content-blog' },
        { ...base, code: 'THE-SOC-060', title: 'Post auf Mastodon', category: 'social', channel: 'Social Media', draftKind: 'post', strategyChannel: 'social-media', createdByUserId: u!.id },
      ]).returning()
      const id = (code: string) => rows.find(r => r.code === code)!.id
      await db.insert(schema.drafts).values([
        { taskId: id('THE-SOC-050'), body: 'Post', byAgent: true, status: 'freigegeben', platforms: ['bluesky', 'x', 'instagram'] },
        { taskId: id('THE-CON-015'), body: 'Artikel', byAgent: true, kind: 'article' },
      ])
      await db.insert(schema.taskNotes).values([
        { taskId: id('THE-SOC-050'), byAgent: true, text: `${STALE_HINT} Kanal "Social Media" steht nicht mehr in der Strategie. Verwerfen?`, createdAt: new Date('2026-11-01T12:00:00Z') },
        { taskId: id('THE-CON-015'), byAgent: true, text: `${STALE_HINT} Kanal "Content & Blog" steht nicht mehr in der Strategie. Verwerfen?`, createdAt: new Date('2026-11-01T12:00:00Z') },
      ])

      process.env.MA_NOW = '2026-11-03T09:00:00+01:00'
      const v2 = await createStrategyVersion(db, project!, { channels: v8, summary: 'Neu geschnitten', status: 'vorschlag', kind: 'rethink', byAgent: true })
      await activateStrategy(db, project!, v2, '2026-11-03', { userId: u!.id })
      const tasks = Object.fromEntries((await db.select().from(schema.tasks).where(inArray(schema.tasks.id, rows.map(r => r.id)))).map(t => [t.code, t]))
      expect(tasks['THE-SOC-050']!.strategyChannel).toBe('nische')
      expect(tasks['THE-SOC-050']!.channel).toBe('X und Bluesky (Nische)')
      expect(tasks['THE-CON-015']!.strategyChannel).toBe('blog')
      expect(tasks['THE-SOC-060']!.strategyChannel).toBe('social-media')
      for (const code of ['THE-SOC-050', 'THE-CON-015']) {
        const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, id(code)))
        expect(openStaleHint(notes)).toBeNull()
      }

      const [moved] = await db.insert(schema.tasks).values({ ...base, code: 'THE-CON-916', title: 'Ratgeber: KI-Bands', category: 'content', channel: 'Blog und Ratgeber', draftKind: 'article', status: 'entwurf_fertig', strategyChannel: 'blog' }).returning()
      await db.insert(schema.taskNotes).values({ taskId: moved!.id, byAgent: true, text: `${STALE_HINT} Kanal "Content & Blog" steht nicht mehr in der Strategie. Verwerfen?`, createdAt: new Date('2026-11-02T12:00:00Z') })
      const r = await reconcileProject(db, ws!, project!, { llm: null })
      expect(openStaleHint(await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, moved!.id)))).toBeNull()
      expect(r.suggested).toEqual(['THE-SOC-060'])
      expect(r.dropped).toEqual([])
    }
    finally {
      delete process.env.MA_NOW
      await close()
    }
  })
})
