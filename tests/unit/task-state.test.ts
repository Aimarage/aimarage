import { describe, expect, it } from 'vitest'
import { forYouNow, humanDay, humanMinutes, isOverdue, taskView, viewMinutes, waitingLater, type TaskFacts } from '../../shared/utils/task-state'
import { waitingText } from '../../server/lib/app/views'
import { routeOf, type RouteTask } from '../../server/services/views'
import { costOf } from '../../server/lib/time-budget'
import { digestText } from '../../server/lib/morning-digest'
import { chosenPlatforms, targetAccounts, taskPlatform, type SocialTarget } from '../../server/lib/publish'

const base: TaskFacts = { status: 'geplant', dueDate: '2026-10-13', dueTime: null, category: 'social', owner: 'agent', route: 'approve', goesOut: false }
const tue = { today: '2026-10-13', time: '10:00' }

describe('Eine Wahrheit je Aufgabe', () => {
  it('erledigt, verworfen, wartet: niemand ist dran', () => {
    expect(taskView({ ...base, status: 'erledigt' }, tue)).toMatchObject({ who: 'done', state: 'done', bucket: 'done' })
    expect(taskView({ ...base, status: 'verworfen' }, tue)).toMatchObject({ who: 'dropped', state: 'done' })
    expect(taskView({ ...base, status: 'wartet' }, tue)).toMatchObject({ who: 'waiting', state: 'done', min: 0 })
  })

  it('BMX-COM-002: freigegebener Selbst-Post (Mi 14.10. 14:00) steht erst am Mittwoch unter "Du bist dran", überfällig erst nach dem Termin', () => {
    const f: TaskFacts = { ...base, status: 'freigegeben', category: 'community', draftKind: 'post', owner: 'human', draft: 'approved', route: 'self', dueDate: '2026-10-14', dueTime: '14:00', durationMin: 30 }
    expect(taskView(f, tue)).toMatchObject({ who: 'you', next: 'post', bucket: 'soon', now: false, overdue: false, visibleFrom: '2026-10-14' })
    expect(taskView(f, { today: '2026-10-14', time: '09:00' })).toMatchObject({ bucket: 'yours', now: true, overdue: false })
    expect(taskView(f, { today: '2026-10-14', time: '14:31' })).toMatchObject({ bucket: 'yours', overdue: true })
    expect(taskView({ ...f, dueDate: '2026-11-10', dueTime: null }, tue)).toMatchObject({ bucket: 'soon', overdue: false })
  })

  it('Verzeichnis und Blog ohne API gehören zu "Du bist dran" am Fälligkeitstag, nie zu "Geht raus"', () => {
    const dir: TaskFacts = { ...base, status: 'freigegeben', category: 'verzeichnis', draftKind: 'text', owner: 'human', draft: 'approved', route: 'self', dueDate: '2026-11-09', dueTime: '15:00' }
    expect(taskView(dir, tue)).toMatchObject({ who: 'you', bucket: 'soon' })
    expect(taskView(dir, { today: '2026-11-09', time: '08:00' })).toMatchObject({ who: 'you', bucket: 'yours', now: true })
    const blog: TaskFacts = { ...dir, category: 'content', draftKind: 'article', dueDate: '2026-11-12' }
    expect(taskView(blog, tue).bucket).toBe('soon')
    expect(taskView({ ...blog, goesOut: true }, tue)).toMatchObject({ who: 'ai', bucket: 'outgoing', state: 'ai', date: '2026-11-12' })
  })

  it('"Geht raus" nur, wenn die KI selbst veröffentlicht; geplanter Versand liefert das Datum', () => {
    const f: TaskFacts = { ...base, status: 'freigegeben', draft: 'approved', goesOut: true, dueDate: '2026-10-18', dueTime: '18:00' }
    expect(taskView(f, tue)).toMatchObject({ who: 'ai', next: 'aiPublishes', bucket: 'outgoing', min: 0 })
    expect(taskView({ ...f, scheduledAt: '2026-10-18T16:00:00.000Z' }, tue)).toMatchObject({ next: 'aiScheduled', at: '2026-10-18T16:00:00.000Z' })
  })

  it('Kalender: "Braucht deine Freigabe" nur mit offenem Entwurf, sonst KI macht es', () => {
    expect(taskView({ ...base, status: 'entwurf_fertig', draft: 'open', goesOut: true }, tue)).toMatchObject({ state: 'you', next: 'approve', bucket: 'yours', min: 1 })
    expect(taskView({ ...base, route: 'approve' }, tue)).toMatchObject({ state: 'ai', next: 'aiWrites', min: 0, plannedMin: 1 })
    expect(taskView({ ...base, route: 'auto' }, tue)).toMatchObject({ state: 'ai', next: 'aiPublishes', plannedMin: 0 })
    expect(taskView({ ...base, busy: true }, tue)).toMatchObject({ state: 'ai', next: 'aiWrites' })
    expect(taskView({ ...base, status: 'entwurf_fertig', draft: 'open', claudeChecks: true, goesOut: true, dueDate: '2026-10-14' }, tue)).toMatchObject({ who: 'claude', bucket: 'claude', min: 0, then: null })
    expect(taskView({ ...base, status: 'entwurf_fertig', draft: 'open', claudeChecks: true, info: true }, tue)).toMatchObject({ who: 'you', next: 'answer' })
  })

  it('Freigaben erscheinen am Fälligkeitstag, ohne Termin sofort; Aufgaben ohne Termin nie heute', () => {
    const open: TaskFacts = { ...base, status: 'entwurf_fertig', draft: 'open', goesOut: true, dueDate: '2026-10-15' }
    expect(taskView(open, tue)).toMatchObject({ bucket: 'soon', now: false })
    expect(taskView({ ...open, dueDate: null }, tue)).toMatchObject({ bucket: 'yours', now: true })
    expect(taskView({ ...base, owner: 'human', dueDate: null }, tue)).toMatchObject({ who: 'you', now: false })
  })

  it('Wochenende: Menschenarbeit nie Sa/So, KI-Posts schon', () => {
    const sun: TaskFacts = { ...base, status: 'freigegeben', draft: 'approved', dueDate: '2026-10-18', dueTime: '18:00' }
    expect(taskView({ ...sun, goesOut: true }, { today: '2026-10-16', time: '09:00' })).toMatchObject({ who: 'ai', bucket: 'outgoing' })
    expect(taskView(sun, { today: '2026-10-16', time: '09:00' })).toMatchObject({ who: 'you', visibleFrom: '2026-10-16', now: true, overdue: false })
    expect(taskView({ ...sun, humanWeekend: true }, { today: '2026-10-16', time: '09:00' })).toMatchObject({ visibleFrom: '2026-10-18', now: false })
    expect(humanDay('2026-10-17')).toBe('2026-10-16')
    expect(humanDay('2026-10-19')).toBe('2026-10-19')
  })

  it('Menschen-Aufgabe ohne Agent: selbst erledigen mit Schätzung', () => {
    expect(taskView({ ...base, owner: 'human', estimateMin: 10 }, tue)).toMatchObject({ who: 'you', next: 'do', min: 10, now: true })
    expect(taskView({ ...base, forClaude: true, owner: 'human' }, tue)).toMatchObject({ who: 'claude', min: 0 })
  })
})

