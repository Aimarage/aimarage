import { and, eq, like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkDraft } from '../../shared/utils/drafting'
import { oldReleaseHit, RELEASE_CHECK, releaseFocus, releaseRule, strategyStale, type KnownRelease } from '../../shared/utils/release-focus'
import { runDraftTask } from '../../server/lib/agent'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { createRelease } from '../../server/lib/release'
import { knownReleases, proposeReleaseStrategy, releaseFocusFor, staleStrategies } from '../../server/lib/release-focus'
import { reviewProject } from '../../server/lib/review'
import { activeStrategy, approveProposal, createStrategyVersion, pendingProposal, activateStrategy } from '../../server/lib/strategy'
import { createTask } from '../../server/lib/tasks'

const ALBERT: KnownRelease = { title: 'Albert', kind: 'album', releaseDate: '2026-08-11', items: ['End of Time', 'Intro', 'Moonlight Drive'] }
const SUPER: KnownRelease = { title: 'Superposition', kind: 'album', releaseDate: '2026-10-04', items: ['The Observer Dies', 'Planck', 'Intro'] }
const NEXT: KnownRelease = { title: 'Nebula', kind: 'single', releaseDate: '2026-11-03', items: ['Nebula'] }

describe('Aktuelles Release (ohne Datenbank)', () => {
  it('neuestes Release bis heute, ältere und angekündigte getrennt', () => {
    const f = releaseFocus([SUPER, NEXT, ALBERT], '2026-10-11')!
    expect(f.current.title).toBe('Superposition')
    expect(f.older.map(r => r.title)).toEqual(['Albert'])
    expect(f.upcoming.map(r => r.title)).toEqual(['Nebula'])
    expect(releaseFocus([SUPER, ALBERT], '2026-09-01')!.current.title).toBe('Albert')
    expect(releaseFocus([NEXT], '2026-10-11')).toBeNull()
    expect(releaseRule(f)).toContain('AKTUELLES RELEASE: Album "Superposition"')
    expect(releaseRule(f)).toContain('Album "Albert" (11.08.2026)')
  })

  it('altes Release ohne das aktuelle ist ein Treffer; gemeinsame und kurze Namen nicht', () => {
    const f = releaseFocus([SUPER, ALBERT], '2026-10-11')!
    expect(oldReleaseHit('Teaser für "End of Time" auf Instagram', f)?.term).toBe('End of Time')
    expect(oldReleaseHit('Das Album Albert ist da', f)?.release.title).toBe('Albert')
    expect(oldReleaseHit('End of Time ist auf dem alten Album, neu ist Superposition', f)).toBeNull()
    expect(oldReleaseHit('Das Intro des Albums', f)).toBeNull()
    expect(oldReleaseHit('Song über das Ende der Zeit, the endoftime', f)).toBeNull()
    expect(oldReleaseHit('End of Time', releaseFocus([ALBERT], '2026-10-11'))).toBeNull()
  })

  it('Entwurfsprüfung meldet das ältere Release wie einen Regelverstoß', () => {
    const f = releaseFocus([SUPER, ALBERT], '2026-10-11')!
    const base = { type: 'post' as const, category: 'social', kind: 'post', platform: null, recent: [] }
    const issues = checkDraft({ ...base, body: 'Hört rein: End of Time, unser Track über das Ende.', release: f })
    expect(issues.map(i => i.code)).toContain('old_release')
    expect(issues.find(i => i.code === 'old_release')!.text).toBe('"End of Time" (Albert), aktuell: Superposition')
    expect(checkDraft({ ...base, body: 'Hört rein: The Observer Dies vom neuen Album.', release: f }).map(i => i.code)).not.toContain('old_release')
    expect(checkDraft({ ...base, body: 'Hört rein: End of Time.', release: null }).map(i => i.code)).not.toContain('old_release')
  })

  it('Strategie veraltet: nennt das alte Release oder ist älter als das aktuelle', () => {
    const f = releaseFocus([SUPER, ALBERT], '2026-10-11')!
    expect(strategyStale(['Themen: End of Time vorstellen'], f, '2026-09-01')).toMatchObject({ reason: 'old' })
    expect(strategyStale(['Themen: Hörer gewinnen'], f, '2026-09-01')).toEqual({ reason: 'before' })
    expect(strategyStale(['Themen: Hörer gewinnen'], f, '2026-10-06')).toBeNull()
    expect(strategyStale(['End of Time und Superposition'], f, '2026-09-01')).toBeNull()
  })
})

