import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { upsertConnection } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { publishPost, schedulePost } from '../../server/lib/publish'
import { resetSecretCache } from '../../server/lib/secret'
import { telegramAdapter, telegramChat, telegramPostUrl, verifyTelegram } from '../../server/lib/platforms/telegram'
import type { SocialConn } from '../../server/lib/platforms/types'
import { postIssues } from '../../shared/utils/social'

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
type Call = { url: string, body: unknown }

function mockFetch(handler: (method: string, body: unknown) => Response) {
  const calls: Call[] = []
  const fn = async (url: string, init: RequestInit) => {
    const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, body })
    return handler(url.split('/').pop()!, body)
  }
  return { fn, calls }
}

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } })
const fail = (status: number, description: string) => new Response(JSON.stringify({ ok: false, error_code: status, description }), { status, headers: { 'content-type': 'application/json' } })

function api(member: Record<string, unknown>) {
  return mockFetch((method) => {
    if (method === 'getMe') return ok({ id: 42, is_bot: true, username: 'tonebase_aimarage_bot' })
    if (method === 'getChat') return ok({ id: -1001234567890, type: 'channel', title: 'tonebase News', username: 'tonebasenews' })
    if (method === 'getChatMember') return ok(member)
    return fail(404, 'Not Found')
  })
}

const conn: SocialConn = { id: 'c1', provider: 'telegram', platform: 'telegram', name: 'tonebase News (@tonebasenews)', handle: 'tonebasenews', url: 'https://t.me/tonebasenews', ext: { chatId: '-1001234567890' }, secret: { enc: '', hint: '', setAt: '' } }
const ctx = (fn: ReturnType<typeof mockFetch>['fn']) => ({ fetch: fn, sleep: async () => {}, saveCreds: async () => {} })