describe('Claude prüft, danach postet der Mensch', () => {
  const thu = { today: '2026-10-16', time: '09:00' }
  const reddit: TaskFacts = { ...base, status: 'entwurf_fertig', category: 'community', draftKind: 'post', draft: 'open', claudeChecks: true, goesOut: false, dueDate: '2026-10-16', dueTime: '17:00', userId: 'peter' }

  it('THE-COM-007: Reddit-Beitrag um 17:00 zählt heute schon als ca. 3 Min für den Menschen', () => {
    const v = taskView(reddit, thu)
    expect(v).toMatchObject({ who: 'claude', next: 'claudeChecks', bucket: 'claude', then: 'post', now: true, min: 3, plannedMin: 3, overdue: false, visibleFrom: '2026-10-16' })
    expect(forYouNow(v)).toBe(true)
    expect(humanMinutes(v)).toBe(3)
    expect(viewMinutes([v])).toBe(3)
    expect(costOf(v)).toEqual({ kind: 'self', min: 3, userId: 'peter' })
    const mail = digestText({ userId: 'peter', minutes: 3, items: [{ title: 'Reddit: Superposition-Konzept vorstellen', time: '17:00', min: 3, url: 'x', afterCheck: true }] }, 'de')
    expect(mail.subject).toBe('Heute für dich: ca. 3 Minuten')
    expect(mail.body).toContain('Reddit: Superposition-Konzept vorstellen (17:00) - selbst posten, Claude prüft vorher')
  })

  it('später fällig: geplant, aber heute nicht', () => {
    const v = taskView({ ...reddit, dueDate: '2026-10-20' }, thu)
    expect(v).toMatchObject({ then: 'post', now: false, plannedMin: 3 })
    expect(forYouNow(v)).toBe(false)
  })

  it('postet die KI danach selbst: vor dem Fälligkeitstag prüft Claude, für den Menschen nichts zu tun', () => {
    const v = taskView({ ...reddit, goesOut: true, dueDate: '2026-10-20' }, thu)
    expect(v).toMatchObject({ who: 'claude', next: 'claudeChecks', then: null, min: 0, plannedMin: 0 })
    expect(forYouNow(v)).toBe(false)
    expect(viewMinutes([v])).toBe(0)
    expect(costOf(v)).toMatchObject({ kind: 'claude', min: 0 })
  })

  it('BIT-CON-006 / BMX-SOC-013: am Fälligkeitstag noch nicht freigegeben, dann gibst du frei (nie "nichts an")', () => {
    const sat = { today: '2026-10-17', time: '10:45' }
    const article: TaskFacts = { ...base, status: 'entwurf_fertig', category: 'content', draftKind: 'article', draft: 'open', claudeChecks: true, goesOut: true, dueDate: '2026-10-17', dueTime: '10:00', userId: 'peter' }
    const a = taskView(article, sat)
    expect(a).toMatchObject({ who: 'you', next: 'approve', bucket: 'yours', now: true, overdue: true })
    expect(forYouNow(a)).toBe(true)
    expect(humanMinutes(a)).toBeGreaterThan(0)
    const post = taskView({ ...article, category: 'social', draftKind: 'post', dueTime: '11:00' }, sat)
    expect(post).toMatchObject({ who: 'you', next: 'approve', now: true, overdue: false, min: 1 })
    expect(viewMinutes([a, post])).toBeGreaterThan(1)
    expect(taskView(article, { today: '2026-10-16', time: '09:00' })).toMatchObject({ who: 'you', now: true, visibleFrom: '2026-10-16' })
    expect(taskView({ ...article, dueDate: null, dueTime: null }, sat)).toMatchObject({ who: 'you', now: true })
  })

  it('selbst posten nach Claudes Prüfung: nach dem Termin noch nicht freigegeben, dann prüfst du selbst', () => {
    const v = taskView(reddit, { today: '2026-10-16', time: '17:30' })
    expect(v).toMatchObject({ who: 'you', next: 'review', overdue: true, now: true })
    expect(forYouNow(v)).toBe(true)
  })
})

