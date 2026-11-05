import { describe, expect, it } from 'vitest'
import { channelBlock, taskBlock } from '../../server/lib/plan-guard'
import { draftPrompt } from '../../server/prompts/de'
import { clipText } from '../../server/lib/service'
import { isOwnBlog, isOwnSite, postLink, postTarget, hostPath, taskWhere } from '../../shared/utils/where'

const article = { title: 'Ratgeber: EU AI Act Kennzeichnungspflicht', category: 'content', channel: 'Eigener Blog', draftKind: 'article' }

describe('Ziel einer Aufgabe', () => {
  it('Artikel ohne Blog: Ziel fehlt', () => {
    expect(taskWhere(article, { places: ['Eigener Blog', 'datenschutz-praxis.de (Gastbeitrag)'] })).toMatchObject({ kind: 'blog', mark: 'blog', place: null, missing: true, by: 'human' })
    expect(isOwnBlog('Eigener Blog')).toBe(true)
    expect(isOwnBlog('datenschutz-praxis.de (Gastbeitrag)')).toBe(false)
  })

  it('Artikel mit Blog-Adresse aus Projekt oder Strategie', () => {
    expect(taskWhere(article, { blog: 'https://tonebase.com/blog' })).toMatchObject({ kind: 'blog', place: 'tonebase.com/blog', url: 'https://tonebase.com/blog', missing: false })
    expect(taskWhere(article, { places: ['https://chatsite.site/de/ratgeber'] })).toMatchObject({ place: 'chatsite.site/de/ratgeber', missing: false })
  })

  it('Gastbeitrag und Strategie-Orte', () => {
    expect(taskWhere({ ...article, channel: 'datenschutz-praxis.de (Gastbeitrag)' })).toMatchObject({ kind: 'external', place: 'datenschutz-praxis.de (Gastbeitrag)', missing: false })
    expect(taskWhere({ ...article, channel: 'Compliance-Content' }, { channelName: 'Compliance-Content', places: ['Eigener Blog', 'Medium'] })).toMatchObject({ kind: 'external', place: 'Medium' })
  })

  it('Reddit-Antwort ohne Reddit-Zugang braucht Einrichtung', () => {
    const reply = { title: 'Antwort: FLAC vs. Streaming', category: 'community', channel: 'r/lossless', draftKind: 'post' }
    expect(taskWhere(reply, { reddit: false })).toMatchObject({ place: 'r/lossless', missing: false, setup: 'reddit' })
    expect(taskWhere(reply, { reddit: true }).setup).toBeUndefined()
    expect(taskWhere({ ...reply, targetUrl: 'https://www.reddit.com/r/lossless/comments/x/' }, { reddit: false }).setup).toBeUndefined()
    expect(taskWhere({ ...reply, title: 'Beitrag: Neues Album' }, { reddit: false }).setup).toBeUndefined()
  })

  it('Social, Reddit, Verzeichnis, Mail', () => {
    expect(taskWhere({ title: 'Post', category: 'social', channel: 'LinkedIn' }, { accounts: ['linkedin'], autoPost: true })).toMatchObject({ kind: 'social', mark: 'linkedin', by: 'agent', missing: false })
    expect(taskWhere({ title: 'Twitter/X Post: DSGVO Chatbot', category: 'social', channel: 'Twitter/X (#DSGVO)' }, { accounts: ['linkedin'] })).toMatchObject({ mark: 'x', missing: true })
    expect(taskWhere({ title: 'Antwort', category: 'community', channel: 'r/gdpr' })).toMatchObject({ kind: 'community', mark: 'reddit', place: 'r/gdpr', missing: false })
    expect(taskWhere({ title: 'Antwort', category: 'community', channel: 'Nischen-Communities' }, { channelName: 'Nischen-Communities' })).toMatchObject({ kind: 'community', missing: true })
    expect(taskWhere({ title: 'Eintrag', category: 'verzeichnis', channel: 'Futurepedia' })).toMatchObject({ kind: 'directory', place: 'Futurepedia' })
    expect(taskWhere({ title: 'Pitch', category: 'outreach', draftKind: 'mail' }, { recipient: 'a@b.at', autoMail: true })).toMatchObject({ kind: 'mail', place: 'a@b.at', by: 'agent' })
  })
})

