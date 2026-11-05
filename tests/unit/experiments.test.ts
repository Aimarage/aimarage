import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StrategyChannel } from '../../server/db/schema'
import { runStrategyReview } from '../../server/lib/agent'
import { experiments as experimentsService } from '../../server/lib/api/service'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { assignAllRunning, assignExperimentTasks, decideExperiment, evaluateArms, experimentStep, experimentsView, insightsDigest, proposeExperiment, recordWeek, smallExperiment, versionAt } from '../../server/lib/experiments'
import { isLimitError } from '../../server/lib/limits'
import { approveProposal, changeStrategy, createStrategyVersion, rejectProposal, strategyHistory } from '../../server/lib/strategy'

type Ws = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

let db: Db
let close: () => Promise<void>
let seq = 0

const CHANNEL: StrategyChannel = { key: 'posts', name: 'Release-Posts', category: 'social', why: 'w', goalIds: [], weight: 4, days: ['TU', 'TH'], time: '10:00', active: true, places: [], topics: [] }

beforeAll(async () => {
  process.env.MA_NOW = '2026-11-02T08:00:00+01:00'
  ;({ db, close } = await openTestDb())
})
afterAll(async () => {
  delete process.env.MA_NOW
  await close()
})

async function setup(tag: string, opts: { autonomy?: Record<string, string>, settings?: Record<string, unknown>, limits?: Record<string, unknown> } = {}): Promise<{ ws: Ws, p: Project, user: string, code: string }> {
  const [w] = await db.insert(schema.workspaces).values({ name: `WS ${tag}`, settings: { llm: { provider: 'ollama', model: 'mock' }, ...opts.settings } as never, limits: (opts.limits ?? null) as never }).returning()
  const [u] = await db.insert(schema.users).values({ email: `${tag}@test.local`, name: `User ${tag}`, calendarToken: `cal-${tag}-0123456789abcdefghij` }).returning()
  await db.insert(schema.memberships).values({ workspaceId: w!.id, userId: u!.id, role: 'owner' })
  const code = tag.toUpperCase().slice(0, 3).padEnd(3, 'X')
  const [p] = await db.insert(schema.projects).values({ workspaceId: w!.id, slug: tag, name: `Projekt ${tag}`, code, icon: 'X', autonomy: (opts.autonomy ?? {}) as never }).returning()
  const st = await createStrategyVersion(db, p!, { channels: [CHANNEL], status: 'aktiv', kind: 'initial', byAgent: false })
  await db.update(schema.strategies).set({ decidedAt: new Date('2026-09-01T08:00:00Z'), createdAt: new Date('2026-09-01T08:00:00Z') }).where(eq(schema.strategies.id, st.id))
  return { ws: w!, p: p!, user: u!.id, code }
}

async function task(e: { ws: Ws, p: Project, code: string }, date: string, opts: { time?: string, status?: 'erledigt' | 'geplant', likes?: number, reach?: number, arm?: 'A' | 'B', experimentId?: string, channel?: string } = {}) {
  const [t] = await db.insert(schema.tasks).values({
    workspaceId: e.ws.id,
    projectId: e.p.id,
    code: `${e.code}-SOC-${String(++seq).padStart(4, '0')}`,
    title: `Post ${seq}`,
    category: 'social',
    dueDate: date,
    dueTime: opts.time ?? '10:00',
    status: opts.status ?? 'erledigt',
    strategyChannel: opts.channel ?? 'posts',
    draftKind: 'post',
    experimentArm: opts.arm ?? null,
    experimentId: opts.experimentId ?? null,
  }).returning()
  if (opts.likes !== undefined) await db.insert(schema.results).values({ taskId: t!.id, metric: 'likes', value: opts.likes, source: 'social', measuredOn: date })
  if (opts.reach !== undefined) await db.insert(schema.results).values({ taskId: t!.id, metric: 'reach', value: opts.reach, source: 'social', measuredOn: date })
  return t!
}

async function experiment(e: { ws: Ws, p: Project }, values: Partial<typeof schema.experiments.$inferInsert> = {}) {
  const [x] = await db.insert(schema.experiments).values({ workspaceId: e.ws.id, projectId: e.p.id, status: 'laeuft', hypothesis: 'Posts um 18:00 bringen mehr', variable: 'uhrzeit', channelKey: 'posts', variantA: '10:00', variantB: '18:00', startDate: '2026-10-12', endDate: '2026-10-25', ...values }).returning()
  return x!
}

