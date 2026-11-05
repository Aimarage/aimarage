import { and, eq, like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runSweep, sweepThread } from '../../server/lib/community-sweep'
import { sealAppSecret, updateSettings } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { resetBraveState } from '../../server/lib/platforms/brave'
import { resetSecretCache } from '../../server/lib/secret'
import { ownerOf } from '../../server/lib/tasks'
import { isCommunitySweep, parseAccountAnswer, SWEEP_ASK, SWEEP_ORIGIN, sweepServices } from '../../shared/utils/community-sweep'
import { needsThread, platformOf, taskType } from '../../shared/utils/drafting'
import { taskView } from '../../shared/utils/task-state'
import { todoOf } from '../../shared/utils/todo'
import { taskWhere } from '../../shared/utils/where'

const F04 = { title: 'Reddit-, Hacker-News-, Indie-Hackers-, Product-Hunt-Konto (Karma aufbauen ab sofort)', category: 'community', status: 'geplant', agentStep: 'Liste passender Threads', humanStep: 'Kommentieren', targetUrl: null, origin: null, draftKind: null, assigneeUserId: 'u1' } as const

describe('Allgemeine Community-Aufgaben sucht der Agent selbst', () => {
  it('erkennt F-04 und ähnliche Sammelaufgaben, aber keine konkreten Antworten', () => {
    expect(isCommunitySweep(F04)).toBe(true)
    expect(isCommunitySweep({ title: 'In r/selfhosted mitreden', category: 'community' })).toBe(true)
    expect(isCommunitySweep({ title: 'Reddit-Präsenz', category: 'community', agentStep: 'Passende Threads suchen', humanStep: 'Antworten' })).toBe(true)
    expect(isCommunitySweep({ title: 'Antwort: FLAC vs streaming', category: 'community', agentStep: 'Liste passender Threads' })).toBe(false)
    expect(isCommunitySweep({ ...F04, origin: `${SWEEP_ORIGIN}x` })).toBe(false)
    expect(isCommunitySweep({ ...F04, targetUrl: 'https://www.reddit.com/r/selfhosted/comments/abc/x/' })).toBe(false)
    expect(isCommunitySweep({ ...F04, category: 'social' })).toBe(false)
    expect(isCommunitySweep({ title: 'Show HN: Linkbox', category: 'community', agentStep: 'Beitrag entwerfen', humanStep: 'Posten' })).toBe(false)
    expect(sweepServices(F04).map(s => s.name)).toEqual(['Reddit', 'Hacker News', 'Indie Hackers', 'Product Hunt'])
  })

  it('gehört dem Agenten: nicht unter "Du bist dran", kein "Ziel fehlt", kein "Such passende Threads"', () => {
    expect(ownerOf(F04, true)).toBe('agent')
    expect(ownerOf(F04, false)).toBe('human')
    const v = taskView({ status: 'geplant', dueDate: '2026-10-14', dueTime: null, category: 'community', owner: 'agent', route: 'self', goesOut: false, estimateMin: 15, sweep: true }, { today: '2026-10-14', time: '09:00' })
    expect(v.who).toBe('ai')
    expect(v.bucket).toBe('ai')
    expect(v.now).toBe(false)
    expect(v.plannedMin).toBe(0)
    const w = taskWhere(F04, { reddit: true })
    expect(w.missing).toBe(false)
    expect(w.by).toBe('agent')
    const todo = todoOf({ status: 'geplant', category: 'community', out: 'self', owner: 'agent', sweep: true, humanStep: 'Kommentieren' })
    expect(todo.key).toBe('nothing.sweep')
    expect(todo.min).toBe(0)
    expect(todoOf({ status: 'entwurf_fertig', category: 'community', out: 'self', owner: 'agent', sweep: true, draft: 'open', info: true }).key).toBe('do.answer')
  })

  it('liest die Konto-Antwort ohne KI', () => {
    const names = ['Hacker News', 'Indie Hackers', 'Product Hunt']
    expect(parseAccountAnswer('HN ja, Indie Hackers nein, Product Hunt hab ich', names)).toEqual({ 'Hacker News': 'yes', 'Indie Hackers': 'no', 'Product Hunt': 'yes' })
    expect(parseAccountAnswer('Nein, nirgends', names)).toEqual({ 'Hacker News': 'no', 'Indie Hackers': 'no', 'Product Hunt': 'no' })
    expect(parseAccountAnswer('Ja, alle', names)).toEqual({ 'Hacker News': 'yes', 'Indie Hackers': 'yes', 'Product Hunt': 'yes' })
    expect(parseAccountAnswer('Nur bei Hacker News', names)).toEqual({ 'Hacker News': 'yes', 'Indie Hackers': null, 'Product Hunt': null })
    expect(parseAccountAnswer('Bei Product Hunt nicht', names)['Product Hunt']).toBe('no')
  })
})

