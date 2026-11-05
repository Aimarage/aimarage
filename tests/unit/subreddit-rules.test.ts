import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { workspaceLlm } from '../../server/lib/agent'
import { sealAppSecret, updateSettings } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { resetBraveState } from '../../server/lib/platforms/brave'
import { resetRedditState } from '../../server/lib/reddit'
import { resetSecretCache } from '../../server/lib/secret'
import { fixRedditDays, rawRules, rulesDigest, subredditRules, type RulesDeps } from '../../server/lib/subreddit-rules'
import { checkPrompt, draftPrompt } from '../../server/prompts/de'
import { dayNumber, freshRules, nextPromoDay, promoDayOk, rulesText, type SubRules } from '../../shared/utils/subreddit'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect
let project: typeof schema.projects.$inferSelect
let seq = 0

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } })
const fetchOf = (handler: (url: string, init: RequestInit) => Response) => {
  const calls: { url: string, headers: Record<string, string> }[] = []
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> })
    return handler(url, init)
  }
  return { fn, calls }
}

const SELFHOSTED = { rules: [{ short_name: 'No Low-Effort Posts', description: 'Be specific.' }, { short_name: 'Self-promotion only on Wednesdays', description: 'Posts about your own project are only allowed on Wednesday with the flair "Wednesday Exceptions". Otherwise rule 2 applies.' }] }

function llm(reply: Record<string, unknown>) {
  const prompts: string[] = []
  const fn = async (_url: string, init: RequestInit) => {
    prompts.push(JSON.parse(String(init.body)).messages[1].content)
    return json({ model: 'mock', choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
  }
  return { fn: fn as unknown as typeof fetch, prompts }
}

const WED = { promo: 'days', days: ['Wednesday'], flairRequired: true, flair: 'Wednesday Exceptions', links: 'yes', notes: ['Flair ist Pflicht'] }
const rules = (o: Partial<SubRules> = {}): SubRules => ({ sub: 'selfhosted', promo: 'days', days: [3], flairRequired: true, flair: 'Wednesday Exceptions', links: 'yes', notes: [], source: 'api', at: new Date().toISOString(), ...o })

async function mkTask(v: Partial<typeof schema.tasks.$inferInsert>) {
  const [t] = await db.insert(schema.tasks).values({ workspaceId: ws.id, projectId: project.id, code: `SR-${++seq}`, title: 'Beitrag: linkbox vorstellen', category: 'community', channel: 'Reddit r/selfhosted', status: 'geplant', dueDate: '2026-10-12', draftKind: 'post', agentStep: 'Entwurf', language: 'en', ...v }).returning()
  return t!
}

async function reloadWs() {
  ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id)))[0]!
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-12T08:15:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  ;({ db, close } = await openTestDb())
  ws = (await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'mock' } } }).returning())[0]!
  project = (await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'linkbox', name: 'linkbox', code: 'BMX', icon: 'B', url: 'https://linkbox.app' }).returning())[0]!
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})
beforeEach(() => {
  resetRedditState()
  resetBraveState()
})