describe('Strategie-Verlauf', () => {
  it('Versionen bleiben erhalten, Wochen-Kennzahlen gehen an die jeweils aktive Version', async () => {
    const e = await setup('verlauf')
    const r = await changeStrategy(db, e.p, [{ channelKey: 'posts', name: 'Release-Posts', change: 'more', from: 4, to: 5, reason: 'wirkt' }], '2026-10-21', { kind: 'review', byAgent: true })
    await db.update(schema.strategies).set({ decidedAt: new Date('2026-10-21T06:00:00Z') }).where(eq(schema.strategies.id, r.strategy.id))
    const hist = await strategyHistory(db, e.p.id)
    expect(hist.map(h => [h.version, h.status])).toEqual([[2, 'aktiv'], [1, 'abgeloest']])
    expect(versionAt(hist, '2026-10-20')?.version).toBe(1)
    expect(versionAt(hist, '2026-10-22')?.version).toBe(2)

    const a = await task(e, '2026-10-20', { time: '09:00', likes: 4, reach: 100 })
    const b = await task(e, '2026-10-23', { time: '19:00', likes: 8, reach: 300 })
    await db.insert(schema.drafts).values({ taskId: a.id, body: 'x', kind: 'post', status: 'freigegeben', media: [{ id: 'm', name: 'a.png', mime: 'image/png', size: 1, file: 'f' }] })
    await db.insert(schema.drafts).values({ taskId: b.id, body: 'y', kind: 'post', status: 'freigegeben' })
    await db.insert(schema.taskLinks).values({ workspaceId: e.ws.id, projectId: e.p.id, taskId: a.id, platform: 'bluesky', url: 'https://bsky.app/a', postedAt: new Date('2026-10-20T07:00:00Z') })
    await db.insert(schema.utmStats).values({ projectId: e.p.id, day: '2026-10-24', source: 'bluesky', medium: 'social', campaign: b.code.toLowerCase(), visits: 12, signups: 2, purchases: 1 })
    await db.insert(schema.agentRuns).values({ workspaceId: e.ws.id, job: 'draft_task', projectId: e.p.id, status: 'ok', costEur: 0.25, startedAt: new Date('2026-10-22T10:00:00Z') })

    await recordWeek(db, e.ws, e.p, '2026-10-19')
    const rows = await db.select().from(schema.strategyWeeks).where(eq(schema.strategyWeeks.projectId, e.p.id))
    const get = (v: number, dim: string, key = '') => rows.find(x => x.version === v && x.dimension === dim && x.key === key)
    expect(get(1, 'gesamt')).toMatchObject({ posts: 1, measured: 1, reach: 100, interactions: 4 })
    expect(get(2, 'gesamt')).toMatchObject({ posts: 1, reach: 300, interactions: 8, visits: 12, signups: 2, purchases: 1, costEur: 0.25 })
    expect(get(1, 'plattform', 'bluesky')?.posts).toBe(1)
    expect(get(1, 'format', 'bild')?.posts).toBe(1)
    expect(get(2, 'format', 'text')?.posts).toBe(1)
    expect(get(1, 'uhrzeit', '09-12')?.posts).toBe(1)
    expect(get(2, 'uhrzeit', '18-21')?.posts).toBe(1)
    expect(get(2, 'kanal', 'posts')?.interactions).toBe(8)
    await recordWeek(db, e.ws, e.p, '2026-10-19')
    expect((await db.select().from(schema.strategyWeeks).where(eq(schema.strategyWeeks.projectId, e.p.id))).length).toBe(rows.length)
  })
})

describe('Bewertung', () => {
  it('besser, schlechter, kein Unterschied, zu wenig Daten', () => {
    expect(evaluateArms([10, 10, 10], [14, 14, 14]).verdict).toBe('besser')
    expect(evaluateArms([10, 10, 10], [14, 14, 14]).diff).toBe(0.4)
    expect(evaluateArms([10, 10, 10], [5, 5, 5]).verdict).toBe('schlechter')
    expect(evaluateArms([10, 10, 10], [11, 9, 11]).verdict).toBe('gleich')
    expect(evaluateArms([10, 10], [20, 20, 20]).verdict).toBe('zu_wenig')
    expect(evaluateArms([0, 0, 0], [0, 0, 0]).verdict).toBe('gleich')
    expect(evaluateArms([0, 0, 0], [1, 2, 1]).verdict).toBe('besser')
  })
})

