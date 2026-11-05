import { describe, expect, it } from 'vitest'
import { checkVariants, convoPrompt, nicheTerms, relevancePrompt, relevantHits } from '../../server/lib/conversation'
import { aiReview, reviewerPrompt, tonePrompt, toneReview, WRONG_LANG, type ReviewInput } from '../../server/lib/ai-reviewer'
import { broadTerm, cleanTerms, replyPrompt, type ListenHit } from '../../server/lib/listening'
import { llmConfig } from '../../server/lib/llm'
import { langRule, postLang, wrongLang } from '../../shared/utils/convo-tone'

const DGX = 'DGX Spark 128GB: launched at $3,999, now $6,950, with a new 64GB model at $4,999. Fine print: by the article\'s own math, $6,950 is almost three years of the $200/mo subscription it competes with. My 7B does four a second, no asterisks. #localAI #selfhosted'
const BOOKMARKS = 'I have 4000 saved links in my browser and can never find anything again. How do you all organise your bookmarks?'

function hit(over: Partial<ListenHit> = {}): ListenHit {
  return { platform: 'mastodon', kind: 'conversation', key: 'k1', url: 'https://mastodon.social/@a/1', author: 'a@mastodon.social', authorId: 'a', name: 'A', text: BOOKMARKS, at: '2026-11-01T08:00:00Z', root: 'k1', lang: 'en', bot: false, stats: null, ...over }
}

const project = { name: 'linkbox', description: 'Online-Lesezeichenmanager mit MCP-Server', tonality: null, languages: ['de', 'en'], rules: null, url: 'https://linkbox.example', setup: { analysis: { keywords: ['bookmark manager', 'MCP', 'LLM', 'Lesezeichen'] } } } as never

