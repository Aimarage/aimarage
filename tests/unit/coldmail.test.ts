import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mailRelevant, planAllowsMail, submissionSource } from '../../shared/utils/coldmail'
import { runDraftTask, runDraftTasks } from '../../server/lib/agent'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { buildMailSettings, mailAllowed, MailError, sendDraft } from '../../server/lib/mail'
import { materializeRecurrences } from '../../server/lib/materialize'
import { channelExcluded, duplicateOf, ensureSetupTask, excludedPlatforms, isExcluded, loadPlanGuard, similarTitle } from '../../server/lib/plan-guard'
import { resetSecretCache } from '../../server/lib/secret'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let seq = 0

async function mkTask(v: Partial<typeof schema.tasks.$inferInsert>) {
  const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: `CM-${++seq}`, title: 'Pitch', category: 'outreach', status: 'geplant', dueDate: '2026-10-13', agentStep: 'Mail entwerfen', draftKind: 'mail', ...v }).returning()
  return t!
}
const statusOf = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!.status

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning())[0]!
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'chatsite', name: 'chatsite', code: 'AMW', icon: 'chat', setup: { facts: { known: ['Kein X-Konto, wir nutzen nur LinkedIn'], avoid: [] } } }).returning())[0]!
  const mail = buildMailSettings(ws.id, project.id, null, { imapHost: 'mail.test', imapPort: 993, imapSecure: true, smtpHost: 'mail.test', smtpPort: 465, smtpSecure: true, user: 'p@chatsite.com', from: 'p@chatsite.com', imapPassword: 'geheim' })
  await db.update(schema.projects).set({ setup: { ...project.setup, mail } }).where(eq(schema.projects.id, project.id))
  project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('Keine Kaltmails', () => {
  it('Regeln ohne Datenbank', () => {
    expect(mailRelevant({ category: 'outreach', draftKind: null })).toBe(true)
    expect(mailRelevant({ category: 'social', draftKind: 'post' })).toBe(false)
    expect(planAllowsMail({ category: 'outreach', draftKind: 'mail', title: 'Pitch an Hypebot', description: 'Neuen Release vorstellen' })).toBe(false)
    expect(planAllowsMail({ category: 'outreach', draftKind: 'mail', title: 'Kooperation mit Agentur', targetUrl: 'https://agentur.example' })).toBe(false)
    expect(planAllowsMail({ category: 'outreach', draftKind: 'mail', title: 'Einsendung an Kurator', description: 'Playlist nimmt Einsendungen per Mail: https://curator.example/submit' })).toBe(true)
    expect(planAllowsMail({ category: 'social', draftKind: 'post', title: 'Post' })).toBe(true)
    expect(submissionSource(['Submit your music via mail'], 'https://label.example/demos')).toBe('https://label.example/demos')
    expect(submissionSource(['Write for us: https://blog.example/write-for-us'])).toBe('https://blog.example/write-for-us')
    expect(submissionSource(['Einsendungen erwünscht'])).toBeNull()
  })

  it('Antwort auf eingegangene Mail ist erlaubt, Kaltmail nicht, Einsendung mit Quelle schon', async () => {
    const reply = await mkTask({ title: 'Antwort an Anna: Frage', category: 'pflege' })
    await db.insert(schema.mails).values({ workspaceId: ws.id, projectId: project.id, direction: 'in', status: 'empfangen', kind: 'reply', fromAddr: 'anna@example.com', subject: 'Frage', taskId: reply.id })
    expect(await mailAllowed(db, reply)).toBe(true)
    const cold = await mkTask({ title: 'Pitch an Agentur Müller' })
    expect(await mailAllowed(db, cold)).toBe(false)
    const sub = await mkTask({ title: 'Einreichung beim Kurator', targetUrl: 'https://curator.example/submissions' })
    expect(await mailAllowed(db, sub)).toBe(true)
    const noted = await mkTask({ title: 'Pitch an Redaktion' })
    await db.insert(schema.taskNotes).values({ taskId: noted.id, text: 'Redaktion bittet um Tipps an tips@news.example, steht auf https://news.example/kontakt' })
    expect(await mailAllowed(db, noted)).toBe(true)
    const follow = await mkTask({ title: 'Nachfassen: Einreichung beim Kurator', dependsOnId: sub.id })
    expect(await mailAllowed(db, follow)).toBe(true)
    const coldFollow = await mkTask({ title: 'Nachfassen: Pitch an Agentur Müller', dependsOnId: cold.id })
    expect(await mailAllowed(db, coldFollow)).toBe(false)
  })

  it('Geplante Kaltmails werden verworfen statt entworfen, Senden geht nie', async () => {
    const cold = await mkTask({ title: 'Pitch an Firma Huber' })
    const ok = await mkTask({ title: 'Einreichung beim Blog', description: 'Der Blog bittet um Einsendungen: https://blog.example/submit' })
    let calls = 0
    const llm = async () => {
      calls++
      return new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content: JSON.stringify({ kind: 'mail', subject: 'Hallo', body: 'Hallo Huber' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })
    }
    const r = await runDraftTask(db, ws, cold.id, llm as unknown as typeof fetch)
    expect(r.summary).toContain('Kaltmail verworfen')
    expect(calls).toBe(0)
    expect(await statusOf(cold.id)).toBe('verworfen')
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, cold.id))
    expect(notes.some(n => n.text.includes('§ 174 TKG') && n.text.includes('§ 7 UWG'))).toBe(true)

    const cold2 = await mkTask({ title: 'Pitch an Firma Maier' })
    await runDraftTasks(db, ws)
    expect(await statusOf(cold2.id)).toBe('verworfen')
    expect(await statusOf(ok.id)).toBe('geplant')

    const manual = await mkTask({ title: 'Pitch an Firma Berger', status: 'entwurf_fertig' })
    const [d] = await db.insert(schema.drafts).values({ taskId: manual.id, kind: 'mail', subject: 'Hallo', body: 'Hallo', recipient: 'info@berger.example' }).returning()
    await expect(sendDraft(db, ws, { draftId: d!.id, userId: null, mode: 'manual' })).rejects.toThrow(MailError)
    await expect(sendDraft(db, ws, { draftId: d!.id, userId: null, mode: 'manual' })).rejects.toThrow(/Klick eines Menschen/)
    const [u] = await db.insert(schema.users).values({ email: 'kalt@test.example', name: 'Kalt' }).returning()
    await expect(sendDraft(db, ws, { draftId: d!.id, userId: u!.id, mode: 'manual' })).rejects.toThrow(/Kaltmails/)
  })

  it('Wiederholungen für Kaltmails legen keine Aufgaben an', async () => {
    await db.insert(schema.recurrences).values({ workspaceId: ws.id, projectId: project.id, projectMode: 'fixed', rule: 'weekly:TU', title: 'Pitch-Mails', category: 'outreach', agentStep: 'Mail entwerfen', draftKind: 'mail', startDate: '2026-10-13' })
    expect(await materializeRecurrences(db, ws.id, '2026-10-13')).toBe(0)
  })
})

