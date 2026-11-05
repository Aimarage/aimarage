import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runDraftTask } from '../../server/lib/agent'
import { releaseByReviewer, reviewerFrom, reviewerPrompt } from '../../server/lib/ai-reviewer'
import { stopRelease } from '../../server/lib/mcp-approve'
import { reviewerReleases } from '../../server/lib/ai-reviewer'
import { digestText, morningDigests } from '../../server/lib/morning-digest'
import { dashboardView } from '../../server/services/views'
import { appCtx } from '../../server/lib/app/core'
import { appApprovals } from '../../server/lib/app/views'
import { appStop } from '../../server/lib/app/actions'
import { listConnections, upsertConnection } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { applyLlmUpdate, llmConfig, type LlmConfig } from '../../server/lib/llm'
import { resetSecretCache } from '../../server/lib/secret'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let seq = 0

type Verdict = Record<string, unknown>

const SONGS = ['Nachtzug', 'Morgenrot', 'Kometen', 'Flussabwärts', 'Glasdach', 'Sommerfrost', 'Leuchtturm', 'Wanderdüne', 'Tiefschnee', 'Funkstille', 'Regenbogen', 'Stadtrand']
let songs = 0

function anthropicMock(verdict: Verdict, draftBody = `Der Song "${SONGS[songs++ % SONGS.length]}" ist ab heute überall zu hören.`) {
  const models: string[] = []
  const prompts: string[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string, messages: { content: string | { text: string }[] }[] }
    models.push(body.model)
    const last = body.messages.at(-1)!.content
    prompts.push(typeof last === 'string' ? last : last.map(c => c.text).join('\n'))
    const text = body.model === 'claude-sonnet-5-5' ? JSON.stringify(verdict) : JSON.stringify({ kind: 'post', body: draftBody })
    return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 3000, output_tokens: 300 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fn: fn as unknown as typeof fetch, models, prompts }
}

const web = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch

async function reloadWs() {
  ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
}

async function makeTask(opts: { category?: 'social' | 'community' | 'content', draftKind?: 'post' | 'mail' | 'article' | 'text', title?: string, origin?: string, projectId?: string, dueDate?: string, dueTime?: string } = {}) {
  seq++
  const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: opts.projectId ?? project.id, code: `R-${seq}`, title: opts.title ?? `Post zum neuen Song ${seq}`, category: opts.category ?? 'social', status: 'geplant', draftKind: opts.draftKind ?? 'post', dueDate: opts.dueDate ?? '2026-10-15', dueTime: opts.dueTime ?? '11:00', agentStep: 'Beitrag entwerfen', origin: opts.origin ?? null }).returning()
  return task!
}

async function latestDraft(taskId: string) {
  const rows = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, taskId))
  return rows.sort((a, b) => b.version - a.version)[0]!
}

async function taskOf(id: string) {
  return (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!
}

async function notesOf(id: string) {
  return (await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, id))).map(n => n.text)
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  const [w] = await db.insert(schema.workspaces).values({ name: 'Test' }).returning()
  ws = w!
  const [p] = await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'tonebase', name: 'tonebase', code: 'BIT', icon: 'music', rules: 'Keine Tourdaten nennen.' }).returning()
  project = p!
})

afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  await close()
})

beforeEach(async () => {
  await db.update(schema.workspaces).set({ settings: { llm: applyLlmUpdate(undefined, { provider: 'anthropic', apiKey: 'sk-ant-test-0123456789abcdef' }, ws.id) } }).where(eq(schema.workspaces.id, ws.id))
  await db.delete(schema.activity).where(eq(schema.activity.workspaceId, ws.id))
  await reloadWs()
})