describe('Experimente', () => {
  it('Planung: freie Aufgaben abwechselnd A und B, B mit eigener Uhrzeit, entworfene bleiben unverändert', async () => {
    const e = await setup('plan')
    const x = await experiment(e, { startDate: '2026-11-03', endDate: '2026-11-16' })
    const ts = [] as Awaited<ReturnType<typeof task>>[]
    for (const d of ['2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12']) ts.push(await task(e, d, { status: 'geplant' }))
    const drafted = await task(e, '2026-11-04', { status: 'geplant' })
    await db.insert(schema.drafts).values({ taskId: drafted.id, body: 'schon geschrieben', kind: 'post' })
    expect(await assignExperimentTasks(db, x, '2026-11-02')).toBe(4)
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, e.p.id))
    const by = (id: string) => rows.find(r => r.id === id)!
    expect(ts.map(t => by(t.id).experimentArm)).toEqual(['A', 'B', 'A', 'B'])
    expect(ts.map(t => by(t.id).dueTime)).toEqual(['10:00', '18:00', '10:00', '18:00'])
    expect(by(drafted.id).experimentId).toBeNull()
    expect(await assignExperimentTasks(db, x, '2026-11-02')).toBe(0)
  })

  it('B schlechter: zurück zu A, Erkenntnis gespeichert, danach nächste Variante als Vorschlag', async () => {
    const e = await setup('schlecht')
    const x = await experiment(e)
    for (const d of ['2026-10-13', '2026-10-15', '2026-10-20']) await task(e, d, { arm: 'A', experimentId: x.id, likes: 10 })
    for (const d of ['2026-10-14', '2026-10-16', '2026-10-22']) await task(e, d, { arm: 'B', experimentId: x.id, time: '18:00', likes: 5 })
    const later = await task(e, '2026-11-05', { status: 'geplant', arm: 'B', experimentId: x.id, time: '18:00' })
    const lines = await experimentStep(db, e.ws, e.p, '2026-11-02')
    const [done] = await db.select().from(schema.experiments).where(eq(schema.experiments.id, x.id))
    expect(done).toMatchObject({ status: 'ausgewertet', decision: 'verwerfen' })
    expect(done!.result).toMatchObject({ verdict: 'schlechter', diff: -0.5, a: { posts: 3 }, b: { posts: 3 } })
    const [back] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, later.id))
    expect(back).toMatchObject({ dueTime: '10:00', experimentId: null, experimentArm: null })
    const ins = await db.select().from(schema.insights).where(eq(schema.insights.projectId, e.p.id))
    expect(ins).toHaveLength(1)
    expect(ins[0]!.text).toContain('10:00 > 18:00')
    expect(ins[0]!.text).toContain('-50 %')
    expect(await insightsDigest(db, e.p.id)).toContain('10:00 > 18:00')
    const next = await db.select().from(schema.experiments).where(and(eq(schema.experiments.projectId, e.p.id), eq(schema.experiments.status, 'vorschlag')))
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ variable: 'uhrzeit', variantA: '10:00', variantB: '12:30' })
    expect(lines.join(' ')).toContain('Zurück zu A')
    const view = await experimentsView(db, e.p.id)
    expect(view.current?.status).toBe('vorschlag')
    expect(view.recent[0]?.result?.verdict).toBe('schlechter')
  })

  it('B besser: Uhrzeit wird in die Strategie übernommen, Bestzeit-Automatik lässt den Kanal in Ruhe', async () => {
    const e = await setup('besser')
    const x = await experiment(e)
    for (const d of ['2026-10-13', '2026-10-15', '2026-10-20']) await task(e, d, { arm: 'A', experimentId: x.id, likes: 10 })
    for (const d of ['2026-10-14', '2026-10-16', '2026-10-22']) await task(e, d, { arm: 'B', experimentId: x.id, time: '18:00', likes: 14 })
    const line = await decideExperiment(db, e.ws, e.p, x, '2026-11-02')
    expect(line).toContain('+40 %')
    const [st] = await db.select().from(schema.strategies).where(and(eq(schema.strategies.projectId, e.p.id), eq(schema.strategies.status, 'aktiv')))
    expect(st!.channels[0]!.time).toBe('18:00')
    const [done] = await db.select().from(schema.experiments).where(eq(schema.experiments.id, x.id))
    expect(done!.decision).toBe('behalten')
  })

  it('zu wenig Daten: verlängern, nach zwei Verlängerungen abbrechen und zurück zu A', async () => {
    const e = await setup('wenig')
    const x = await experiment(e)
    await task(e, '2026-10-13', { arm: 'A', experimentId: x.id, likes: 10 })
    await task(e, '2026-10-14', { arm: 'B', experimentId: x.id, likes: 30 })
    await decideExperiment(db, e.ws, e.p, x, '2026-11-02')
    const [ext] = await db.select().from(schema.experiments).where(eq(schema.experiments.id, x.id))
    expect(ext).toMatchObject({ status: 'laeuft', extensions: 1, endDate: '2026-11-01', decision: 'verlaengern' })
    expect(ext!.result?.verdict).toBe('zu_wenig')
    await db.update(schema.experiments).set({ extensions: 2 }).where(eq(schema.experiments.id, x.id))
    const [again] = await db.select().from(schema.experiments).where(eq(schema.experiments.id, x.id))
    await decideExperiment(db, e.ws, e.p, again!, '2026-11-09')
    const [end] = await db.select().from(schema.experiments).where(eq(schema.experiments.id, x.id))
    expect(end).toMatchObject({ status: 'abgebrochen', decision: 'verwerfen' })
    expect(await db.select().from(schema.insights).where(eq(schema.insights.projectId, e.p.id))).toHaveLength(0)
  })

  it('nur ein Experiment je Projekt gleichzeitig', async () => {
    const e = await setup('eins')
    for (const d of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) await task(e, d, { likes: 5 })
    await experiment(e, { status: 'vorschlag', startDate: null, endDate: null })
    expect(await proposeExperiment(db, e.ws, e.p, '2026-11-02')).toBeNull()
    await expect(experiment(e, { status: 'laeuft' })).rejects.toThrow()
    expect(await experiment(e, { status: 'ausgewertet' })).toBeTruthy()
  })

  it('Freigabe-Stufe und Hauptschalter: kleiner Test startet nur bei eigener Stufe selbst', async () => {
    const manual = await setup('manuell')
    const auto = await setup('auto', { autonomy: { social: 'auto' } })
    const off = await setup('aus', { autonomy: { social: 'auto' }, settings: { agentEnabled: false } })
    for (const e of [manual, auto, off]) for (const d of ['2026-10-20', '2026-10-21', '2026-10-22']) await task(e, d, { likes: 5 })
    expect((await proposeExperiment(db, manual.ws, manual.p, '2026-11-02'))?.experiment.status).toBe('vorschlag')
    const a = await proposeExperiment(db, auto.ws, auto.p, '2026-11-02')
    expect(a?.started).toBe(true)
    expect(a?.experiment).toMatchObject({ status: 'laeuft', startDate: '2026-11-03', endDate: '2026-11-16' })
    expect(await proposeExperiment(db, off.ws, off.p, '2026-11-02')).toBeNull()
    await experiment(off, { startDate: '2026-11-03', endDate: '2026-11-16' })
    await task(off, '2026-11-04', { status: 'geplant' })
    expect(await assignAllRunning(db, off.ws, '2026-11-02')).toBe(0)
  })

  it('Takt-Experiment läuft über die Strategie-Freigabe', async () => {
    expect(smallExperiment('takt')).toBe(false)
    const e = await setup('takt')
    const prop = await createStrategyVersion(db, e.p, { channels: [{ ...CHANNEL, weight: 5 }], changes: [{ channelKey: 'posts', name: 'Release-Posts', change: 'more', from: 4, to: 5, reason: 'Experiment' }], status: 'vorschlag', kind: 'review', byAgent: true })
    const x = await experiment(e, { status: 'vorschlag', variable: 'takt', variantA: '4', variantB: '5', strategyId: prop.id, startDate: null, endDate: null })
    await approveProposal(db, e.p, prop, '2026-11-02', e.user)
    const [run] = await db.select().from(schema.experiments).where(eq(schema.experiments.id, x.id))
    expect(run).toMatchObject({ status: 'laeuft', startDate: '2026-11-02', endDate: '2026-11-15' })

    const e2 = await setup('taktnein')
    const prop2 = await createStrategyVersion(db, e2.p, { channels: [{ ...CHANNEL, weight: 5 }], status: 'vorschlag', kind: 'review', byAgent: true })
    const x2 = await experiment(e2, { status: 'vorschlag', variable: 'takt', variantA: '4', variantB: '5', strategyId: prop2.id, startDate: null, endDate: null })
    await rejectProposal(db, e2.p, prop2, e2.user)
    const [rej] = await db.select().from(schema.experiments).where(eq(schema.experiments.id, x2.id))
    expect(rej!.status).toBe('verworfen')
  })
})