describe('Release-Fokus mit Datenbank', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  let project: typeof schema.projects.$inferSelect
  let userId: string

  const reply = (content: string) => new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })

  beforeAll(async () => {
    process.env.MA_NOW = '2026-08-20T09:00:00+02:00'
    ;({ db, close } = await openTestDb())
    ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning())[0]!
    const [u] = await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning()
    userId = u!.id
    await db.insert(schema.memberships).values({ workspaceId: ws.id, userId, role: 'owner' })
    project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'thewanderer', name: 'The Wanderer', code: 'THE', icon: 'T' }).returning())[0]!
    await db.insert(schema.projectMembers).values({ projectId: project.id, userId, role: 'owner' })
    await createRelease(db, ws, project, { title: 'Albert', kind: 'album', releaseDate: '2026-08-11', items: ['End of Time', 'Moonlight Drive'] }, { userId })
    const st = await createStrategyVersion(db, project, {
      channels: [
        { key: 'social', name: 'Social Media', category: 'social', why: 'Hörer erreichen', goalIds: [], weight: 5, days: ['TU'], active: true, places: ['Instagram'], topics: ['End of Time vorstellen', 'Bandfotos'] },
        { key: 'verzeichnisse', name: 'Verzeichnisse', category: 'verzeichnis', why: 'Auffindbar', goalIds: [], weight: 2, days: ['WE'], active: true, places: [], topics: ['Album Albert eintragen'] },
      ],
      summary: 'Fokus auf End of Time.',
      status: 'vorschlag',
      kind: 'initial',
      byAgent: true,
    })
    await activateStrategy(db, project, st, '2026-08-20', { userId })
    process.env.MA_NOW = '2026-10-11T09:00:00+02:00'
  })

  afterAll(async () => {
    delete process.env.MA_NOW
    await close()
  })

  it('Releases aus den Kampagnen, auch alte Kampagnen ohne gespeichertes Release', async () => {
    const [c] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.projectId, project.id))
    expect(c!.release).toEqual({ title: 'Albert', kind: 'album', releaseDate: '2026-08-11', items: ['End of Time', 'Moonlight Drive'] })
    for (const [i, t] of ['End of Time', 'Moonlight Drive', 'das ganze Album'].entries()) await createTask(db, { workspaceId: ws.id, projectId: project.id, campaignId: c!.id, title: `Albert-Serie ${i + 1}/3: ${t}`, category: 'social', dueDate: `2026-08-1${i + 2}`, status: 'erledigt' })
    await db.update(schema.campaigns).set({ release: null }).where(eq(schema.campaigns.id, c!.id))
    const list = await knownReleases(db, project.id)
    expect(list).toEqual([{ title: 'Albert', kind: 'album', releaseDate: '2026-08-11', items: ['End of Time', 'Moonlight Drive'] }])
  })

  it('neues Release: Strategie-Vorschlag (nicht freigegeben), alte Agenten-Aufgaben ab Release zum Prüfen', async () => {
    const old = await createTask(db, { workspaceId: ws.id, projectId: project.id, title: 'Instagram: End of Time Teaser', category: 'social', channel: 'Instagram', dueDate: '2026-10-14', agentStep: 'Beitrag entwerfen', draftKind: 'post' })
    const mine = await createTask(db, { workspaceId: ws.id, projectId: project.id, title: 'Bandfoto posten', category: 'social', channel: 'Instagram', dueDate: '2026-10-14', agentStep: 'Beitrag entwerfen', draftKind: 'post' })
    const before = (await activeStrategy(db, project.id))!
    await createRelease(db, ws, project, { title: 'Superposition', kind: 'album', releaseDate: '2026-10-04', items: ['The Observer Dies', 'Planck'] }, { userId })

    const active = (await activeStrategy(db, project.id))!
    expect(active.id).toBe(before.id)
    const prop = (await pendingProposal(db, project.id))!
    expect([prop.status, prop.kind, prop.byAgent]).toEqual(['vorschlag', 'release', true])
    expect(prop.summary).toContain('Superposition')
    const social = prop.channels.find(c => c.key === 'social')!
    expect(social.topics![0]).toContain('Album "Superposition"')
    expect(social.topics).not.toContain('End of Time vorstellen')
    expect(social.topics).toContain('Bandfotos')
    expect(prop.channels.find(c => c.key === 'verzeichnisse')!.topics).toEqual([])

    const notes = await db.select().from(schema.taskNotes).where(like(schema.taskNotes.text, `${RELEASE_CHECK}%`))
    expect(notes.map(n => n.taskId)).toContain(old.id)
    expect(notes.map(n => n.taskId)).not.toContain(mine.id)
    expect(notes.every(n => n.byAgent)).toBe(true)
    expect((await releaseFocusFor(db, project.id, '2026-10-11'))!.current.title).toBe('Superposition')
  })

  it('Entwurf: Aufgabe zum alten Release wird nicht entworfen, Entwurf mit altem Track wird nachgebessert', async () => {
    const [old] = await db.select().from(schema.tasks).where(eq(schema.tasks.title, 'Instagram: End of Time Teaser'))
    const none = async () => reply('{}')
    const r = await runDraftTask(db, ws, old!.id, none as unknown as typeof fetch)
    expect(r.summary).toContain('Älteres Release')
    expect(await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, old!.id))).toHaveLength(0)

    await db.insert(schema.taskNotes).values({ taskId: old!.id, byAgent: false, text: 'Ja, End of Time bewusst nochmal bringen.' })
    const calls: string[] = []
    const llm = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { role: string, content: string }[] }
      if (body.messages[0]!.content.includes('Lektor')) return reply('{"problems": []}')
      calls.push(body.messages.at(-1)!.content)
      return reply(JSON.stringify({ kind: 'post', body: 'End of Time, noch einmal.', media: 'none' }))
    }
    expect((await runDraftTask(db, ws, old!.id, llm as unknown as typeof fetch)).status).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('nennt ein älteres Release ausdrücklich')

    const neutral = await createTask(db, { workspaceId: ws.id, projectId: project.id, title: 'Post über die Band', category: 'social', channel: 'Bluesky', dueDate: '2026-10-12', agentStep: 'Beitrag entwerfen', draftKind: 'post' })
    const seen: string[] = []
    const fix = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { role: string, content: string }[] }
      if (body.messages[0]!.content.includes('Lektor')) return reply('{"problems": []}')
      const last = body.messages.at(-1)!.content
      seen.push(last)
      return reply(JSON.stringify({ kind: 'post', body: last.includes('Nachprüfung') ? 'Neu: The Observer Dies vom Album Superposition.' : 'Hört End of Time.', media: 'none' }))
    }
    await runDraftTask(db, ws, neutral.id, fix as unknown as typeof fetch)
    expect(seen[0]).toContain('AKTUELLES RELEASE: Album "Superposition"')
    expect(seen[1]).toContain('Nennt ein älteres Release')
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.taskId, neutral.id))
    expect(d!.body).toContain('Superposition')
  })

  it('Wochen-Check: veraltete Strategie als Hinweis, Vorschlag neu, nach Freigabe nicht mehr veraltet', async () => {
    const stale = await staleStrategies(db, ws)
    expect(stale).toHaveLength(1)
    expect(stale[0]).toMatchObject({ reason: 'old', release: 'Superposition' })
    const prop = (await pendingProposal(db, project.id))!
    expect(stale[0]!.proposalId).toBe(prop.id)

    await db.update(schema.strategies).set({ status: 'verworfen' }).where(eq(schema.strategies.id, prop.id))
    const r = (await reviewProject(db, ws, project, { llm: null }))!
    expect(r.summary).toContain('Strategie veraltet')
    const again = (await pendingProposal(db, project.id))!
    expect(again.kind).toBe('release')
    expect(again.id).not.toBe(prop.id)

    await approveProposal(db, project, again, '2026-10-11', userId)
    expect(await staleStrategies(db, ws)).toEqual([])
    expect((await activeStrategy(db, project.id))!.channels.find(c => c.key === 'social')!.topics![0]).toContain('Superposition')
    const [act] = await db.select().from(schema.activity).where(and(eq(schema.activity.projectId, project.id), eq(schema.activity.action, 'strategy_stale')))
    expect(act).toBeTruthy()
  })

  it('Hauptschalter aus: kein automatischer Vorschlag', async () => {
    const off = { ...ws, settings: { ...ws.settings, agentEnabled: false } }
    const focus = (await releaseFocusFor(db, project.id, '2026-10-11'))!
    expect(await proposeReleaseStrategy(db, off, project, focus, 'release')).toBeNull()
  })
})