describe('runSweep', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  let bmx: typeof schema.projects.$inferSelect
  let peter: string

  const TODAY = new Date().toISOString().slice(0, 10)
  const FIXED_NOW = `${TODAY}T08:15:00+02:00`
  const hit = (url: string, title: string) => ({ url, title, description: `About ${title}`, age: '2 days ago', page_age: new Date(Date.parse(FIXED_NOW) - 2 * 86_400_000).toISOString().slice(0, 19) })
  const web = (async (url: string) => {
    const q = new URL(url).searchParams.get('q') ?? ''
    const results = q.includes('selfhosted')
      ? [hit('https://www.reddit.com/r/selfhosted/comments/aaa111/best_bookmark_manager/', 'Best self-hosted bookmark manager? : r/selfhosted'), hit('https://www.reddit.com/r/selfhosted/comments/bbb222/linkding_vs/', 'Linkding vs alternatives')]
      : []
    return new Response(JSON.stringify({ web: { results } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const deps = (log: string[] = []) => ({ query: async () => ['bookmark', 'manager'], pick: async (_t: unknown, _p: unknown, list: { url: string }[]) => ({ ...list[0], problem: 'Sucht einen selbst gehosteten Bookmark-Manager mit Import aus dem Browser' }) as never, taken: async () => new Set<string>(), webFetch: web, log })

  beforeAll(async () => {
    process.env.MA_NOW = FIXED_NOW
    process.env.APP_SECRET = 'test-secret'
    resetSecretCache()
    resetBraveState()
    ;({ db, close } = await openTestDb())
    const [w] = await db.insert(schema.workspaces).values({ name: 'Test', timezone: 'Europe/Vienna', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning()
    peter = (await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning())[0]!.id
    await db.insert(schema.memberships).values({ workspaceId: w!.id, userId: peter, role: 'owner' })
    bmx = (await db.insert(schema.projects).values({ workspaceId: w!.id, slug: 'linkbox', name: 'Linkbox', code: 'BMX', icon: 'B', description: 'Self-hosted bookmark manager', setup: { analysis: { communities: ['r/selfhosted', 'r/BookmarkManagers'] } } as never }).returning())[0]!
    await db.insert(schema.projectMemory).values({ projectId: bmx.id, kind: 'fakt', text: 'Peter postet für Linkbox auf Reddit mit seinem Konto' })
    await updateSettings(db, w!.id, s => ({ ...s, apps: { brave: { clientId: '', secret: sealAppSecret(w!.id, 'brave', 'brave-key-123') } } }))
    ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, w!.id)))[0]!
  })
  afterAll(async () => {
    delete process.env.MA_NOW
    delete process.env.APP_SECRET
    resetSecretCache()
    await close()
  })

  it('F-04: legt Antwort-Aufgaben zu echten Threads an und fragt einmal nach den übrigen Konten', async () => {
    const [f04] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: null, code: 'F-04', ...F04, assigneeUserId: peter, dueDate: TODAY }).returning()
    const r = await runSweep(db, ws, f04!, deps())
    expect(r.status).toBe('ok')
    expect(r.created.length).toBeGreaterThanOrEqual(1)
    const kids = await db.select().from(schema.tasks).where(like(schema.tasks.origin, `${SWEEP_ORIGIN}${f04!.id}%`))
    expect(kids.length).toBe(r.created.length)
    const kid = kids[0]!
    expect(kid.targetUrl).toMatch(/reddit\.com\/r\/selfhosted\/comments\//)
    expect(kid.title.startsWith('Antwort: ')).toBe(true)
    expect(kid.humanStep).toBe('Fertige Antwort kopieren und im Thread posten')
    expect(taskType(kid)).toBe('reply')
    expect(platformOf(kid)).toBe('reddit')
    expect(needsThread(kid)).toBe(true)
    expect(ownerOf(kid, true)).toBe('agent')
    expect(sweepThread(kid)?.url).toBe(kid.targetUrl)
    expect(sweepThread(kid)?.text).toContain('About')
    expect(sweepThread(kid)?.problem).toBe('Sucht einen selbst gehosteten Bookmark-Manager mit Import aus dem Browser')
    const [ask] = await db.select().from(schema.drafts).where(and(eq(schema.drafts.taskId, f04!.id), eq(schema.drafts.status, 'offen')))
    expect(ask!.body.startsWith(SWEEP_ASK)).toBe(true)
    expect(ask!.body).toContain('Hacker News')
    expect(ask!.body).not.toContain('Reddit')
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, f04!.id))
    expect(notes.some(n => n.text.startsWith('Info nötig:'))).toBe(true)

    const again = await runSweep(db, ws, (await db.select().from(schema.tasks).where(eq(schema.tasks.id, f04!.id)))[0]!, deps())
    const kids2 = await db.select().from(schema.tasks).where(like(schema.tasks.origin, `${SWEEP_ORIGIN}${f04!.id}%`))
    expect(new Set(kids2.map(k => k.targetUrl)).size).toBe(kids2.length)
    expect(kids2.length).toBeLessThanOrEqual(3)
    expect(again.created.every(c => !r.created.includes(c))).toBe(true)

    await db.insert(schema.taskNotes).values({ taskId: f04!.id, userId: peter, text: 'Zum Entwurf: HN nein, Indie Hackers nein, Product Hunt nein', createdAt: new Date(Date.now() + 5000) })
    await db.update(schema.tasks).set({ status: 'verworfen' }).where(like(schema.tasks.origin, `${SWEEP_ORIGIN}${f04!.id}%`))
    await runSweep(db, ws, (await db.select().from(schema.tasks).where(eq(schema.tasks.id, f04!.id)))[0]!, deps())
    const open = await db.select().from(schema.drafts).where(and(eq(schema.drafts.taskId, f04!.id), eq(schema.drafts.status, 'offen')))
    expect(open.length).toBe(0)
    const mem = (await db.select().from(schema.projectMemory).where(eq(schema.projectMemory.projectId, bmx.id))).map(m => m.text)
    expect(mem.some(m => m.startsWith('Kein Konto bei Hacker News'))).toBe(true)
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, f04!.id)))[0]!.status).toBe('geplant')
  }, 30_000)

  it('ohne passenden Thread: keine Aufgabe für den Menschen, nur eine Notiz', async () => {
    const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: bmx.id, code: 'BMX-COM-090', title: 'In r/BookmarkManagers mitreden', category: 'community', status: 'geplant', assigneeUserId: peter, dueDate: TODAY, channel: 'Reddit' }).returning()
    const empty = { ...deps(), pick: async () => null }
    const r = await runSweep(db, ws, t!, empty)
    expect(r.created).toEqual([])
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, t!.id))
    expect(notes.some(n => n.text.startsWith('Heute kein passender Thread:'))).toBe(true)
    expect(ownerOf(t!, true)).toBe('agent')
  }, 30_000)
})