describe('Tenancy und KI-Budget', () => {
  it('fremde Experimente bleiben unsichtbar und unberührt', async () => {
    const a = await setup('mandanta')
    const b = await setup('mandantb')
    const xb = await experiment(b, { hypothesis: 'Geheim ZZB' })
    expect(JSON.stringify(await experimentsView(db, a.p.id))).not.toContain('ZZB')
    const actor = { workspace: a.ws, userId: a.user, userName: 'A', role: 'owner' as const, access: { all: true, ids: [] } }
    await expect(experimentsService(db, actor, b.p.slug)).rejects.toThrow()
    await experimentStep(db, a.ws, a.p, '2026-11-02')
    await assignAllRunning(db, a.ws, '2026-11-02')
    const [still] = await db.select().from(schema.experiments).where(eq(schema.experiments.id, xb.id))
    expect(still).toEqual(xb)
  })

  it('aufgebrauchtes KI-Budget: keine KI-Aufrufe, Experiment wird trotzdem ausgewertet', async () => {
    const e = await setup('budget', { limits: { llmEurMonth: 0 } })
    const x = await experiment(e)
    for (const d of ['2026-10-13', '2026-10-15', '2026-10-20']) await task(e, d, { arm: 'A', experimentId: x.id, likes: 10 })
    for (const d of ['2026-10-14', '2026-10-16', '2026-10-22']) await task(e, d, { arm: 'B', experimentId: x.id, likes: 20 })
    await task(e, '2026-10-27', { likes: 3 })
    let calls = 0
    const fetchMock = (async () => {
      calls++
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch
    const err = await runStrategyReview(db, e.ws, fetchMock).catch(x => x)
    expect(isLimitError(err)).toBe(true)
    expect(calls).toBe(0)
    const [done] = await db.select().from(schema.experiments).where(eq(schema.experiments.id, x.id))
    expect(done!.decision).toBe('behalten')
    expect((await db.select().from(schema.strategyWeeks).where(eq(schema.strategyWeeks.projectId, e.p.id))).length).toBeGreaterThan(0)
  })
})

describe('Maßnahmen vorher/nachher', () => {
  it('erledigter Ratgeber-Artikel: Search-Console-Klicks der Seite vor und nach der Umsetzung als Erkenntnis', async () => {
    const e = await setup('seo')
    await db.update(schema.projects).set({ url: 'https://seo.example' }).where(eq(schema.projects.id, e.p.id))
    const p = { ...e.p, url: 'https://seo.example' }
    const [t] = await db.insert(schema.tasks).values({ workspaceId: e.ws.id, projectId: e.p.id, code: 'SEO-CON-0001', title: 'Titel Ratgeber X verbessert', category: 'content', status: 'erledigt', dueDate: '2026-09-15', doneAt: new Date('2026-09-15T10:00:00Z'), postedUrl: 'https://seo.example/ratgeber-x' }).returning()
    const rows = []
    for (let i = 1; i <= 28; i++) {
      const before = new Date(Date.UTC(2026, 8, 15 - i)).toISOString().slice(0, 10)
      const after = new Date(Date.UTC(2026, 8, 16 + i)).toISOString().slice(0, 10)
      rows.push({ projectId: e.p.id, day: before, query: '', page: 'https://seo.example/ratgeber-x/', clicks: i % 2 === 0 ? 1 : 0, impressions: 10, position: 12 })
      rows.push({ projectId: e.p.id, day: after, query: '', page: 'https://seo.example/ratgeber-x', clicks: 1, impressions: 20, position: 8 })
    }
    await db.insert(schema.searchStats).values(rows)
    const { measureActions } = await import('../../server/lib/experiments')
    const lines = await measureActions(db, e.ws, p, '2026-11-02')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('+100 % Google-Klicks')
    const [ins] = await db.select().from(schema.insights).where(eq(schema.insights.channelKey, `task:${t!.id}`))
    expect(ins!.variable).toBe('massnahme')
    expect(await measureActions(db, e.ws, p, '2026-11-02')).toHaveLength(0)
  })
})
