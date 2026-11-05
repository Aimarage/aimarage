import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { notBeforeNow } from '../../server/lib/post-slots'
import { createTask } from '../../server/lib/tasks'

describe('Aufgaben mit Uhrzeit nie vor jetzt', () => {
  it('nächste volle Stunde mit Vorlauf, spät am Tag der nächste passende Tag', () => {
    expect(notBeforeNow('2026-10-27', '09:00', '2026-10-27', '14:48')).toEqual({ date: '2026-10-27', time: '16:00' })
    expect(notBeforeNow('2026-10-27', '09:00', '2026-10-27', '14:20')).toEqual({ date: '2026-10-27', time: '15:00' })
    expect(notBeforeNow('2026-10-27', '15:00', '2026-10-27', '14:48')).toEqual({ date: '2026-10-27', time: '16:00' })
    expect(notBeforeNow('2026-10-27', '18:00', '2026-10-27', '14:48')).toEqual({ date: '2026-10-27', time: '18:00' })
    expect(notBeforeNow('2026-10-28', '09:00', '2026-10-27', '14:48')).toEqual({ date: '2026-10-28', time: '09:00' })
    expect(notBeforeNow('2026-10-27', '09:00', '2026-10-27', '05:10')).toEqual({ date: '2026-10-27', time: '09:00' })
    expect(notBeforeNow('2026-10-27', '09:00', '2026-10-27', '20:40')).toEqual({ date: '2026-10-28', time: '09:00' })
    expect(notBeforeNow('2026-10-30', '09:00', '2026-10-30', '21:10', { weekend: false })).toEqual({ date: '2026-11-02', time: '09:00' })
    expect(notBeforeNow('2026-10-30', '09:00', '2026-10-30', '21:10')).toEqual({ date: '2026-10-31', time: '09:00' })
  })

  describe('beim Anlegen', () => {
    let db: Db
    let close: () => Promise<void>
    let wsId: string
    let pid: string
    let peter: string
    const before = process.env.MA_NOW

    beforeAll(async () => {
      process.env.MA_NOW = '2026-10-27T14:48:00+01:00'
      ;({ db, close } = await openTestDb())
      wsId = (await db.insert(schema.workspaces).values({ name: 'Test', timezone: 'Europe/Vienna' }).returning())[0]!.id
      peter = (await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning())[0]!.id
      pid = (await db.insert(schema.projects).values({ workspaceId: wsId, slug: 'neu', name: 'Neu', code: 'NEU', icon: 'N' }).returning())[0]!.id
    })
    afterAll(async () => {
      if (before === undefined) delete process.env.MA_NOW
      else process.env.MA_NOW = before
      await close()
    })

    it('geplante Aufgabe heute um 09:00 rückt hinter jetzt, ganztags und vom Menschen gesetzt bleiben', async () => {
      const base = { workspaceId: wsId, projectId: pid, category: 'community' as const, dueDate: '2026-10-27' }
      const planned = await createTask(db, { ...base, title: 'Reddit-Communities', dueTime: '09:00' })
      expect(planned.dueDate).toBe('2026-10-27')
      expect(planned.dueTime).toBe('16:00')
      const allDay = await createTask(db, { ...base, title: 'Ganztags', dueTime: null })
      expect(allDay.dueTime).toBeNull()
      const mine = await createTask(db, { ...base, title: 'Selbst eingetragen', dueTime: '09:00', createdByUserId: peter })
      expect(mine.dueTime).toBe('09:00')
      const post = await createTask(db, { ...base, category: 'social', title: 'Post auf Mastodon', channel: 'Mastodon', dueTime: '11:00' })
      const post2 = await createTask(db, { ...base, category: 'social', title: 'Noch ein Post auf Mastodon', channel: 'Mastodon', dueTime: '11:00' })
      expect(post.dueTime).toBe('16:00')
      expect(post2.dueTime).toBe('19:00')
    })
  })
})
