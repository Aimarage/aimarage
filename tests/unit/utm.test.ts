import { describe, expect, it } from 'vitest'
import { postText, siteLinks, tagDraft, tagLinks, utmSites, utmSourceFor } from '../../shared/utils/utm'
import { postLength, shortUrl } from '../../shared/utils/social'
import { bskyRichText } from '../../server/lib/platforms/bluesky'
import { linkedPage } from '../../server/lib/agent'

const utm = { source: 'bluesky', medium: 'social', campaign: 'bit-soc-012' }
const task = { code: 'BIT-SOC-012', category: 'social', channel: 'Mastodon (#flac)', title: 'Post zu Superposition' }

describe('UTM an Links der Projekt-Domain', () => {
  it('ergänzt UTM an Unterseiten, behält andere Parameter, doppelt nichts', () => {
    expect(tagLinks('Neu: https://tonebase.com/artists/the-wanderer/album/superposition', 'tonebase.com', utm))
      .toBe('Neu: https://tonebase.com/artists/the-wanderer/album/superposition?utm_source=bluesky&utm_medium=social&utm_campaign=bit-soc-012')
    expect(tagLinks('https://www.tonebase.com/a?ref=x&utm_source=alt&utm_source=alt2#top.', 'tonebase.com', utm))
      .toBe('https://www.tonebase.com/a?ref=x&utm_source=bluesky&utm_medium=social&utm_campaign=bit-soc-012#top.')
    const once = tagLinks('(https://tonebase.com)', 'tonebase.com', utm)
    expect(once).toBe('(https://tonebase.com/?utm_source=bluesky&utm_medium=social&utm_campaign=bit-soc-012)')
    expect(tagLinks(once, 'tonebase.com', utm)).toBe(once)
  })
  it('lässt fremde Domains und ähnliche Namen in Ruhe', () => {
    const text = 'https://bandcamp.com/x und https://nottonebase.com/y'
    expect(tagLinks(text, 'tonebase.com', utm)).toBe(text)
    expect(siteLinks(`${text} https://shop.tonebase.com/z`, 'tonebase.com')).toEqual(['https://shop.tonebase.com/z'])
  })
  it('Quelle je Fassung, Text nur bei Social', () => {
    expect(utmSourceFor(task)).toBe('mastodon')
    expect(utmSourceFor(task, 'mastodon')).toBe('mastodon')
    expect(utmSourceFor(task, 'bluesky')).toBe('bluesky')
    const d = tagDraft({ body: 'https://tonebase.com/a', variants: { bluesky: 'https://tonebase.com/a', mastodon: 'https://tonebase.com/a' } }, 'https://tonebase.com', task)
    expect(d.body).toContain('utm_source=mastodon&utm_medium=social&utm_campaign=bit-soc-012')
    expect(d.variants!.bluesky).toContain('utm_source=bluesky&')
    expect(d.variants!.mastodon).toContain('utm_source=mastodon&')
    expect(tagDraft({ body: 'https://tonebase.com/a' }, 'https://tonebase.com', { ...task, category: 'outreach' }).body).toBe('https://tonebase.com/a')
    expect(postText('bluesky', { body: 'https://tonebase.com/?utm_source=mastodon&utm_medium=social&utm_campaign=bit-soc-012' }, 'https://tonebase.com', task)).toContain('utm_source=bluesky&')
  })
  it('Haupttext wird nicht auf den Kanal umgeschrieben, wenn der Kanal eine eigene Fassung hat', () => {
    const ig = { code: 'THE-SOC-023', category: 'social', channel: 'Instagram @the_wanderer_ai', title: 'Lieblingstracks' }
    const d = tagDraft({ body: 'https://tonebase.com/a?utm_source=bluesky', variants: { instagram: 'Link in bio', bluesky: 'https://tonebase.com/a' } }, 'https://tonebase.com', ig)
    expect(d.body).toContain('utm_source=bluesky&utm_medium=social&utm_campaign=the-soc-023')
    expect(tagDraft({ body: 'https://tonebase.com/a?utm_source=bluesky' }, 'https://tonebase.com', ig).body).toContain('utm_source=instagram&')
    expect(utmSourceFor({ code: 'THE-SOC-1', category: 'social', channel: 'X thewandererai' })).toBe('x')
  })
  it('Links zur Seite der Statistik bekommen UTM, auch wenn die Projekt-Domain eine andere ist', () => {
    const band = { code: 'THE-SOC-001', category: 'social', channel: 'bluesky', title: 'Album' }
    const sites = utmSites({ url: 'https://thewandererai.com', setup: { stats: { url: 'https://tonebase.com/api/v1/admin/utm' } } })
    expect(sites).toEqual(['https://thewandererai.com', 'https://tonebase.com/api/v1/admin/utm'])
    expect(utmSites({ url: 'https://thewandererai.com', setup: null })).toEqual(['https://thewandererai.com'])
    const d = tagDraft({ body: 'https://tonebase.com/artists/the-wanderer https://thewandererai.com/ https://open.spotify.com/x' }, sites, band)
    expect(d.body).toBe('https://tonebase.com/artists/the-wanderer?utm_source=bluesky&utm_medium=social&utm_campaign=the-soc-001 https://thewandererai.com/?utm_source=bluesky&utm_medium=social&utm_campaign=the-soc-001 https://open.spotify.com/x')
    expect(postText('bluesky', { body: 'https://tonebase.com/artists/the-wanderer' }, sites, band)).toContain('utm_campaign=the-soc-001')
    expect(tagDraft({ body: 'https://tonebase.com/a' }, 'https://thewandererai.com', band).body).toBe('https://tonebase.com/a')
  })
  it('verlinkte Unterseite für das Bild', () => {
    expect(linkedPage('https://tonebase.com', ['Startseite https://tonebase.com/?utm_source=x', 'Album https://tonebase.com/artists/a/album/b?utm_source=x&ref=1'])).toBe('https://tonebase.com/artists/a/album/b?ref=1')
    expect(linkedPage('https://tonebase.com', ['https://tonebase.com/ und https://bandcamp.com/x'])).toBeNull()
    expect(linkedPage('https://tonebase.com', ['kein Link'], 'https://tonebase.com/artists/a')).toBe('https://tonebase.com/artists/a')
  })
})

describe('Bluesky kürzt Links in der Anzeige', () => {
  it('kurze Anzeige, Facet auf volle Adresse, Zähler auf gekürzte Länge', () => {
    const url = 'https://tonebase.com/artists/the-wanderer/album/superposition?utm_source=bluesky'
    expect(shortUrl(url)).toBe('tonebase.com/artists/the-...')
    expect(shortUrl('https://tonebase.com/')).toBe('tonebase.com')
    const r = bskyRichText(`Grüße ${url}. #indie`)
    expect(r.text).toBe('Grüße tonebase.com/artists/the-.... #indie')
    expect(r.facets[0]!.index).toEqual({ byteStart: 8, byteEnd: 8 + 'tonebase.com/artists/the-...'.length })
    expect(r.facets[0]!.features[0]).toEqual({ $type: 'app.bsky.richtext.facet#link', uri: url })
    expect(r.facets[1]!.features[0]).toEqual({ $type: 'app.bsky.richtext.facet#tag', tag: 'indie' })
    expect(postLength('bluesky', `Grüße ${url}. #indie`)).toBe([...r.text].length)
    expect(postLength('mastodon', url)).toBe(url.length)
  })
})