describe('Telegram', () => {
  it('Kanal-Angaben und Links', () => {
    expect(telegramChat('@tonebasenews')).toBe('@tonebasenews')
    expect(telegramChat('https://t.me/tonebasenews')).toBe('@tonebasenews')
    expect(telegramChat('-1001234567890')).toBe('-1001234567890')
    expect(() => telegramChat('a b')).toThrow(/Kanal/)
    expect(telegramPostUrl({ handle: null, ext: { chatId: '-1001234567890' } }, 7)).toBe('https://t.me/c/1234567890/7')
  })

  it('Prüfen ok: Bot ist Admin mit Posting-Recht', async () => {
    const m = api({ status: 'administrator', can_post_messages: true, user: { id: 42 } })
    const v = await verifyTelegram({ token: TOKEN, chat: 't.me/tonebasenews' }, m.fn)
    expect(v.creds).toEqual({ token: TOKEN })
    expect(v.conn).toMatchObject({ provider: 'telegram', platform: 'telegram', handle: 'tonebasenews', url: 'https://t.me/tonebasenews', ext: { chatId: '-1001234567890' } })
    expect(m.calls.map(c => c.url.split('/').pop())).toEqual(['getMe', 'getChat', 'getChatMember'])
    expect(m.calls[2]!.body).toEqual({ chat_id: -1001234567890, user_id: 42 })
  })

  it('Prüfen: Bot nicht Admin wird abgelehnt, Token nie in der Meldung', async () => {
    await expect(verifyTelegram({ token: TOKEN, chat: '@tonebasenews' }, api({ status: 'member' }).fn)).rejects.toThrow(/kein Admin/)
    await expect(verifyTelegram({ token: TOKEN, chat: '@tonebasenews' }, api({ status: 'administrator', can_post_messages: false }).fn)).rejects.toThrow(/kein Admin/)
    const bad = mockFetch(() => fail(401, `Unauthorized ${TOKEN}`))
    const err = await verifyTelegram({ token: TOKEN, chat: '@tonebasenews' }, bad.fn).catch(e => e as Error)
    expect(err.message).toMatch(/Bot-Token abgelehnt/)
    expect(err.message).not.toContain(TOKEN)
  })

  it('Text posten mit HTML und Link-Vorschau', async () => {
    const m = mockFetch(() => ok({ message_id: 15, chat: { id: -1001234567890, username: 'tonebasenews' } }))
    const r = await telegramAdapter.post(conn, { token: TOKEN }, { text: 'Neu <3 & lossless https://tonebase.com/?utm_source=telegram', media: [], link: null }, ctx(m.fn))
    expect(r).toMatchObject({ ok: true, postId: '15', url: 'https://t.me/tonebasenews/15' })
    expect(m.calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    expect(m.calls[0]!.body).toEqual({ chat_id: '-1001234567890', text: 'Neu &lt;3 &amp; lossless https://tonebase.com/?utm_source=telegram', parse_mode: 'HTML', link_preview_options: { url: 'https://tonebase.com/?utm_source=telegram', prefer_large_media: true } })
  })

  it('Bild posten als Datei-Upload mit Bildunterschrift', async () => {
    const m = mockFetch(() => ok({ message_id: 16, chat: { id: -1001234567890, username: 'tonebasenews' } }))
    const r = await telegramAdapter.post(conn, { token: TOKEN }, { text: 'Cover', media: [{ name: 'cover.png', mime: 'image/png', data: new Uint8Array([1, 2, 3]) }], link: null }, ctx(m.fn))
    expect(r.url).toBe('https://t.me/tonebasenews/16')
    expect(m.calls[0]!.url.endsWith('/sendPhoto')).toBe(true)
    const fd = m.calls[0]!.body as FormData
    expect(fd.get('chat_id')).toBe('-1001234567890')
    expect(fd.get('caption')).toBe('Cover')
    expect((fd.get('photo') as File).size).toBe(3)
  })

  it('Länge zu groß: Regeln und Adapter', async () => {
    expect(postIssues('telegram', 'x'.repeat(4096), [])).toEqual([])
    expect(postIssues('telegram', 'x'.repeat(4097), [])).toEqual(['too_long'])
    expect(postIssues('telegram', 'x'.repeat(1025), [{ mime: 'image/jpeg' }])).toEqual(['too_long'])
    const m = mockFetch(() => ok({ message_id: 1 }))
    await expect(telegramAdapter.post(conn, { token: TOKEN }, { text: 'x'.repeat(4097), media: [], link: null }, ctx(m.fn))).rejects.toThrow(/4096/)
    await expect(telegramAdapter.post(conn, { token: TOKEN }, { text: 'x'.repeat(1025), media: [{ name: 'a.jpg', mime: 'image/jpeg', data: new Uint8Array([1]) }], link: null }, ctx(m.fn))).rejects.toThrow(/1024/)
    expect(m.calls).toHaveLength(0)
  })

  it('Abonnenten zählen', async () => {
    const m = mockFetch(method => (method === 'getChatMemberCount' ? ok(321) : fail(404, 'x')))
    expect(await telegramAdapter.followers!(conn, { token: TOKEN }, ctx(m.fn))).toBe(321)
  })
})

describe('Telegram über publishPost', () => {
  let db: Db
  let close: () => Promise<void>
  let ws: typeof schema.workspaces.$inferSelect
  let project: typeof schema.projects.$inferSelect

  beforeAll(async () => {
    process.env.MA_NOW = '2026-10-13T08:15:00+02:00'
    process.env.APP_SECRET = 'test-secret'
    resetSecretCache()
    ;({ db, close } = await openTestDb())
    const [w] = await db.insert(schema.workspaces).values({ name: 'Test' }).returning()
    const [p] = await db.insert(schema.projects).values({ workspaceId: w!.id, slug: 'tonebase', name: 'tonebase', code: 'BIT', icon: 'music', url: 'https://tonebase.com' }).returning()
    project = p!
    await upsertConnection(db, w!.id, { provider: 'telegram', platform: 'telegram', name: conn.name, handle: 'tonebasenews', url: conn.url, ext: { chatId: '-1001234567890' } }, { token: TOKEN }, { projectId: project.id })
    ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, w!.id)))[0]!
    project = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!
  })
  afterAll(async () => {
    delete process.env.MA_NOW
    delete process.env.APP_SECRET
    resetSecretCache()
    await close()
  })

  async function post(code: string) {
    const [task] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code, title: 'Telegram-Post', channel: 'telegram', category: 'social', status: 'freigegeben', draftKind: 'post', dueDate: '2026-10-13', dueTime: '11:00', agentStep: 'Beitrag entwerfen' }).returning()
    const [draft] = await db.insert(schema.drafts).values({ taskId: task!.id, version: 1, kind: 'post', body: 'Neues Album https://tonebase.com', status: 'freigegeben', approvedAt: new Date() }).returning()
    return { task: task!, row: await schedulePost(db, ws, { task: task!, draft: draft!, project, mode: 'manual', at: new Date('2026-10-13T06:00:00Z') }) }
  }

  it('Hauptschalter aus: nichts gesendet', async () => {
    const { row } = await post('T-1')
    const m = mockFetch(() => ok({ message_id: 1 }))
    expect((await publishPost(db, ws, row.id, m.fn)).summary).toMatch(/Trockenlauf/)
    expect(m.calls).toHaveLength(0)
  })

  it('Hauptschalter an: Link mit UTM, Nachricht als task_link', async () => {
    await db.update(schema.workspaces).set({ settings: { ...ws.settings, publishLive: true } }).where(eq(schema.workspaces.id, ws.id))
    ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
    const { task, row } = await post('T-2')
    const m = mockFetch(() => ok({ message_id: 99, chat: { id: -1001234567890, username: 'tonebasenews' } }))
    expect((await publishPost(db, ws, row.id, m.fn)).status).toBe('ok')
    expect((m.calls[0]!.body as { text: string }).text).toBe('Neues Album https://tonebase.com/?utm_source=telegram&amp;utm_medium=social&amp;utm_campaign=t-2')
    const links = await db.select().from(schema.taskLinks).where(eq(schema.taskLinks.taskId, task.id))
    expect(links.map(l => [l.platform, l.url])).toEqual([['telegram', 'https://t.me/tonebasenews/99']])
  })
})
