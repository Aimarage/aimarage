import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { hashSecret } from '../../server/lib/api/tokens'
import { resetSecretCache } from '../../server/lib/secret'
import { buildBriefing } from '../../server/lib/agent'
import { clientDrafts, clientFeedbackList, clientReportPage, clientRespond, createClientLink, latestFeedback, listClientLinks, resolveClientLink, revokeClientLink } from '../../server/services/client'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let peterId: string
const P: Record<string, typeof schema.projects.$inferSelect> = {}
let seq = 0
const BASE = 'http://localhost:3210'

async function makeDraft(projectKey: string, o: { kind?: 'post' | 'mail' | 'article', title?: string } = {}) {
  seq++
  const p = P[projectKey]!
  const kind = o.kind ?? 'post'
  const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: p.id, code: `${p.code}-SOC-${String(seq).padStart(3, '0')}`, title: o.title ?? `Post ${seq}`, category: 'social', dueDate: '2026-10-14', dueTime: '11:00', draftKind: kind, status: 'entwurf_fertig', channel: 'Social Media' }).returning()
  const [d] = await db.insert(schema.drafts).values({ taskId: t!.id, kind, body: `Text ${seq} https://example.org/a`, byAgent: true, recipient: kind === 'mail' ? 'kunde@example.org' : null, platforms: ['bluesky', 'mastodon'], variants: { bluesky: `Bluesky ${seq}` }, media: [{ id: 'm1', name: 'bild.jpg', mime: 'image/jpeg', size: 10, file: 'x/bild.jpg' }] }).returning()
  await db.insert(schema.taskNotes).values({ taskId: t!.id, byAgent: true, text: 'Interne Notiz: Regel 3 beachten' })
  return { task: t!, draft: d! }
}

async function reloadProject(key: string) {
  P[key] = (await db.select().from(schema.projects).where(eq(schema.projects.id, P[key]!.id)))[0]!
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Agentur', settings: { agentEnabled: false } }).returning())[0]!
  const [peter] = await db.insert(schema.users).values({ email: 'peter@test.local', name: 'Peter' }).returning()
  peterId = peter!.id
  await db.insert(schema.memberships).values({ workspaceId: ws.id, userId: peterId, role: 'owner' })
  for (const [slug, code] of [['thewanderer', 'TV'], ['linkbox', 'BMX']] as const) {
    P[slug] = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug, name: slug, code, icon: 'T', url: `https://${slug}.example`, rules: 'Geheime Regel: nie X erwähnen', languages: ['en'] }).returning())[0]!
  }
})

afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('Kunden-Link', () => {
  it('Token nur gehasht gespeichert, gültig auflösbar', async () => {
    const { id, token } = await createClientLink(db, { workspaceId: ws.id, projectId: P.thewanderer!.id, userId: peterId, label: 'Kunde Visitors' })
    expect(token).toMatch(/^akl_[\w-]{40,}$/)
    const [row] = await db.select().from(schema.clientLinks).where(eq(schema.clientLinks.id, id))
    expect(row!.tokenHash).toBe(hashSecret(token))
    expect(JSON.stringify(row)).not.toContain(token)
    const c = await resolveClientLink(db, token)
    expect(c?.project.id).toBe(P.thewanderer!.id)
    expect(await resolveClientLink(db, `${token.slice(0, -2)}xx`)).toBeNull()
    expect(await resolveClientLink(db, 'akl_kurz')).toBeNull()
  })

  it('widerrufen und abgelaufen gilt nicht mehr', async () => {
    const a = await createClientLink(db, { workspaceId: ws.id, projectId: P.thewanderer!.id, userId: peterId, label: 'Weg' })
    expect(await revokeClientLink(db, P.linkbox!.id, a.id)).toBe(false)
    expect(await revokeClientLink(db, P.thewanderer!.id, a.id)).toBe(true)
    expect(await resolveClientLink(db, a.token)).toBeNull()
    const b = await createClientLink(db, { workspaceId: ws.id, projectId: P.thewanderer!.id, userId: peterId, label: 'Kurz', days: 1 })
    expect(await resolveClientLink(db, b.token)).not.toBeNull()
    process.env.MA_NOW = '2026-10-14T09:00:00+02:00'
    expect(await resolveClientLink(db, b.token)).toBeNull()
    expect((await listClientLinks(db, P.thewanderer!.id)).find(l => l.id === b.id)?.expired).toBe(true)
    process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
    expect((await listClientLinks(db, P.thewanderer!.id)).map(l => l.label)).not.toContain('Weg')
  })

  it('Kunde sieht nur offene Entwürfe seines Projekts, ohne Notizen, Regeln und Mails', async () => {
    const own = await makeDraft('thewanderer', { title: 'Album-Post' })
    await makeDraft('thewanderer', { kind: 'mail', title: 'Mail an Partner' })
    await makeDraft('linkbox', { title: 'Linkbox-Post' })
    const { token } = await createClientLink(db, { workspaceId: ws.id, projectId: P.thewanderer!.id, userId: peterId })
    const c = (await resolveClientLink(db, token))!
    const list = await clientDrafts(db, c, BASE)
    expect(list.map(d => d.title)).toEqual(['Album-Post'])
    const d = list[0]!
    expect(d).toMatchObject({ id: own.draft.id, dueDate: '2026-10-14', dueTime: '11:00', platforms: [{ platform: 'bluesky', text: `Bluesky ${seq - 2}` }] })
    expect(d.media[0]!.url).toMatch(/^http:\/\/localhost:3210\/m\/.+\.jpg$/)
    const json = JSON.stringify(list)
    expect(json).not.toMatch(/Interne Notiz|Geheime Regel|kunde@example|cost/i)
    const other = (await db.select().from(schema.drafts).innerJoin(schema.tasks, eq(schema.tasks.id, schema.drafts.taskId)).where(eq(schema.tasks.projectId, P.linkbox!.id)))[0]!
    await expect(clientRespond(db, c, { draftId: other.drafts.id, verdict: 'ok' })).rejects.toThrow('nicht gefunden')
  })

  it('"Passt" markiert nur, ohne Option bleibt der Entwurf offen', async () => {
    const { draft, task } = await makeDraft('thewanderer')
    const { token } = await createClientLink(db, { workspaceId: ws.id, projectId: P.thewanderer!.id, userId: peterId, label: 'Anna' })
    const r = await clientRespond(db, (await resolveClientLink(db, token))!, { draftId: draft.id, verdict: 'ok' })
    expect(r.approved).toBe(false)
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id))
    expect(d!.status).toBe('offen')
    expect((await latestFeedback(db, [draft.id])).get(draft.id)?.verdict).toBe('ok')
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))
    expect(notes.map(n => n.text)).toContain('Kunde (Anna): passt (Entwurf v1)')
  })

  it('"Passt" gibt frei, wenn "Kunden-OK gilt als Freigabe" an ist', async () => {
    await db.update(schema.projects).set({ setup: { ...P.thewanderer!.setup, client: { okApproves: true } } }).where(eq(schema.projects.id, P.thewanderer!.id))
    const { draft, task } = await makeDraft('thewanderer')
    const { token } = await createClientLink(db, { workspaceId: ws.id, projectId: P.thewanderer!.id, userId: peterId, label: 'Anna' })
    const r = await clientRespond(db, (await resolveClientLink(db, token))!, { draftId: draft.id, verdict: 'ok' })
    expect(r.approved).toBe(true)
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id))
    expect(d).toMatchObject({ status: 'freigegeben', approvedVia: 'kunde', approvedByUserId: peterId })
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
    expect(t!.status).toBe('freigegeben')
    await expect(clientRespond(db, (await resolveClientLink(db, token))!, { draftId: draft.id, verdict: 'ok' })).rejects.toThrow('nicht mehr offen')
    await db.update(schema.projects).set({ setup: { ...P.thewanderer!.setup, client: { okApproves: false } } }).where(eq(schema.projects.id, P.thewanderer!.id))
    await reloadProject('thewanderer')
  })

  it('Änderungswunsch braucht Kommentar und wird Notiz, Feed und Briefing', async () => {
    const { draft, task } = await makeDraft('thewanderer', { title: 'Tour-Post' })
    const { token } = await createClientLink(db, { workspaceId: ws.id, projectId: P.thewanderer!.id, userId: peterId, label: 'Anna' })
    const c = (await resolveClientLink(db, token))!
    await expect(clientRespond(db, c, { draftId: draft.id, verdict: 'change', comment: '  ' })).rejects.toThrow('beschreiben')
    await clientRespond(db, c, { draftId: draft.id, verdict: 'change', comment: 'Bitte das Datum \u2014 12. Oktober \u2014 ergänzen' })
    const [d] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id))
    expect(d!.status).toBe('offen')
    const notes = await db.select().from(schema.taskNotes).where(eq(schema.taskNotes.taskId, task.id))
    expect(notes.map(n => n.text)).toContain('Kunde (Anna) wünscht Änderung an Entwurf v1: Bitte das Datum - 12. Oktober - ergänzen')
    const acts = await db.select().from(schema.activity).where(eq(schema.activity.taskId, task.id))
    expect(acts.map(a => a.action)).toContain('client_change')
    const list = await clientFeedbackList(db, P.thewanderer!.id)
    expect(list.find(f => f.title === 'Tour-Post')).toMatchObject({ verdict: 'change', client: 'Anna', approved: false })
    const b = await buildBriefing(db, ws)
    expect(b.clientFeedback?.join(' ')).toContain('Änderung gewünscht: Tour-Post (Bitte das Datum')
  })
})

describe('Wochenbericht per Kunden-Link', () => {
  it('per Kunden-Link nur mit Freigabe für Berichte (200 sonst 404)', async () => {
    const off = await createClientLink(db, { workspaceId: ws.id, projectId: P.thewanderer!.id, userId: peterId })
    expect((await clientReportPage(db, off.token)).status).toBe(404)
    const on = await createClientLink(db, { workspaceId: ws.id, projectId: P.thewanderer!.id, userId: peterId, canReport: true })
    const page = await clientReportPage(db, on.token)
    expect(page.status).toBe(200)
    expect(page.html).toContain('Weekly report: thewanderer')
    await revokeClientLink(db, P.thewanderer!.id, on.id)
    expect((await clientReportPage(db, on.token)).status).toBe(404)
  })
})