describe('Plan-Wächter: Fakten und Doppelte', () => {
  it('erkennt ausgeschlossene Plattformen', () => {
    expect(excludedPlatforms(['Kein X-Konto', 'kein LinkedIn', 'no TikTok please'])).toEqual(['x', 'linkedin', 'tiktok'])
    expect(excludedPlatforms(['Wir haben kein Konto auf Instagram'])).toEqual(['instagram'])
    expect(excludedPlatforms(['Kein Problem mit Bluesky', 'Keine Rabatte'])).toEqual([])
    expect(isExcluded({ excluded: ['x'] }, 'X-Konto anlegen')).toBe(true)
    expect(isExcluded({ excluded: ['x'] }, 'LinkedIn-Post')).toBe(false)
    expect(channelExcluded({ excluded: ['x'] }, { name: 'X', places: ['X'], category: 'social' })).toBe(true)
    expect(channelExcluded({ excluded: ['x'] }, { name: 'Social', places: ['X', 'LinkedIn'], category: 'social' })).toBe(false)
    expect(channelExcluded({ excluded: [] }, { name: 'Presse', places: [], category: 'outreach' })).toBe(true)
  })

  it('ähnliche Titel', () => {
    expect(similarTitle('Artikel: EU AI Act Kennzeichnung', 'Artikel: EU AI Act Kennzeichnungspflicht für Chatbots')).toBe(true)
    expect(similarTitle('Artikel: Chatbot DSGVO', 'Artikel: EU AI Act Kennzeichnung')).toBe(false)
    expect(similarTitle('Post', 'Post')).toBe(false)
    const known = [{ title: 'Artikel: EU AI Act Kennzeichnungspflicht für Chatbots', category: 'content', status: 'erledigt' }, { title: 'Song des Tages', category: 'social', status: 'erledigt' }]
    expect(duplicateOf({ title: 'Artikel: EU AI Act Kennzeichnung', category: 'content' }, known)).toBeTruthy()
    expect(duplicateOf({ title: 'Song des Tages', category: 'social' }, known)).toBeNull()
    expect(duplicateOf({ title: 'Song des Tages', category: 'social' }, [{ ...known[1]!, status: 'geplant' }])).toBeTruthy()
  })

  it('keine Konto-Aufgabe für ausgeschlossene Plattform, auch aus gemerkten Fakten', async () => {
    expect((await loadPlanGuard(db, project)).excluded).toEqual(['x'])
    expect(await ensureSetupTask(db, project, { kind: 'account', platform: 'x' }, null, null, '2026-10-13')).toBe(false)
    await db.insert(schema.projectMemory).values({ projectId: project.id, text: 'Peter will kein Instagram' })
    expect(await ensureSetupTask(db, project, { kind: 'account', platform: 'instagram' }, null, null, '2026-10-13')).toBe(false)
    expect(await ensureSetupTask(db, project, { kind: 'account', platform: 'bluesky' }, null, null, '2026-10-13')).toBe(true)
  })
})