describe('Planung nur mit Ziel', () => {
  const guard = { blog: null, accounts: ['bluesky'] }
  it('Artikel ohne Blog und Posts ohne Konto werden blockiert', () => {
    expect(taskBlock(guard, 'content', 'Eigener Blog', { name: 'Blog', places: ['Eigener Blog'] })).toEqual({ kind: 'blog' })
    expect(taskBlock(guard, 'content', 'Medium', { name: 'Blog', places: [] })).toBeNull()
    expect(taskBlock({ ...guard, blog: 'https://x.at/blog' }, 'content', 'Eigener Blog', { name: 'Blog', places: [] })).toBeNull()
    expect(taskBlock(guard, 'social', 'LinkedIn (eigener Post)', { name: 'LinkedIn & Social', places: [] })).toEqual({ kind: 'account', platform: 'linkedin' })
    expect(taskBlock(guard, 'social', 'Bluesky', { name: 'Posts', places: [] })).toBeNull()
  })
  it('Kanäle: Takt nur mit Ziel', () => {
    expect(channelBlock(guard, { name: 'LinkedIn & Social', category: 'social', places: ['LinkedIn (eigener Post)', 'Twitter/X (#DSGVO)'] })).toEqual({ kind: 'account', platform: 'linkedin' })
    expect(channelBlock(guard, { name: 'Posts', category: 'social', places: ['Bluesky', 'Mastodon'] })).toBeNull()
    expect(channelBlock(guard, { name: 'Blog und Ratgeber', category: 'content', places: [] })).toEqual({ kind: 'blog' })
    expect(channelBlock(guard, { name: 'Content', category: 'content', places: ['Eigener Blog', 'datenschutz-praxis.de (Gastbeitrag)'] })).toBeNull()
    expect(channelBlock(guard, { name: 'Foren', category: 'community', places: [] })).toBeNull()
  })
})

describe('postTarget', () => {
  const utm = 'https://thewandererai.com/?utm_source=r-synthwave&utm_medium=community&utm_campaign=the-com-002'
  const sub = { mark: 'reddit', place: 'r/synthwave' }
  it('nimmt nie den UTM-Link aus dem Beitrag als Ort zum Posten', () => {
    expect(postTarget([utm], sub, { community: true, siteHosts: ['thewandererai.com'] })).toBe('https://www.reddit.com/r/synthwave/submit')
    expect(postTarget(['https://thewandererai.com/'], { mark: 'forum', place: 'forum.example' }, { community: true, siteHosts: ['thewandererai.com'] })).toBeNull()
  })
  it('bevorzugt den Thread, sonst Subreddit-Submit, sonst Community-URL', () => {
    const thread = 'https://www.reddit.com/r/synthwave/comments/abc123/new_track/'
    expect(postTarget([utm, 'https://www.reddit.com/search/?q=x', thread], sub)).toBe(thread)
    expect(postTarget(['https://www.reddit.com/search/?q=x'], sub)).toBe('https://www.reddit.com/r/synthwave/submit')
    expect(postTarget([null, 'https://forum.example.org/t/42'], { mark: 'forum', place: 'forum.example.org' }, { community: true })).toBe('https://forum.example.org/t/42')
    expect(postTarget([], { mark: 'forum', place: 'Synth-Forum' })).toBeNull()
  })
  it('kürzt auf Domain und Pfad', () => {
    expect(hostPath(utm)).toBe('thewandererai.com')
    expect(hostPath('https://www.reddit.com/r/synthwave/submit')).toBe('reddit.com/r/synthwave/submit')
  })
})

describe('Neuer Reddit-Beitrag', () => {
  const t = { title: 'Reddit: Superposition-Konzept vorstellen', category: 'community', channel: null, draftKind: 'post', description: 'Ausführlicher Reddit-Post. Zielsubreddit zuerst r/aiMusic. r/synthwave nur nach Regel-Check.' }
  it('Ziel ist das Subreddit aus der Beschreibung, Link zum Einreichen statt alter Thread', () => {
    const w = taskWhere(t)
    expect(w).toMatchObject({ kind: 'community', mark: 'reddit', place: 'r/aiMusic', url: 'https://www.reddit.com/r/aiMusic/submit', missing: false, newPost: true })
    const old = 'https://www.reddit.com/r/aiMusic/comments/1wkzwzn/dance_bad_times_by_imael_angel/'
    expect(postTarget([old], w)).toBe('https://www.reddit.com/r/aiMusic/submit')
    expect(taskWhere({ ...t, description: null, targetUrl: old })).toMatchObject({ place: 'r/aiMusic', newPost: true })
  })
  it('Antwort auf einen Thread bleibt Antwort', () => {
    const w = taskWhere({ ...t, title: 'Antwort: Frage zu Darksynth in r/synthwave', targetUrl: 'https://www.reddit.com/r/synthwave/comments/abc/x/' })
    expect(w.newPost).toBeUndefined()
    expect(w.url).toBe('https://www.reddit.com/r/synthwave/comments/abc/x/')
  })
})

