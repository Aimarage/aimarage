import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sealAppSecret, updateSettings } from '../../server/lib/connections'
import { openTestDb, schema, type Db } from '../../server/lib/db'
import { cleanQuestions, evaluateAnswer, geoDigest, latestGeo, MAX_CALLS, modelLabel, planCalls, resetGeoCache, runGeoCheck, webRank, type GeoModel } from '../../server/lib/geo'
import { resetBraveState } from '../../server/lib/platforms/brave'
import { resetSecretCache } from '../../server/lib/secret'

let db: Db
let close: () => Promise<void>
let ws: typeof schema.workspaces.$inferSelect

const project = { name: 'chatsite', slug: 'chatsite', url: 'https://chatsite.site' }
const M = (id: string): GeoModel => ({ id, label: modelLabel(id), price: null })

interface Call { url: string, body: Record<string, unknown> | null }

function mockLlm(answer: (model: string, question: string) => string) {
  const calls: Call[] = []
  const fn = async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    calls.push({ url, body })
    if (url.endsWith('/models')) {
      return Response.json({ data: [
        { id: 'qwen-mock', pricing: { prompt: '0.0000001', completion: '0.000001' } },
        { id: 'openai/gpt-6-sol', pricing: { prompt: '0.000002', completion: '0.00001' } },
        { id: 'anthropic/claude-sonnet-5-5', pricing: { prompt: '0.000002', completion: '0.00001' } },
        { id: 'openai/gpt-oss-120b' },
      ] })
    }
    if (url.endsWith('/chat/completions')) {
      const messages = body!.messages as { role: string, content: string }[]
      const last = messages.at(-1)!.content
      if (/Käuferfragen|typische Fragen/.test(last)) return Response.json({ choices: [{ message: { content: JSON.stringify({ questions: ['Welcher EU-Chatbot für meine Website?', 'Gibt es chatsite Alternativen?', 'Chatbase Alternative mit Hosting in der EU?', 'Welcher Website-Chatbot ist DSGVO-konform?'] }) } }], usage: { prompt_tokens: 200, completion_tokens: 80 } })
      return Response.json({ choices: [{ message: { content: answer(String(body!.model), last.split('\n')[0]!) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } })
    }
    if (url.startsWith('https://api.search.brave.com/')) {
      const q = new URL(url).searchParams.get('q') ?? ''
      const results = /DSGVO/.test(q) ? [{ url: 'https://example.org/a' }, { url: 'https://www.chatsite.site/de' }] : [{ url: 'https://chatbase.co/' }]
      return Response.json({ web: { results: results.map(r => ({ ...r, title: 't', description: 'd' })) } })
    }
    return new Response('not found', { status: 404 })
  }
  return { fn, calls }
}

beforeAll(async () => {
  process.env.MA_NOW = '2026-10-12T05:00:00+02:00'
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
  resetGeoCache()
  resetBraveState()
  ;({ db, close } = await openTestDb())
  const [w] = await db.insert(schema.workspaces).values({ name: 'Test', settings: { llm: { provider: 'ollama', model: 'qwen-mock' } } }).returning()
  await updateSettings(db, w!.id, s => ({ ...s, apps: { brave: { clientId: '', secret: sealAppSecret(w!.id, 'brave', 'brave-key-123') } } }))
  ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, w!.id)))[0]!
  await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'chatsite', name: 'chatsite', code: 'AMW', icon: 'A', url: 'https://chatsite.site', languages: ['de', 'en'], setup: { analysis: { audiences: ['KMU mit Website'], competitors: [{ name: 'Chatbase' }] }, facts: { known: ['Hosting in der EU'] } } })
  await db.insert(schema.projects).values({ workspaceId: ws.id, slug: 'linkbox', name: 'Linkbox', code: 'BMX', icon: 'B', url: 'https://www.linkbox.net', languages: ['en'], setup: { geo: { questions: ['Best EU bookmark manager?', 'Raindrop alternative hosted in Europe?'] } } })
})
afterAll(async () => {
  delete process.env.MA_NOW
  delete process.env.APP_SECRET
  resetSecretCache()
  await close()
})