describe('Prüfer-Modell', () => {
  const env = { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-env-0123456789abcdef', model: 'claude-haiku-5-5', modelFast: 'claude-haiku-5-5', timeoutMs: 5000 }

  it('gehostet Anthropic: Sonnet mit Haiku als Ausweich', () => {
    const rv = reviewerFrom(llmConfig(undefined, env, 'ws'))!
    expect(rv.strong).toBe(true)
    expect(rv.cfg.model).toBe('claude-sonnet-5-5')
    expect(rv.cfg.fallback?.model).toBe('claude-haiku-5-5')
    expect(rv.cfg.priceInEur).toBeCloseTo(2 * 0.88, 6)
  })

  it('ohne starkes Modell oder ohne Schlüssel kein Prüfer', () => {
    expect(reviewerFrom(llmConfig({ provider: 'ollama', model: 'mock' }, env, 'ws'))).toBeNull()
    expect(reviewerFrom(llmConfig({ provider: 'anthropic' }, { ...env, apiKey: '' }, 'ws'))).toBeNull()
  })

  it('eigener Schlüssel: großes Modell, sonst keiner (dann einfache Nachprüfung)', () => {
    const own = { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'x', keySource: 'workspace', model: 'claude-sonnet-5-5', modelFast: 'claude-haiku-5-5', reasoning: false, timeoutMs: 1000, priceInEur: 0, priceOutEur: 0, needsKey: true, own: true } as LlmConfig
    expect(reviewerFrom(own)!.cfg.model).toBe('claude-sonnet-5-5')
    expect(reviewerFrom({ ...own, model: 'qwen', modelFast: 'qwen' })).toBeNull()
    expect(reviewerFrom({ ...own, blocked: 'kaputt' })).toBeNull()
  })

  it('Tarif ohne starkes Modell: kein Prüfer', () => {
    expect(reviewerFrom(llmConfig(undefined, env, 'ws'), false)).toBeNull()
  })

  it('Prompt enthält Regeln, Fakten, Subreddit-Regeln und Entwurf', () => {
    const p = reviewerPrompt({ task: { title: 'T', description: null, category: 'community', channel: 'r/indie', language: 'de' }, type: 'reply', platform: 'reddit', kind: 'text', draft: { subject: null, body: 'Hallo', variants: {}, recipient: null }, platforms: [], rules: 'Nie duzen', facts: { known: [], avoid: ['Preis'] }, projectData: '- Release am 20.10.', release: null, subreddit: 'Regeln von r/indie: keine Links', recent: [], lessons: ['Keine Tourdaten'] })
    for (const s of ['Nie duzen', 'Preis', 'keine Links', 'Release am 20.10.', 'Keine Tourdaten', 'Hallo']) expect(p).toContain(s)
  })

  it('Korrekturen widersprechen den Projekt-Regeln nie, "Link in bio" nur mit belegtem Bio-Link', () => {
    const p = reviewerPrompt({ task: { title: 'T', description: null, category: 'social', channel: 'Instagram', language: 'en' }, type: 'post', platform: 'instagram', kind: 'post', draft: { subject: null, body: 'Hallo', variants: {}, recipient: null }, platforms: ['instagram'], rules: 'Music links go to tonebase.com', facts: { known: [], avoid: [] }, projectData: '-', release: null, subreddit: null, recent: [], lessons: [] })
    expect(p).toMatch(/Korrekturen widersprechen den Projekt-Regeln nie/)
    expect(p).toMatch(/"Link in bio" bzw. "Link im Profil" nur einsetzen, wenn Regeln oder Projektdaten belegen/)
  })
})

describe('KI-Prüfer nach dem Entwurf', () => {
  it('Blog-Artikel schreibt Opus, Prüfer bleibt Sonnet', async () => {
    const task = await makeTask({ category: 'content', draftKind: 'article', title: 'Blogartikel zum neuen Album' })
    const llm = anthropicMock({ verdict: 'ok', reason: 'passt' }, 'Das Album erzählt in zehn Stücken von einer langen Nacht.')
    await runDraftTask(db, ws, task.id, llm.fn, { webFetch: web })
    expect(llm.models[0]).toBe('claude-opus-5-5')
    expect(llm.models).toContain('claude-sonnet-5-5')
    expect(llm.models).not.toContain('claude-haiku-5-5')
  })

  it('ok: Opus schreibt, Prüfer gibt frei statt Haiku-Nachprüfung, Kosten im Lauf', async () => {
    const task = await makeTask()
    const llm = anthropicMock({ verdict: 'ok', reason: 'Regeln eingehalten, keine erfundenen Fakten.' })
    const out = await runDraftTask(db, ws, task.id, llm.fn, { webFetch: web })
    expect(out.summary).toContain('vom KI-Prüfer freigegeben')
    expect(llm.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(llm.prompts[1]).toContain('Keine Tourdaten nennen.')
    const d = await latestDraft(task.id)
    expect(d.status).toBe('freigegeben')
    expect(d.approvedVia).toBe('reviewer')
    expect(d.releaseAt).not.toBeNull()
    expect((await taskOf(task.id)).status).toBe('freigegeben')
    expect((await notesOf(task.id)).some(n => n.startsWith('Vom KI-Prüfer freigegeben (v1, claude-sonnet-5-5), bitte selbst posten'))).toBe(true)
    const [run] = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.taskId, task.id), eq(schema.agentRuns.job, 'draft_task')))
    expect(run!.model).toContain('claude-sonnet-5-5')
    expect(Number(run!.costEur)).toBeGreaterThan(0.005)
    const acts = await db.select().from(schema.activity).where(and(eq(schema.activity.taskId, task.id), eq(schema.activity.action, 'reviewer_approved')))
    expect(acts).toHaveLength(1)
  })

  it('korrigiert: übernimmt den Text, merkt eine Lehre, keine zweite Prüfrunde', async () => {
    const task = await makeTask()
    const llm = anthropicMock({ verdict: 'korrigiert', reason: 'Tourdatum gestrichen.', body: 'Endlich draußen: "Nachtzug" läuft jetzt.', lesson: 'Keine Tourdaten nennen, die nicht im Gedächtnis stehen.' }, 'Endlich draußen: "Nachtzug" läuft jetzt. Tour am 3.11. in Wien!')
    await runDraftTask(db, ws, task.id, llm.fn, { webFetch: web })
    expect(llm.models.filter(m => m === 'claude-sonnet-5-5')).toHaveLength(1)
    const d = await latestDraft(task.id)
    expect(d.body).toBe('Endlich draußen: "Nachtzug" läuft jetzt.')
    expect(d.version).toBe(1)
    expect(d.approvedVia).toBe('reviewer')
    const mem = await db.select().from(schema.projectMemory).where(and(eq(schema.projectMemory.projectId, project.id), eq(schema.projectMemory.kind, 'lehre')))
    expect(mem.map(m => m.text)).toEqual(['Keine Tourdaten nennen, die nicht im Gedächtnis stehen.'])

    const next = await makeTask()
    const again = anthropicMock({ verdict: 'korrigiert', reason: 'x', body: 'Ganz neu: "Morgenrot".', lesson: 'keine tourdaten nennen, die nicht im gedächtnis stehen' })
    await runDraftTask(db, ws, next.id, again.fn, { webFetch: web })
    expect(again.prompts[0]).toContain('Lehren aus früheren Prüfungen')
    expect(again.prompts[1]).toContain('Keine Tourdaten nennen, die nicht im Gedächtnis stehen.')
    expect(await db.select().from(schema.projectMemory).where(eq(schema.projectMemory.kind, 'lehre'))).toHaveLength(1)
  })

  it('Frage an den Menschen: Info nötig, keine Freigabe', async () => {
    const task = await makeTask()
    await runDraftTask(db, ws, task.id, anthropicMock({ verdict: 'frage', reason: 'Datum fehlt', question: 'Wann erscheint der Song?' }).fn, { webFetch: web })
    expect((await latestDraft(task.id)).status).toBe('offen')
    expect(await notesOf(task.id)).toContain('Info nötig: Wann erscheint der Song?')
  })

  it('verwerfen ohne entfallen: bleibt beim Menschen mit Begründung', async () => {
    const task = await makeTask()
    await runDraftTask(db, ws, task.id, anthropicMock({ verdict: 'verwerfen', reason: 'Falsches Thema.' }).fn, { webFetch: web })
    expect((await latestDraft(task.id)).status).toBe('offen')
    expect((await notesOf(task.id)).some(n => n.startsWith('Nachprüfung:') && n.includes('KI-Prüfer rät zu verwerfen: Falsches Thema.'))).toBe(true)
  })

  it('verwerfen, Aufgabe entfällt', async () => {
    const task = await makeTask()
    await runDraftTask(db, ws, task.id, anthropicMock({ verdict: 'verwerfen', reason: 'Doppelt zu R-1.', taskObsolete: true }).fn, { webFetch: web })
    expect((await latestDraft(task.id)).status).toBe('verworfen')
    expect((await taskOf(task.id)).status).toBe('verworfen')
  })

  it('Einstellung aus: geprüft, aber keine Freigabe', async () => {
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, aiReviewer: { enabled: false } } }).where(eq(schema.workspaces.id, ws.id))
    await reloadWs()
    const task = await makeTask()
    await runDraftTask(db, ws, task.id, anthropicMock({ verdict: 'ok', reason: 'passt' }).fn, { webFetch: web })
    expect((await latestDraft(task.id)).status).toBe('offen')
    expect(await notesOf(task.id)).toContain('KI-Prüfer (ok): passt')
  })

  it('Tarif ohne starkes Modell: nur einfache Nachprüfung, keine Freigabe', async () => {
    await db.update(schema.workspaces).set({ limits: { strongModel: false } }).where(eq(schema.workspaces.id, ws.id))
    await reloadWs()
    const task = await makeTask()
    const llm = anthropicMock({ verdict: 'ok', reason: 'passt' })
    await runDraftTask(db, ws, task.id, llm.fn, { webFetch: web })
    expect(llm.models).not.toContain('claude-sonnet-5-5')
    expect((await latestDraft(task.id)).status).toBe('offen')
    await db.update(schema.workspaces).set({ limits: {} }).where(eq(schema.workspaces.id, ws.id))
  })

  it('Stoppen macht die Freigabe des Prüfers rückgängig', async () => {
    const task = await makeTask()
    await runDraftTask(db, ws, task.id, anthropicMock({ verdict: 'ok', reason: 'passt' }).fn, { webFetch: web })
    const d = await latestDraft(task.id)
    expect(d.status).toBe('freigegeben')
    const [user] = await db.insert(schema.users).values({ email: `stop${seq}@test.at`, name: 'Stop' }).returning()
    await stopRelease(db, ws, user!.id, d.id)
    expect((await latestDraft(task.id)).status).toBe('offen')
    expect((await taskOf(task.id)).status).toBe('entwurf_fertig')
    expect(await notesOf(task.id)).toContain('Freigabe vom KI-Prüfer gestoppt, Entwurf wieder offen.')
  })

  it('Info gesammelt: Tagesmail mit Stopp-Link, Dashboard und App "Geht raus", keine Einzelmeldung', async () => {
    const [owner] = await db.insert(schema.users).values({ email: `inhaber${seq}@test.at`, name: 'Inhaber' }).returning()
    await db.insert(schema.memberships).values({ workspaceId: ws.id, userId: owner!.id, role: 'owner' })
    const task = await makeTask({ title: 'Post zum Release auf X' })
    await runDraftTask(db, ws, task.id, anthropicMock({ verdict: 'ok', reason: 'passt' }).fn, { webFetch: web })
    const d = await latestDraft(task.id)
    expect(d.approvedVia).toBe('reviewer')
    const notifies = await db.select().from(schema.jobs).where(and(eq(schema.jobs.workspaceId, ws.id), eq(schema.jobs.type, 'notify' as never)))
    expect(notifies).toHaveLength(0)

    const list = await reviewerReleases(db, ws.id, { onlyStoppable: true })
    expect(list.map(r => r.draftId)).toContain(d.id)
    const g = (await morningDigests(db, ws)).find(x => x.userId === owner!.id)!
    const item = g.reviewer!.find(r => r.url.includes(d.id))!
    expect(item).toMatchObject({ title: 'Post zum Release auf X', stoppable: true })
    expect(item.url).toMatch(new RegExp(`/p/tonebase/freigaben/${d.id}\\?stoppen=1$`))
    const de = digestText(g, 'de')
    expect(de.body).toContain('Vom KI-Prüfer freigegeben:')
    expect(de.body).toContain(`Stoppen: ${item.url}`)
    expect(digestText({ userId: 'x', minutes: 0, items: [], reviewer: [item] }, 'en')).toMatchObject({ subject: 'AI reviewer approved 1 post' })
    expect(digestText({ userId: 'x', minutes: 0, items: [], reviewer: [item] }, 'de').subject).toBe('KI-Prüfer hat 1 Beitrag freigegeben')

    const dash = await dashboardView(db, ws, null, owner!.id)
    expect(dash.reviewer.map(r => r.draftId)).toContain(d.id)
    const c = await appCtx(db, { user: owner!, workspace: ws, role: 'owner' })
    const app = await appApprovals(c, null)
    const out = app.find(a => a.id === d.id)!
    expect(out).toMatchObject({ state: 'approved', byReviewer: true, canApprove: false })
    const stopped = await appStop(c, d.id)
    expect(stopped.approval.state).toBe('pending')
    expect(await reviewerReleases(db, ws.id)).not.toContainEqual(expect.objectContaining({ draftId: d.id }))
    expect((await appApprovals(c, null)).find(a => a.id === d.id)?.byReviewer).toBeUndefined()
  })

  it('Tageslimit wie bei Claude darf freigeben', async () => {
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, mcpApprove: { perDay: 1 } } }).where(eq(schema.workspaces.id, ws.id))
    await reloadWs()
    const a = await makeTask()
    const b = await makeTask()
    await runDraftTask(db, ws, a.id, anthropicMock({ verdict: 'ok', reason: 'passt' }).fn, { webFetch: web })
    await runDraftTask(db, ws, b.id, anthropicMock({ verdict: 'ok', reason: 'passt' }).fn, { webFetch: web })
    expect((await latestDraft(a.id)).status).toBe('freigegeben')
    expect((await latestDraft(b.id)).status).toBe('offen')
  })

  it('nie für Artikel oder Mails', async () => {
    const task = await makeTask({ category: 'content', draftKind: 'post' })
    await db.insert(schema.drafts).values({ taskId: task.id, version: 1, kind: 'post', body: 'Text', status: 'offen' })
    await db.update(schema.tasks).set({ status: 'entwurf_fertig' }).where(eq(schema.tasks.id, task.id))
    const d = await latestDraft(task.id)
    const r = await releaseByReviewer(db, ws, { draftId: d.id, reason: 'passt', model: 'm' }, web)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('nicht erlaubt')
    const mail = await makeTask({ category: 'social', draftKind: 'mail' })
    await db.insert(schema.drafts).values({ taskId: mail.id, version: 1, kind: 'mail', body: 'Hallo', recipient: 'a@b.at', status: 'offen' })
    await db.update(schema.tasks).set({ status: 'entwurf_fertig' }).where(eq(schema.tasks.id, mail.id))
    const r2 = await releaseByReviewer(db, ws, { draftId: (await latestDraft(mail.id)).id, reason: 'passt', model: 'm' }, web)
    expect(r2.ok).toBe(false)
  })
})