describe('Link im Beitrag', () => {
  const utm = 'https://linkbox.net/?utm_source=r-selfhosted&utm_medium=community&utm_campaign=bmx-com-002'
  const hosts = ['linkbox.net']
  const body = 'I built a self-hosted bookmark manager. Not pitching it here, just curious how you organize yours.'
  it('Community-Beitrag ohne Link: keine Zeile und kein Hinweis', () => {
    expect(postLink([body], hosts, utm, true)).toBeNull()
  })
  it('Community-Beitrag mit Link: Zeile ohne Warnung', () => {
    expect(postLink([`${body}\nhttps://linkbox.net/?utm_source=x`], hosts, utm, true)).toEqual({ url: 'https://linkbox.net/?utm_source=x', inText: true })
  })
  it('Social-Beitrag ohne Link: Hinweis bleibt', () => {
    expect(postLink([body], hosts, utm, false)).toEqual({ url: utm, inText: false })
  })
  it('Entwurfs-Prompt verlangt bei Reddit keinen Link', () => {
    const input = { project: { name: 'Linkbox', url: 'https://linkbox.net', description: null, tonality: null, languages: ['en'] }, task: { code: 'BMX-COM-002', title: 'Beitrag in r/selfhosted', description: null, category: 'community', channel: 'r/selfhosted', language: 'en', agentStep: null, humanStep: null, draftKind: null, targetUrl: null, metric: null }, memory: [], notes: [], previous: null, utmUrl: utm, type: 'post' as const, platform: 'reddit' as const }
    const p = draftPrompt(input)
    expect(p).not.toContain('verwende genau diesen Link, keinen anderen')
    expect(p).toContain('sonst keinen Link und keine Domain')
    expect(draftPrompt({ ...input, task: { ...input.task, category: 'social', channel: 'Mastodon' }, platform: 'mastodon' })).toContain('Link mit UTM für das Produkt')
  })
})

describe('Eigener Blog mit falscher Domain im Kanal', () => {
  const bit = { title: 'Artikel: Bandcamp-Alternative', category: 'content', channel: 'tonebase.de/blog', draftKind: 'article' }

  it('BIT-CON-006: Kanal tonebase.de/blog, Blog liegt auf tonebase.com/blog: eigener Blog mit Adresse aus dem Projekt', () => {
    expect(taskWhere(bit, { blog: 'https://tonebase.com/blog', autoBlog: true })).toMatchObject({ kind: 'blog', place: 'tonebase.com/blog', by: 'agent' })
    expect(taskWhere(bit, { site: 'https://tonebase.com' })).toMatchObject({ kind: 'blog', place: 'tonebase.com/blog' })
    expect(isOwnSite('tonebase.de/blog', 'https://www.tonebase.com')).toBe(true)
    expect(isOwnSite('datenschutz-praxis.de', 'https://tonebase.com/blog')).toBe(false)
    expect(taskWhere({ ...bit, channel: 'datenschutz-praxis.de' }, { blog: 'https://tonebase.com/blog' })).toMatchObject({ kind: 'external', place: 'datenschutz-praxis.de' })
  })
})

describe('Dienst-Texte ohne halbe Sätze', () => {
  it('kürzt am Satzende, sonst am Wort mit "..."', () => {
    const s = 'Falls du noch keinen Zugang zum Blog-Bereich hast: Konto mit E-Mail anlegen, ca. 2 Min. Ob ein Konto nötig ist, kann ich nicht sicher sagen.'
    expect(clipText(s, 120)).toBe('Falls du noch keinen Zugang zum Blog-Bereich hast: Konto mit E-Mail anlegen, ca. 2 Min.')
    expect(clipText('kurz', 120)).toBe('kurz')
    expect(clipText('eins zwei drei vier fünf sechs', 16)).toBe('eins zwei...')
  })
})