describe('KI-Sichtbarkeit: Bausteine', () => {
  it('Aufrufe planen: Standardmodell für alle Fragen, Rest reihum, Budget hält', () => {
    const qs = ['a', 'b', 'c', 'd']
    const models = [M('qwen'), M('openai/gpt-6-sol'), M('anthropic/claude-sonnet-5-5')]
    const five = planCalls(qs, models, 5, 0)
    expect(five).toHaveLength(5)
    expect(five.slice(0, 4).every(c => c.model.id === 'qwen')).toBe(true)
    expect(five[4]!.model.id).toBe('openai/gpt-6-sol')
    expect(planCalls(qs, models, 20, 0)).toHaveLength(12)
    expect(planCalls(qs, models, 5, 1)[4]!.question).toBe('b')
    expect(planCalls(qs, models, 0, 0)).toEqual([])
  })

  it('Antwort auswerten: Name, Domain, Position, Konkurrenten', () => {
    const json = JSON.stringify({ recommendations: [{ name: 'Chatbase', url: 'https://chatbase.co' }, { name: 'ChatSite', url: null }, { name: 'Tidio' }] })
    expect(evaluateAnswer(json, project)).toEqual({ mentioned: true, position: 2, competitors: ['Chatbase', 'Tidio'] })
    expect(evaluateAnswer(JSON.stringify({ recommendations: [{ name: 'Some Bot', url: 'https://www.chatsite.site/de' }] }), project).position).toBe(1)
    expect(evaluateAnswer('```json\n{"recommendations": [{"name": "Chatbase"}]}\n```', project)).toEqual({ mentioned: false, position: null, competitors: ['Chatbase'] })
    expect(evaluateAnswer('Ich empfehle chatsite.site oder Tidio.', project)).toMatchObject({ mentioned: true, position: null })
    expect(evaluateAnswer(JSON.stringify({ recommendations: [{ name: 'Linkwarden (self-hostable, with a managed plan)' }, { name: 'Userlike - DSGVO' }] }), project).competitors).toEqual(['Linkwarden', 'Userlike'])
  })

  it('Web-Rang, Modellnamen, Fragen säubern', () => {
    expect(webRank(['https://a.example', 'https://blog.chatsite.site/x'], 'https://chatsite.site')).toBe(2)
    expect(webRank(['https://a.example'], 'https://chatsite.site')).toBeNull()
    expect(modelLabel('anthropic/claude-sonnet-5-5')).toBe('Claude sonnet 5.5')
    expect(modelLabel('openai/gpt-6-sol')).toBe('GPT-6-sol')
    expect(cleanQuestions(['Welcher EU-Chatbot – für mich?', 'welcher eu-chatbot - für mich?', 'kurz', 'Gibt es ChatSite Alternativen?'], ['chatsite'])).toEqual(['Welcher EU-Chatbot - für mich?'])
  })
})

describe('KI-Sichtbarkeit: wöchentlicher Lauf', () => {
  it('erzeugt Fragen, fragt Modelle und Web-Suche, speichert Ergebnis und Kosten', async () => {
    const llm = mockLlm((model, q) => JSON.stringify({ recommendations: model === 'qwen-mock' && /EU-Chatbot/.test(q) ? [{ name: 'Chatbase' }, { name: 'chatsite' }] : [{ name: 'Chatbase' }, { name: 'Raindrop.io' }] }))
    const r = await runGeoCheck(db, ws, null, { llmFetch: llm.fn, webFetch: llm.fn, sleep: async () => {} })
    expect(r.status).toBe('ok')
    const chats = llm.calls.filter(c => c.url.endsWith('/chat/completions'))
    const asks = chats.filter(c => !/Käuferfragen|typische Fragen/.test(JSON.stringify(c.body)))
    expect(asks.length).toBeLessThanOrEqual(MAX_CALLS)
    expect(asks.length).toBe(15)
    expect(new Set(asks.map(c => c.body!.model))).toEqual(new Set(['qwen-mock', 'openai/gpt-6-sol', 'anthropic/claude-sonnet-5-5']))
    expect(asks.every(c => !('chat_template_kwargs' in c.body!) || /qwen/i.test(String(c.body!.model)))).toBe(true)

    const [amw] = await db.select().from(schema.projects).where(eq(schema.projects.slug, 'chatsite'))
    expect(amw!.setup.geo!.questions).toEqual(['Welcher EU-Chatbot für meine Website?', 'Chatbase Alternative mit Hosting in der EU?', 'Welcher Website-Chatbot ist DSGVO-konform?'])
    const last = (await latestGeo(db, amw!.id))!
    expect(last.week).toBe('2026-10-12')
    expect(last.summary).toMatchObject({ asked: 9, mentioned: 1, webAsked: 3, webHits: 1 })
    expect(last.summary.competitors[0]).toBe('Chatbase')
    expect(last.answers.find(a => a.mentioned)).toMatchObject({ model: 'qwen-mock', position: 2 })
    expect(last.web.find(w => w.rank)).toMatchObject({ question: 'Welcher Website-Chatbot ist DSGVO-konform?', rank: 2 })
    expect(last.costEur).toBeGreaterThan(0)

    const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.job, 'geo_check')).orderBy(desc(schema.agentRuns.startedAt)).limit(1)
    expect(run!.costEur).toBeGreaterThan(0)
    expect(run!.log).toContain('Kosten KI-Sichtbarkeit')

    const digest = (await geoDigest(db, amw!.id))!
    expect(digest).toContain('in 1 von 9 KI-Antworten genannt')
    expect(digest).toContain('Chatbase')
    expect(digest).toContain('Top 10')
  })

  it('Demo-Arbeitsbereich und fehlendes LLM werden übersprungen', async () => {
    const [demo] = await db.insert(schema.workspaces).values({ name: 'Demo', demo: true, settings: { llm: { provider: 'ollama', model: 'qwen-mock' } } }).returning()
    expect((await runGeoCheck(db, demo!, null)).status).toBe('skipped')
  })
})
