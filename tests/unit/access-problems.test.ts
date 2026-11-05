import { describe, expect, it } from 'vitest'
import { accessProblems, isAccessExpired, isTransient } from '../../shared/utils/access'
import { digestText } from '../../server/lib/morning-digest'

const google = { secret: { enc: 'x' }, error: 'Verbindung zur Google Search Console abgelaufen oder widerrufen, bitte neu verbinden' }
const tonebase = { id: 'p1', slug: 'tonebase', name: 'tonebase', setup: { google, social: { accountIds: ['c1'] } } }
const visitors = { id: 'p2', slug: 'thewanderer', name: 'The Wanderer', setup: { google: { ...google }, bing: { site: 'https://thewandererai.com/', error: 'Google nicht erreichbar (fetch failed)' } } }

describe('Zugangsfehler stehen unter "Für dich"', () => {
  it('Google abgelaufen bei tonebase und The Wanderer: je 1 Min mit Direktlink zum Neu-Verbinden', () => {
    const list = accessProblems([tonebase, visitors], [])
    expect(list.map(a => a.path)).toEqual(['/p/tonebase/berichte?reconnect=google', '/p/thewanderer/berichte?reconnect=google'])
    expect(list.every(a => a.min === 1 && a.app === 'google' && a.what === 'Google Search Console')).toBe(true)
  })

  it('kurze Störungen zählen nicht, Social-Konten und eigener KI-Schlüssel schon', () => {
    expect(isTransient('Google nicht erreichbar (fetch failed)')).toBe(true)
    const list = accessProblems([{ ...tonebase, setup: { social: { accountIds: ['c1'] } } }], [{ id: 'c1', provider: 'x', platform: 'x', name: 'X', handle: '@tonebase', error: 'X: Zugang abgelaufen, bitte neu verbinden' }, { id: 'c2', platform: 'bluesky', name: 'Bluesky', error: null }], { code: 'auth', message: 'Schlüssel ungültig' })
    expect(list).toMatchObject([{ kind: 'social', what: 'X (@tonebase)', path: '/p/tonebase/konten?connect=x', app: 'x' }, { kind: 'llm', path: '/einstellungen/ki' }])
    expect(accessProblems([{ id: 'p', slug: 'p', name: 'P', setup: { google: { error: 'x' } } }], [])).toEqual([])
  })

  it('gestörtes Social-Konto ohne Projekt wird nicht gemeldet', () => {
    expect(accessProblems([{ ...tonebase, setup: { social: { accountIds: ['c1'] } } }], [{ id: 'm1', provider: 'mastodon', platform: 'mastodon', name: 'Mastodon', handle: '@tonebase@mastodon.social', error: 'HTTP 403: Your login is currently disabled' }])).toEqual([])
  })

  it('abgelaufen erkennt die Such-Karte (Neu verbinden statt Website-Auswahl)', () => {
    expect(isAccessExpired(google.error)).toBe(true)
    expect(isAccessExpired('Kein Zugriff (403)')).toBe(false)
  })

  it('Morgen-Mail: Zugangsfehler zuerst, mit Link', () => {
    const [a] = accessProblems([tonebase], [])
    const mail = digestText({ userId: 'peter', minutes: 3, items: [{ title: a!.what, time: null, min: 1, url: `https://app.aimarage.com${a!.path}`, access: a }, { title: 'Artikel: Bandcamp-Alternative', time: '10:00', min: 2, url: 'x' }] }, 'de')
    expect(mail.body).toContain('1. Zugang neu verbinden: Google Search Console (tonebase) - Verbindung zur Google Search Console abgelaufen')
    expect(mail.body).toContain('https://app.aimarage.com/p/tonebase/berichte?reconnect=google')
    expect(mail.body.indexOf('Zugang neu verbinden')).toBeLessThan(mail.body.indexOf('Bandcamp'))
  })
})