describe('Subreddit-Regeln', () => {
  it('Wochentage und erlaubte Tage', () => {
    expect(dayNumber('Wednesday')).toBe(3)
    expect(dayNumber('wednesdays')).toBe(3)
    expect(dayNumber('Mittwoch')).toBe(3)
    expect(dayNumber('x')).toBeNull()
    const r = rules()
    expect(promoDayOk(r, '2026-10-12')).toBe(false)
    expect(promoDayOk(r, '2026-10-14')).toBe(true)
    expect(nextPromoDay(r, '2026-10-12')).toBe('2026-10-14')
    expect(nextPromoDay(r, '2026-10-15')).toBe('2026-10-21')
    expect(promoDayOk(rules({ promo: 'yes', days: [] }), '2026-10-12')).toBe(true)
    expect(freshRules(r)).toBe(true)
    expect(freshRules(rules({ at: '2026-01-01T00:00:00Z' }))).toBe(false)
    const text = rulesText(r)
    expect(text).toContain('nur am Mittwoch mit Flair "Wednesday Exceptions"')
    expect(text).toContain('Flair Pflicht')
    expect(rulesText(rules({ promo: 'no', days: [], flair: null, flairRequired: false, links: 'no' }))).toContain('Eigenwerbung verboten')
  })

  it('Regeltext aus Reddit-JSON', () => {
    const t = rulesDigest(SELFHOSTED, { data: { public_description: 'A place to share self-hosted software.', submit_text: 'Pick a flair.' } })
    expect(t).toContain('2. Self-promotion only on Wednesdays: Posts about your own project')
    expect(t).toContain('Hinweis beim Posten: Pick a flair.')
  })

  it('öffentliches JSON mit eigenem User-Agent, sonst Brave, sonst nichts', async () => {
    const pub = fetchOf(url => (url.includes('/about/rules.json') ? json(SELFHOSTED) : json({ data: { submit_text: 'Flair required' } })))
    const r1 = await rawRules(ws, 'selfhosted', pub.fn, [])
    expect(r1?.source).toBe('public')
    expect(pub.calls[0]!.url).toBe('https://www.reddit.com/r/selfhosted/about/rules.json?raw_json=1')
    expect(pub.calls[0]!.headers['User-Agent']).toMatch(/^aimarage\/1\.0/)
    const log: string[] = []
    const blocked = fetchOf(() => json({ message: 'Blocked' }, 403))
    expect(await rawRules(ws, 'selfhosted', blocked.fn, log)).toBeNull()
    expect(log[0]).toContain('HTTP 403')
    await updateSettings(db, ws.id, s => ({ ...s, apps: { ...s.apps, brave: { clientId: '', secret: sealAppSecret(ws.id, 'brave', 'brave-key-123') } } }))
    await reloadWs()
    const brave = fetchOf(url => (url.includes('api.search.brave.com') ? json({ web: { results: [{ title: 'r/selfhosted rules', url: 'https://www.reddit.com/r/selfhosted/wiki/rules', description: 'Self-promotion only on Wednesdays' }] } }) : json({}, 403)))
    const r2 = await rawRules(ws, 'selfhosted', brave.fn, [])
    expect(r2?.source).toBe('search')
    expect(r2?.text).toContain('Self-promotion only on Wednesdays')
  })

  it('über die Reddit-App, wenn eingerichtet', async () => {
    await updateSettings(db, ws.id, s => ({ ...s, apps: { ...s.apps, reddit: { clientId: 'rid', secret: sealAppSecret(ws.id, 'reddit', 'rsecret'), user: 'peter' } } }))
    await reloadWs()
    const api = fetchOf((url) => {
      if (url.includes('access_token')) return json({ access_token: 'tok', expires_in: 3600 })
      if (url.startsWith('https://oauth.reddit.com/r/selfhosted/about/rules')) return json(SELFHOSTED)
      if (url.startsWith('https://oauth.reddit.com/r/selfhosted/about')) return json({ data: { submit_text: 'Flair required' } })
      return json({}, 404)
    })
    const r = await rawRules(ws, 'selfhosted', api.fn, [])
    expect(r?.source).toBe('api')
    expect(r?.text).toContain('Flair required')
    await updateSettings(db, ws.id, s => ({ ...s, apps: {} }))
    await reloadWs()
  })

  it('KI wertet einmal aus, Ergebnis bleibt ein paar Tage im Arbeitsbereich', async () => {
    const m = llm(WED)
    const f = fetchOf(url => (url.includes('/about/rules.json') ? json(SELFHOSTED) : json({}, 404)))
    const deps: RulesDeps = { llm: workspaceLlm(ws), fetch: f.fn, llmFetch: m.fn, log: [] }
    const r = await subredditRules(db, ws, 'r/selfhosted', deps)
    expect(r).toMatchObject({ sub: 'selfhosted', promo: 'days', days: [3], flair: 'Wednesday Exceptions', flairRequired: true, source: 'public' })
    expect(m.prompts[0]).toMatch(/^Subreddit-Regeln auswerten: r\/selfhosted/)
    expect(m.prompts[0]).toContain('Self-promotion only on Wednesdays')
    await reloadWs()
    expect(ws.settings.subreddits?.selfhosted?.flair).toBe('Wednesday Exceptions')
    await subredditRules(db, ws, 'SelfHosted', deps)
    expect(m.prompts).toHaveLength(1)
  })

  it('ohne abrufbare Regeln: Allgemeinwissen des Modells, als ungeprüft markiert', async () => {
    const m = llm({ promo: 'no', days: [], flairRequired: false, flair: null, links: 'no', notes: [] })
    const r = await subredditRules(db, ws, 'privacy', { llm: workspaceLlm(ws), fetch: fetchOf(() => json({}, 403)).fn, llmFetch: m.fn, log: [] })
    expect(m.prompts[0]).toContain('nicht abrufbar')
    expect(r?.source).toBe('model')
    expect(rulesText(r!)).toContain('ungeprüft')
  })

  it('Reddit-Beitrag über das eigene Produkt wandert auf den erlaubten Tag, Antworten bleiben', async () => {
    await reloadWs()
    const post = await mkTask({})
    const reply = await mkTask({ title: 'Antwort: Bookmark-Manager gesucht' })
    const timed = await mkTask({ dueDate: '2026-10-15', dueTime: '18:00' })
    const banned = await mkTask({ channel: 'Reddit r/privacy' })
    const moved = await fixRedditDays(db, ws, '2026-10-12', { llm: workspaceLlm(ws), fetch: fetchOf(() => json({}, 403)).fn, log: [] })
    expect(moved).toBe(2)
    const byId = new Map((await db.select().from(schema.tasks).where(eq(schema.tasks.workspaceId, ws.id))).map(t => [t.id, t]))
    expect(byId.get(post.id)!.dueDate).toBe('2026-10-14')
    expect(byId.get(timed.id)!.dueDate).toBe('2026-10-21')
    expect(byId.get(timed.id)!.dueTime).toBe('18:00')
    expect(byId.get(reply.id)!.dueDate).toBe('2026-10-12')
    expect(byId.get(banned.id)!.dueDate).toBe('2026-10-12')
    const notes = (await db.select().from(schema.taskNotes)).map(n => n.text)
    expect(notes).toContain('Reddit-Regeln: r/selfhosted erlaubt Beiträge über eigene Projekte nur am Mittwoch (Flair "Wednesday Exceptions"). Termin von 2026-10-12 auf 2026-10-14 verschoben.')
    expect(notes.some(n => n.startsWith('Reddit-Regeln: r/privacy verbietet Eigenwerbung'))).toBe(true)
    expect(await fixRedditDays(db, ws, '2026-10-12', { llm: workspaceLlm(ws), fetch: fetchOf(() => json({}, 403)).fn, log: [] })).toBe(0)
    expect((await db.select().from(schema.taskNotes)).length).toBe(notes.length)
  })

  it('Regeln stehen im Entwurfs-Prompt und in der Nachprüfung, Grundwissen bei Reddit', () => {
    const sub = rulesText(rules())
    const p = draftPrompt({ project: null, task: { code: 'X', title: 'Beitrag', description: null, category: 'community', channel: 'r/selfhosted', language: 'en', agentStep: null, humanStep: null, draftKind: 'post', targetUrl: null, metric: null }, memory: [], notes: [], previous: null, utmUrl: null, type: 'post', platform: 'reddit', subreddit: sub })
    expect(p).toContain('Wednesday Exceptions')
    expect(p).toContain('Faustregel 9:1')
    const c = checkPrompt({ type: 'post', platform: 'reddit', rules: null, facts: { known: [], avoid: [] }, data: '-', subject: 'T', body: 'B', subreddit: sub })
    expect(c).toContain('Subreddit-Regeln')
    expect(c).toContain('nur am Mittwoch')
  })
})