describe('Überfällig', () => {
  const t = { status: 'geplant' as const, dueDate: '2026-10-08', dueTime: '09:00', durationMin: 30 }

  it('Datum vorbei', () => {
    expect(isOverdue({ ...t, dueDate: '2026-10-07' }, '2026-10-08', '08:00')).toBe(true)
    expect(isOverdue({ ...t, dueDate: '2026-10-07', dueTime: null }, '2026-10-08', '08:00')).toBe(true)
  })

  it('heute erst nach Ende der Uhrzeit', () => {
    expect(isOverdue(t, '2026-10-08', '09:15')).toBe(false)
    expect(isOverdue(t, '2026-10-08', '09:30')).toBe(true)
    expect(isOverdue({ ...t, dueTime: null }, '2026-10-08', '23:00')).toBe(false)
  })

  it('erledigte und künftige Aufgaben nie', () => {
    expect(isOverdue({ ...t, status: 'erledigt', dueDate: '2026-10-01' }, '2026-10-08', '12:00')).toBe(false)
    expect(isOverdue({ ...t, dueDate: '2026-10-09' }, '2026-10-08', '23:59')).toBe(false)
    expect(isOverdue({ ...t, dueDate: null }, '2026-10-08', '12:00')).toBe(false)
  })
})

describe('Weg nach dem Entwurf', () => {
  const task: RouteTask = { title: 'Post: Release', category: 'social', channel: 'Bluesky', draftKind: 'post', humanStep: 'Prüfen und posten', assigneeUserId: 'u1' }
  const project = { autonomy: {}, setup: {} }

  it('Social: ohne Konto selbst posten, mit Konto Freigabe, mit auto automatisch', () => {
    expect(routeOf(task, project, false)).toBe('self')
    expect(routeOf(task, project, true)).toBe('approve')
    expect(routeOf(task, { ...project, autonomy: { social: 'auto' } }, true)).toBe('auto')
  })

  it('Community bleibt immer selbst, Recherche läuft automatisch', () => {
    expect(routeOf({ ...task, title: 'Antwort in r/gdpr', category: 'community', channel: 'r/gdpr' }, { autonomy: { community: 'auto' }, setup: {} }, true)).toBe('self')
    expect(routeOf({ ...task, title: 'Recherche: r/audiophile Top-Posts', category: 'community' }, project, false)).toBe('auto')
  })

  it('Mail: ohne Postfach selbst senden, mit Postfach Freigabe', () => {
    const mail = { ...task, title: 'Pitch: Kurator', category: 'outreach' as const, draftKind: 'mail' as const }
    expect(routeOf(mail, project, false)).toBe('self')
    expect(routeOf(mail, { autonomy: {}, setup: { mail: { smtp: { host: 'smtp.example.com' } } } } as never, false)).toBe('approve')
  })
})

