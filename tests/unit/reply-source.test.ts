import { describe, expect, it } from 'vitest'
import { isNewListenDesc, listenSourceLines, parseListenDesc, replySourceOf, sourceRest } from '../../shared/utils/reply-source'
import { threadNote } from '../../shared/utils/reddit'

describe('reply-source', () => {
  it('neue Form mit unserem Beitrag', () => {
    const lines = listenSourceLines({ kind: 'mention', author: 'archonode.com', text: 'What moment before the wave function do you find most intriguing?', url: 'https://bsky.app/profile/a/post/1', at: '2026-10-13T20:14:00.000Z', parent: { author: 'theplace.bsky.social', ours: true, at: '2026-10-13T18:00:00.000Z', text: 'Unser neues Album ist da', url: 'https://bsky.app/profile/b/post/0' } })
    const desc = [...lines, 'Warum: Frage', 'Nach dem Freigeben antwortet Aimarage selbst.'].join('\n')
    expect(lines[0]).toBe('@archonode.com hat auf unseren Beitrag "Unser neues Album ist da" geantwortet, am 2026-10-13 20:14 UTC:')
    expect(isNewListenDesc(desc)).toBe(true)
    const s = parseListenDesc(desc)!
    expect(s.relation).toBe('reply')
    expect(s.author).toBe('archonode.com')
    expect(s.at).toBe('2026-10-13T20:14:00.000Z')
    expect(s.text).toContain('wave function')
    expect(s.url).toBe('https://bsky.app/profile/a/post/1')
    expect(s.parent).toEqual({ author: 'theplace.bsky.social', ours: true, at: '2026-10-13T18:00:00.000Z', text: 'Unser neues Album ist da', url: 'https://bsky.app/profile/b/post/0' })
    expect(sourceRest(desc, s)).toBe('Warum: Frage\nNach dem Freigeben antwortet Aimarage selbst.')
  })

  it('Suche ohne Elternbeitrag und mit Subreddit', () => {
    const lines = listenSourceLines({ kind: 'search', author: 'bob', text: 'Any tool for "x"?', url: 'https://www.reddit.com/r/a/comments/1', at: '2026-10-13T08:00:00Z', sub: 'a' })
    const s = parseListenDesc(lines.join('\n'))!
    expect(s.relation).toBe('search')
    expect(s.sub).toBe('a')
    expect(s.text).toBe('Any tool for "x"?')
    expect(s.parent).toBeNull()
  })

  it('alte Form: Datum aus dem Anlegezeitpunkt', () => {
    const desc = 'Reaktion auf einen eigenen Beitrag von @archonode.com, vor 14 Std.:\n"What moment?"\nhttps://bsky.app/profile/a/post/1\nWarum: x'
    const s = parseListenDesc(desc, '2026-10-14T10:00:00.000Z')!
    expect(s.relation).toBe('reaction')
    expect(s.at).toBe('2026-10-13T20:00:00.000Z')
    expect(isNewListenDesc(desc)).toBe(false)
  })

  it('Mail, Reddit-Thread und Link', () => {
    const mail = replySourceOf({ description: 'Eingegangene Mail von Anna <a@b.at>, Betreff "Frage":\nHallo!', mailDate: '2026-10-13T09:00:00.000Z' })!
    expect(mail).toMatchObject({ relation: 'mail', author: 'Anna', title: 'Frage', text: 'Hallo!', at: '2026-10-13T09:00:00.000Z' })
    const thread = replySourceOf({ description: 'Kommentar schreiben', notes: [{ text: threadNote({ title: 'Best tool?', url: 'https://www.reddit.com/r/selfhosted/comments/1/x', excerpt: 'Looking for...', age: '2 Tage' }), byAgent: true, createdAt: '2026-10-13T09:00:00.000Z' }] })!
    expect(thread).toMatchObject({ relation: 'thread', title: 'Best tool?', sub: 'selfhosted', age: '2 Tage', text: 'Looking for...' })
    const link = replySourceOf({ description: 'Link: https://x.org/a\nWunsch: kurz\nInhalt (Auszug):\nSeitentext', title: 'Antwort: Seite A' })!
    expect(link).toMatchObject({ relation: 'link', title: 'Seite A', url: 'https://x.org/a', text: 'Seitentext' })
    expect(sourceRest('Link: https://x.org/a\nWunsch: kurz\nInhalt (Auszug):\nSeitentext', link)).toBe('Wunsch: kurz')
    expect(replySourceOf({ description: 'Neuer Post über das Album' })).toBeNull()
  })
})

describe('parentOf', () => {
  it('holt den Elternbeitrag auf Bluesky und erkennt unseren', async () => {
    const { parentOf, bskyHit } = await import('../../server/lib/listening')
    const hit = bskyHit({ uri: 'at://did:x/app.bsky.feed.post/2', author: { did: 'did:x', handle: 'archonode.com' }, record: { text: 'Frage?', createdAt: '2026-10-13T20:14:00Z', reply: { root: { uri: 'at://did:me/app.bsky.feed.post/1' }, parent: { uri: 'at://did:me/app.bsky.feed.post/1' } } } }, 'mention')!
    const f = async () => new Response(JSON.stringify({ posts: [{ uri: 'at://did:me/app.bsky.feed.post/1', author: { did: 'did:me', handle: 'me.bsky.social' }, record: { text: 'Unser Album', createdAt: '2026-10-13T18:00:00Z' } }] }), { status: 200 })
    const p = await parentOf(hit, { bsky: { base: 'https://pds', jwt: 'j', did: 'did:me', handle: 'me.bsky.social' }, masto: null, own: { bluesky: new Set(['did:me']), mastodon: new Set() }, f })
    expect(p).toMatchObject({ author: 'me.bsky.social', ours: true, text: 'Unser Album', at: '2026-10-13T18:00:00Z' })
  })
})
