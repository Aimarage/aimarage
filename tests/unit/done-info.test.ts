import { describe, expect, it } from 'vitest'
import { doneInfo } from '../../shared/utils/done-info'
import { pageLabel, taskTitle } from '../../shared/utils/task-title'
import { todoOf } from '../../shared/utils/todo'
import de from '../../i18n/locales/de.json'
import en from '../../i18n/locales/en.json'

const AT = '2026-11-03T12:48:00.000Z'
const ev = (action: string, actor: string, createdAt: string, detail: Record<string, unknown> = {}, userId: string | null = null) => ({ action, actor, userId, detail, createdAt })

describe('Erledigte Aufgabe: wann, wer, was', () => {
  it('Notiz von Claude über MCP', () => {
    const d = doneInfo([ev('status:erledigt', 'mcp', AT, {}, 'u1'), ev('note_added', 'mcp', AT)], [{ text: 'Startseite: Einleitung und FAQ aktualisiert, Commit abc123.', byAgent: false, userId: 'u1', createdAt: '2026-11-03T12:48:01.000Z' }], AT)
    expect(d).toMatchObject({ at: AT, actor: 'mcp', userId: null, note: 'Startseite: Einleitung und FAQ aktualisiert, Commit abc123.' })
  })

  it('ältere Notizen zählen nicht als Erledigungsnotiz', () => {
    const d = doneInfo([ev('status:erledigt', 'user', AT, {}, 'u1')], [{ text: 'Rückfrage von früher', byAgent: false, userId: 'u1', createdAt: '2026-10-20T08:00:00.000Z' }], AT)
    expect(d).toMatchObject({ actor: 'user', userId: 'u1', note: null, checked: [] })
  })

  it('automatische Prüfung liefert, was geprüft wurde', () => {
    const d = doneInfo([ev('task_checked_auto', 'agent', AT, { items: ['/online-bookmarks seit 14.10. überarbeitet'] }), ev('status:erledigt', 'agent', AT)], [], AT)
    expect(d).toMatchObject({ actor: 'agent', note: null, checked: ['/online-bookmarks seit 14.10. überarbeitet'] })
  })

  it('Prüfung über MCP zählt als Claude, auch wenn der Status-Eintrag anders lautet', () => {
    expect(doneInfo([ev('status:erledigt', 'agent', AT), ev('task_checked', 'mcp', AT, { items: ['ok'] })], [], AT).actor).toBe('mcp')
  })

  it('ohne Verlauf: kein Wer, keine Notiz', () => {
    expect(doneInfo([], [], AT)).toEqual({ at: AT, actor: null, userId: null, note: null, checked: [], from: null })
  })

  it('Status vor dem Erledigen, damit der ursprüngliche Satz stehen bleibt', () => {
    expect(doneInfo([ev('status:erledigt', 'mcp', AT, { changes: { status: { from: 'freigegeben', to: 'erledigt' } } })], [], AT).from).toBe('freigegeben')
  })

  it('Box nennt, wer erledigt hat', () => {
    expect(todoOf({ status: 'erledigt', category: 'pflege', out: 'self', doneAt: AT, doneBy: 'Claude (MCP)' })).toMatchObject({ key: 'done.plainBy', params: { who: 'Claude (MCP)' } })
    expect(todoOf({ status: 'erledigt', category: 'pflege', out: 'self', doneAt: AT })).toMatchObject({ key: 'done.plain' })
  })

  it('Texte für die Erledigt-Box gibt es auf Deutsch und Englisch', () => {
    for (const l of [de, en]) {
      const d = l.todo.done as Record<string, unknown>
      for (const k of ['title', 'what', 'checked', 'noNote', 'plainBy', 'postedBy', 'sentBy', 'anyBy']) expect(typeof d[k]).toBe('string')
      expect(Object.keys(d.who as object).sort()).toEqual(['agent', 'mcp', 'system'])
      expect(JSON.stringify(d)).not.toMatch(/[\u2013\u2014]/)
    }
  })
})

describe('Titel von Pflege-Aufgaben', () => {
  it('Startseite statt Schrägstrich', () => {
    expect(taskTitle('/ überarbeiten: in Google abgerutscht')).toBe('Startseite überarbeiten: in Google abgerutscht')
    expect(taskTitle('/online-bookmarks überarbeiten: in Bing abgerutscht')).toBe('Seite „online-bookmarks“ überarbeiten: in Bing abgerutscht')
    expect(pageLabel('/')).toBe('Startseite')
    expect(pageLabel('/de/preise/')).toBe('Seite „de/preise“')
  })

  it('andere Titel bleiben', () => {
    for (const t of ['Seitentitel von /de/preise kürzen', 'Artikel: Neues Album', 'r/aiMusic: Antwort', '/']) expect(taskTitle(t)).toBe(t)
  })
})