describe('Kanal auf verbundenes Konto abbilden', () => {
  const target = { cfg: {} as SocialTarget['cfg'], profile: null, platforms: [
    { platform: 'bluesky', name: '@tonebase.bsky.social', postable: true, via: 'c1' },
    { platform: 'mastodon', name: '@tonebase@mastodon.social', postable: true, via: 'c2' },
  ] } satisfies SocialTarget
  const post = { title: 'Erster Post: Vorstellung Tonebase', category: 'social', channel: 'Mastodon (#flac)', targetUrl: null }

  it('Kanaltext mit Zusatz trifft das Konto der Plattform', () => {
    expect(taskPlatform(post)).toBe('mastodon')
    expect(targetAccounts(target, post).map(a => a.name)).toEqual(['@tonebase@mastodon.social'])
  })

  it('ohne passendes Konto keins, ohne erkennbare Plattform alle', () => {
    expect(targetAccounts(target, { ...post, channel: 'LinkedIn' })).toEqual([])
    expect(targetAccounts(target, { ...post, channel: 'Social' }).length).toBe(2)
    expect(targetAccounts(null, post)).toEqual([])
  })

  it('Entwurf ohne gewählte Plattformen geht nur auf die Plattform der Aufgabe', () => {
    expect(chosenPlatforms({ platforms: [] }, target, post)).toEqual(['mastodon'])
    expect(chosenPlatforms({ platforms: [] }, target, { ...post, channel: 'LinkedIn' })).toEqual([])
    expect(chosenPlatforms({ platforms: ['bluesky'] }, target, post)).toEqual(['bluesky'])
    expect(chosenPlatforms({ platforms: [] }, target)).toEqual(['bluesky', 'mastodon'])
  })
})

describe('Realistische Minuten', () => {
  it('Freigabe eines Social-Posts 1 Minute, Verzeichnis selbst eintragen nach Claudes Prüfung 5, Reddit selbst posten 3', () => {
    const open = { ...base, status: 'entwurf_fertig' as const, draft: 'open' as const, claudeChecks: true }
    expect(taskView({ ...open, goesOut: true }, { today: '2026-10-13', time: '09:00' })).toMatchObject({ next: 'approve', min: 1 })
    expect(taskView({ ...open, category: 'verzeichnis', draftKind: 'text', estimateMin: 30 }, tue)).toMatchObject({ who: 'claude', then: 'post', min: 5 })
    expect(taskView({ ...open, category: 'community', draftKind: 'post' }, tue)).toMatchObject({ who: 'claude', then: 'post', min: 3 })
  })
})

