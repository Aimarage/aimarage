import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { releasedDrafts } from '../../server/lib/approval-lists'
import { flairIn, todoFacts } from '../../server/lib/todo'
import { daysUntil } from '../../shared/utils/dates'
import { personalStep, todoOf } from '../../shared/utils/todo'
import { taskWhere } from '../../shared/utils/where'

describe('Das ist zu tun', () => {
  it('Listening-Antwort: lesen und freigeben, Aimarage postet', () => {
    expect(todoOf({ status: 'entwurf_fertig', category: 'community', draftKind: 'post', draft: 'open', out: 'reply', platform: 'Bluesky' })).toMatchObject({ key: 'do.reply', main: 'approve', min: 1 })
  })

  it('Reddit selbst posten mit Flair, vor dem erlaubten Tag warten', () => {
    const base = { status: 'freigegeben', category: 'community', draftKind: 'post', draft: 'approved' as const, out: 'self' as const, place: 'r/selfhosted', placeKind: 'community' as const, url: 'https://www.reddit.com/r/selfhosted/submit', flair: 'Wednesday Exceptions' }
    expect(todoOf(base)).toMatchObject({ key: 'do.postIn', main: 'copyOpen', flair: 'Wednesday Exceptions', why: 'community' })
    expect(todoOf({ ...base, waitDay: 3 })).toMatchObject({ key: 'do.waitDay', waitDay: 3, why: 'waitDay' })
    expect(todoOf({ ...base, draft: 'open', url: null }).key).toBe('do.postInRead')
  })

  it('Claude-Aufgaben, Auto-Posts und erledigte brauchen nichts', () => {
    expect(todoOf({ status: 'geplant', category: 'pflege', forClaude: true, out: 'self', owner: 'human' })).toMatchObject({ key: 'nothing.claude', main: 'none', min: 0 })
    expect(todoOf({ status: 'freigegeben', category: 'social', draft: 'approved', out: 'auto', scheduledAt: '2026-10-13T16:00:00Z' })).toMatchObject({ key: 'nothing.autoAt', at: '2026-10-13T16:00:00Z', main: 'none' })
    expect(todoOf({ status: 'erledigt', category: 'community', draft: 'approved', out: 'reply', doneAt: '2026-10-13T13:04:00Z', posted: true })).toMatchObject({ key: 'done.posted', main: 'none', doneAt: '2026-10-13T13:04:00Z' })
    expect(todoOf({ status: 'geplant', category: 'social', owner: 'agent', route: 'approve', out: 'auto' }).key).toBe('nothing.agentDraft')
  })

  it('Mail, Info-Rückfrage, Verzeichnis', () => {
    expect(todoOf({ status: 'entwurf_fertig', category: 'outreach', draftKind: 'mail', draft: 'open', out: 'mail', to: 'a@b.at' })).toMatchObject({ key: 'do.mailSend', main: 'send', min: 4 })
    expect(todoOf({ status: 'entwurf_fertig', category: 'social', draft: 'open', info: true, out: 'auto' })).toMatchObject({ key: 'do.answer', main: 'answer' })
    expect(todoOf({ status: 'geplant', category: 'verzeichnis', owner: 'human', out: 'self', place: 'DailyPlaylists', url: 'https://dailyplaylists.com', estimateMin: 10 })).toMatchObject({ key: 'do.directory', main: 'open', min: 10 })
    expect(todoOf({ status: 'geplant', category: 'verzeichnis', owner: 'human', out: 'self', humanStep: 'Melde dich bei DailyPlaylists an (gratis) und reiche Track 3 ein' })).toMatchObject({ key: 'do.text', text: 'Melde dich bei DailyPlaylists an (gratis) und reiche Track 3 ein.' })
  })

  it('humanStep nur aus Sicht des Menschen', () => {
    expect(personalStep('Melde dich bei DailyPlaylists an und reiche Track 3 ein')).toBe(true)
    expect(personalStep('Prüfen und selbst posten')).toBe(false)
    expect(personalStep('Kommentieren')).toBe(false)
    expect(personalStep('Der Agent schreibt den Text und du prüfst ihn')).toBe(false)
  })

  it('Flair aus Text', () => {
    expect(flairIn('Beiträge nur am Mittwoch mit Flair "Wednesday Exceptions", sonst Eigenwerbung')).toBe('Wednesday Exceptions')
    expect(flairIn('Flair: Release')).toBe('Release')
    expect(flairIn('Flair Pflicht')).toBeNull()
    expect(flairIn(null, 'nichts')).toBeNull()
  })

  it('Fälligkeit: morgen ist nicht überfällig', () => {
    expect(daysUntil('2026-10-13', '2026-10-14')).toBe(1)
    expect(daysUntil('2026-10-13', '2026-10-13')).toBe(0)
    expect(daysUntil('2026-10-13', '2026-10-12')).toBe(-1)
  })
})

describe('Selbst-Posts erst am Fälligkeitstag', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  let project: typeof schema.projects.$inferSelect
  const prevNow = process.env.MA_NOW

  beforeAll(async () => {
    process.env.MA_NOW = '2026-10-13T13:28:00Z'
    ;({ db, close } = await openTestDb())
    ws = (await db.insert(schema.workspaces).values({ name: 'Test', timezone: 'Europe/Vienna', settings: { subreddits: { selfhosted: { sub: 'selfhosted', promo: 'days', days: [3], flairRequired: true, flair: 'Wednesday Exceptions', links: 'yes', notes: [], source: 'public', at: '2026-10-12T00:00:00Z' } } } }).returning())[0]!
    project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'b', name: 'B', code: 'BMX', icon: 'B' }).returning())[0]!
  })
  afterAll(async () => {
    process.env.MA_NOW = prevNow
    if (prevNow === undefined) delete process.env.MA_NOW
    await close()
  })

  it('morgen fällig: unter Kommt bald, Mittwochsregel und Flair', async () => {
    const mk = async (code: string, dueDate: string) => {
      const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code, title: 'Community-Beitrag: Self-Hosting', category: 'community', channel: 'r/selfhosted', draftKind: 'post', humanStep: 'Prüfen und selbst posten', status: 'freigegeben', dueDate, dueTime: '14:00' }).returning()
      await db.insert(schema.drafts).values({ taskId: t!.id, kind: 'post', body: 'x', status: 'freigegeben', byAgent: true })
      return t!
    }
    const later = await mk('BMX-COM-002', '2026-10-14')
    const now = await mk('BMX-COM-009', '2026-10-13')
    const r = await releasedDrafts(db, ws, eq(schema.tasks.projectId, project.id))
    expect(r.soon.map(x => x.task.code)).toEqual(['BMX-COM-002'])
    expect(r.self.map(x => x.task.code)).toEqual(['BMX-COM-009'])
    const f = await todoFacts(db, ws, project, later, taskWhere(later), 'post')
    expect(f).toMatchObject({ out: 'self', flair: 'Wednesday Exceptions', flairRequired: true, waitDay: 3 })
    expect((await todoFacts(db, ws, project, now, taskWhere(now), 'post')).waitDay).toBe(3)
  })
})