describe('Über API/MCP angelegt', () => {
  it('ohne Beanstandung gibt der KI-Prüfer frei wie bei anderen Aufgaben', async () => {
    const task = await makeTask({ origin: 'api' })
    await runDraftTask(db, ws, task.id, anthropicMock({ verdict: 'ok', reason: 'passt' }).fn, { webFetch: web })
    const d = await latestDraft(task.id)
    expect(d.status).toBe('freigegeben')
    expect(d.approvedVia).toBe('reviewer')
  })

  it('offene Rückfrage oder Mail: bleibt in den Freigaben', async () => {
    const task = await makeTask({ origin: 'api' })
    await runDraftTask(db, ws, task.id, anthropicMock({ verdict: 'frage', reason: 'Datum fehlt', question: 'Wann?' }).fn, { webFetch: web })
    expect((await latestDraft(task.id)).status).toBe('offen')
  })

  it('Stufe "macht selbst": geht nach KI-Prüfung und Einspruchsfrist raus', async () => {
    const [p2] = await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'auto', name: 'Auto', code: 'AUT', icon: 'A', autonomy: { social: 'auto' } }).returning()
    await upsertConnection(db, ws.id, { provider: 'bluesky', platform: 'bluesky', name: '@auto.bsky.social', handle: 'auto.bsky.social', ext: { did: 'did:plc:auto' } }, { identifier: 'auto.bsky.social', password: 'app-pass-1234' }, { projectId: p2!.id })
    await reloadWs()
    await db.update(schema.projects).set({ setup: { social: { accountIds: listConnections(ws).filter(c => c.platform === 'bluesky').map(c => c.id) } } }).where(eq(schema.projects.id, p2!.id))
    const task = await makeTask({ origin: 'api', projectId: p2!.id, dueDate: '2026-10-13', dueTime: '08:20' })
    const out = await runDraftTask(db, ws, task.id, anthropicMock({ verdict: 'ok', reason: 'passt' }).fn, { webFetch: web })
    expect(out.summary).toContain('Posten geplant')
    const d = await latestDraft(task.id)
    expect(d.status).toBe('freigegeben')
    expect(d.approvedVia).toBe('reviewer')
    const [post] = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.taskId, task.id))
    expect(post!.scheduledAt.toISOString()).toBe('2026-10-13T06:45:00.000Z')
    expect(d.releaseAt!.toISOString()).toBe('2026-10-13T06:45:00.000Z')
    const held = await makeTask({ origin: 'api', projectId: p2!.id })
    await runDraftTask(db, ws, held.id, anthropicMock({ verdict: 'verwerfen', reason: 'Falsches Thema.' }).fn, { webFetch: web })
    expect((await latestDraft(held.id)).status).toBe('offen')
  })
})