describe('Heute nichts fällig, aber Freigaben warten', () => {
  it('Sonntag: Entwürfe fällig ab Montag zählen als wartend, Rückfragen extra, nie "nichts zu tun"', () => {
    const sun = { today: '2026-11-01', time: '09:00' }
    const draft: TaskFacts = { ...base, draft: 'open', status: 'entwurf_fertig', goesOut: true }
    const views = [
      taskView({ ...draft, dueDate: '2026-11-02' }, sun),
      taskView({ ...draft, dueDate: '2026-11-05', info: true }, sun),
      taskView({ ...draft, dueDate: '2026-11-15', claudeChecks: true }, sun),
      taskView({ ...base, dueDate: '2026-11-03' }, sun),
    ]
    expect(views.filter(forYouNow)).toHaveLength(0)
    const w = waitingLater(views)
    // Der Claude-Entwurf zählt nur unter "Claude prüft", nicht doppelt bei den wartenden Freigaben.
    expect(w).toEqual({ soon: 2, info: 1, next: '2026-11-02', claude: 1, claudeNext: '2026-11-13' })
    expect(waitingText('de', sun.today, w!)).toBe('Wochenende, heute nichts fällig. 2 Freigaben warten auf dich, 1 braucht Infos von dir (nächste fällig morgen). Claude prüft 1 Entwurf (fällig Fr 13.11.), ist er am Fälligkeitstag nicht freigegeben, bist du dran.')
    expect(waitingText('de', '2026-10-28', { soon: 9, info: 4, next: '2026-11-02', claude: 0, claudeNext: null })).toBe('Heute nichts fällig. 9 Freigaben warten auf dich, 4 brauchen Infos von dir (nächste fällig Mo).')
    expect(waitingLater([taskView({ ...base, dueDate: '2026-11-03' }, sun)])).toBeNull()
  })

  it('Alle wartenden Entwürfe liegen bei Claude: ein Satz, keine "Freigaben warten"', () => {
    const sat = { today: '2026-11-07', time: '10:00' }
    const draft: TaskFacts = { ...base, draft: 'open', status: 'entwurf_fertig', goesOut: true, claudeChecks: true }
    const views = ['2026-11-10', '2026-11-11', '2026-11-12'].map(dueDate => taskView({ ...draft, dueDate }, sat))
    expect(views.every(v => v.bucket === 'claude')).toBe(true)
    const w = waitingLater(views)!
    expect(w).toEqual({ soon: 0, info: 0, next: null, claude: 3, claudeNext: '2026-11-10' })
    expect(waitingText('de', sat.today, w)).toBe('Wochenende, heute nichts fällig. Claude prüft 3 Entwürfe (nächster fällig Di), was am Fälligkeitstag nicht freigegeben ist, gibst du frei.')
    expect(waitingText('en', sat.today, w)).toBe('Weekend, nothing due today. Claude is checking 3 drafts (next due Tue); whatever is not approved by its due day, you approve.')
  })

  it('Kommt bald zählt auch freigegebene Selbst-Posts wie die Freigaben-Seite, openOnly (App) nicht', () => {
    const mon = { today: '2026-11-09', time: '09:00' }
    const views = [
      taskView({ ...base, draft: 'approved', status: 'freigegeben', goesOut: false, dueDate: '2026-11-11' }, mon),
      taskView({ ...base, draft: 'open', status: 'entwurf_fertig', goesOut: true, dueDate: '2026-11-12' }, mon),
    ]
    expect(views.map(v => v.bucket)).toEqual(['soon', 'soon'])
    expect(waitingLater(views)).toMatchObject({ soon: 2, next: '2026-11-11', claude: 0 })
    expect(waitingLater(views, { openOnly: true })).toMatchObject({ soon: 1, next: '2026-11-12' })
  })
})