const reply = (v: Record<string, unknown>) => (async () => new Response(JSON.stringify({ model: 'mock', choices: [{ message: { content: JSON.stringify(v) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 })) as unknown as typeof fetch

describe('Mitreden: Sprache des Beitrags', () => {
  it('erkennt die Sprache aus Metadaten, bei klarem Widerspruch aus dem Text', () => {
    expect(postLang(DGX, 'en')).toBe('en')
    expect(postLang(BOOKMARKS, 'de')).toBe('en')
    expect(postLang('Ich habe so viele Lesezeichen und finde nie wieder etwas, das ich gespeichert habe', null)).toBe('de')
    expect(postLang('Bonjour à tous', 'fr')).toBe('fr')
    expect(postLang('ok cool', null)).toBeNull()
  })

  it('gibt die Sprache beim Schreiben vor und verwirft Fassungen in falscher Sprache', () => {
    const p = convoPrompt({ ...(project as object), rules: null } as never, hit(), { angle: '', examples: [], target: 100, max: 200, facts: [], pages: '', tone: null })
    expect(p).toContain(langRule('en'))
    expect(p).toContain('Sprache Englisch')
    const de = 'Ich kenne das gut, bei mir sind es auch tausende Links und ich finde nie wieder etwas.'
    expect(wrongLang(de, 'en')).toMatch(/falsche Sprache/)
    const r = checkVariants([de, 'same here, I gave up on browser folders years ago and just search everything now'], hit(), { projectName: 'linkbox', others: [], max: 200 })
    expect(r.ok).toHaveLength(1)
    expect(r.ok[0]).toContain('same here')
    expect(r.bad[0]!.problems.join()).toContain('falsche Sprache')
    expect(replyPrompt(project, { ...hit(), kind: 'search' }, { link: null, facts: [], memory: [] })).toContain(langRule('en'))
  })

  it('Ton-Prüfung: andere Sprache ist nie ok', async () => {
    expect(tonePrompt({ platform: 'Mastodon', kind: 'conversation', author: 'a', post: BOOKMARKS, examples: [], variants: ['x'], rules: null, lang: 'en' })).toContain('"sameLang"')
    const cfg = llmConfig({ provider: 'ollama', model: 'mock' })
    const de = 'Ich kenne das gut, bei mir sind es auch tausende Links und ich finde nie wieder etwas.'
    const all = { items: [0, 1].map(i => ({ i, ai: false, lecture: false, real: true, sameLang: true, ok: true, why: '' })), best: 0 }
    const v = await toneReview(cfg, { platform: 'Mastodon', kind: 'conversation', author: 'a', post: BOOKMARKS, examples: [], variants: [de, 'same here, thousands of links and I never find anything'], rules: null, lang: 'en' }, [], [], reply(all))
    expect(v.ok).toEqual([1])
    const said = await toneReview(cfg, { platform: 'Mastodon', kind: 'conversation', author: 'a', post: BOOKMARKS, examples: [], variants: ['oh ja'], rules: null, lang: 'en' }, [], [], reply({ items: [{ i: 0, ai: false, lecture: false, real: true, sameLang: false, ok: true, why: 'Deutsch' }] }))
    expect(said.ok).toEqual([])
  })

  it('KI-Prüfer: falsche Sprache verwirft den Entwurf statt nur zu warnen', async () => {
    const input: ReviewInput = {
      task: { title: 'Mastodon: Kommentar unter Beitrag von @little4744@mastodon.social', description: null, category: 'community', channel: 'Mastodon', language: 'en' },
      type: 'reply',
      platform: 'mastodon',
      kind: 'post',
      draft: { subject: null, body: 'Der Preissprung von 3.999 auf 6.950 Dollar ist schon heftig, dein 7B mit vier pro Sekunde wirkt dagegen ehrlich.', variants: {}, recipient: null },
      platforms: [],
      rules: null,
      facts: { known: [], avoid: [] },
      projectData: '',
      release: null,
      subreddit: null,
      recent: [],
      lessons: [],
    }
    expect(reviewerPrompt(input)).toContain('"wrongLanguage"')
    const rv = { cfg: llmConfig({ provider: 'ollama', model: 'mock' }), strong: true }
    const code = await aiReview(rv, input, [], [], reply({ verdict: 'ok', reason: 'Passt.', solvesProblem: true, wrongLanguage: false }))
    expect(code).toMatchObject({ verdict: 'verwerfen', obsolete: true, fix: null })
    expect(code!.reason.startsWith(WRONG_LANG)).toBe(true)
    const model = await aiReview(rv, { ...input, draft: { ...input.draft, body: 'krass, echt' } }, [], [], reply({ verdict: 'ok', reason: 'Passt.', solvesProblem: true, wrongLanguage: true }))
    expect(model).toMatchObject({ verdict: 'verwerfen', obsolete: true })
  })
})

describe('Mitreden: strenge Relevanz', () => {
  it('Prüfung ist streng und nennt den Profil-Test', () => {
    const p = relevancePrompt('Projekt: linkbox', [hit({ text: DGX })])
    expect(p).toContain('Strenge Relevanzprüfung')
    expect(p).toContain('klickt auf unser Profil')
    expect(p).toContain('Im Zweifel relevant=false')
  })

  it('nur klares Ja mit bekannter Projektsprache kommt durch', () => {
    const list = [hit({ key: 'a', text: DGX }), hit({ key: 'b' }), hit({ key: 'c', lang: null }), hit({ key: 'd', lang: null }), hit({ key: 'e', lang: 'ja' }), hit({ key: 'f' })]
    const r = relevantHits(list, [
      { i: 0, relevant: false, lang: 'en', why: 'KI-Hardwarepreise' },
      { i: 1, relevant: true, lang: 'en', why: 'Lesezeichen' },
      { i: 2, relevant: true, lang: 'de', why: 'Lesezeichen' },
      { i: 3, relevant: true, lang: null, why: 'Lesezeichen' },
      { i: 4, relevant: true, lang: 'ja', why: 'Lesezeichen' },
    ], ['de', 'en'])
    expect(r.keep.map(h => [h.key, h.lang])).toEqual([['b', 'en'], ['c', 'de']])
    expect(Object.fromEntries(r.dropped.map(d => [d.hit.key, d.why]))).toEqual({ a: 'KI-Hardwarepreise', d: 'Sprache unklar', e: 'Sprache ja ist keine Projektsprache', f: 'keine klare Antwort der Prüfung' })
    expect(relevantHits(list, [], ['en']).keep).toEqual([])
  })

  it('Sammelbegriffe wie MCP, LLM oder selfhosted werden nicht gesucht', () => {
    for (const t of ['MCP', 'llm', '#selfhosted', 'localAI', 'local LLM', 'MCP server', 'open source', 'AI tools', 'self-hosted']) expect(broadTerm(t), t).toBe(true)
    for (const t of ['bookmark manager', 'bookmarks', 'alternative to Pocket', 'Lesezeichen', 'darksynth', 'aimusic']) expect(broadTerm(t), t).toBe(false)
    expect(cleanTerms({ queries: ['bookmark manager recommendation', 'MCP server', 'local LLM'], tags: ['bookmarks', 'selfhosted', 'localai', 'mcp'] }, 'linkbox')).toEqual({ queries: ['bookmark manager recommendation'], tags: ['bookmarks'] })
    expect(nicheTerms(project, ['selfhosted', 'alternative to Pocket'])).toEqual(['bookmark manager', 'Lesezeichen', 'alternative to Pocket'])
  })
})
