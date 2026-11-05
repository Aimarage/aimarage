import { describe, expect, it } from 'vitest'
import { callJson, cleanError, errText, jsonOf, looksHtml, PlatformError } from '../../server/lib/platforms/types'
import { cleanConnErrors } from '../../server/lib/connections'
import { isTransient } from '../../shared/utils/access'
import type { WorkspaceSettings } from '../../server/db/schema'

const html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta content="width=device-width" name="viewport">\n<title>mastodon.social</title></head><body>Bad gateway</body></html>'
const res = (status: number, body: string) => new Response(body, { status, headers: { 'Content-Type': body.startsWith('<') ? 'text/html' : 'application/json' } })

describe('Verbindungsfehler ohne HTML, 5xx/429 vorübergehend', () => {
  it('503 mit HTML-Seite: nur Klartext, gilt als vorübergehend', async () => {
    const f = async () => res(503, html)
    const err = await callJson(f, 'Mastodon', 'https://mastodon.social/api/v1/accounts/verify_credentials').catch(e => e as PlatformError)
    expect(err.message).toBe('Mastodon: Server vorübergehend nicht erreichbar (503)')
    expect(err.status).toBe(503)
    expect(isTransient(err.message)).toBe(true)
  })

  it('429 heißt zu viele Anfragen, 401 behält die Meldung der Plattform und ist kein Kurzfehler', async () => {
    expect(errText({}, 429)).toBe('zu viele Anfragen, wird später erneut versucht (429)')
    const msg = `Mastodon: ${errText(await jsonOf(res(401, '{"error":"The access token is invalid"}')), 401)}`
    expect(msg).toBe('Mastodon: HTTP 401: The access token is invalid')
    expect(isTransient(msg)).toBe(false)
  })

  it('4xx mit HTML-Seite: nur der Status', async () => {
    expect(looksHtml(html)).toBe(true)
    expect(errText(await jsonOf(res(404, html)), 404)).toBe('HTTP 404')
  })

  it('gespeicherter Fehler mit HTML wird bereinigt (einmalig in migrate.ts)', () => {
    const stored = `Mastodon: HTTP 503: ${html.slice(0, 200)}`
    expect(cleanError(stored)).toBe('Mastodon: Server vorübergehend nicht erreichbar (503)')
    expect(cleanError('Mastodon: Zugangstoken abgelehnt')).toBe('Mastodon: Zugangstoken abgelehnt')
    const settings = { connections: [{ id: 'm', provider: 'mastodon', platform: 'mastodon', name: '@thewandererai@mastodon.social', error: stored }, { id: 'x', provider: 'x', platform: 'x', name: 'X', error: 'X: Zugang abgelaufen, bitte neu verbinden' }] } as unknown as WorkspaceSettings
    const out = cleanConnErrors(settings)!
    expect(out.connections!.map(c => c.error)).toEqual(['Mastodon: Server vorübergehend nicht erreichbar (503)', 'X: Zugang abgelaufen, bitte neu verbinden'])
    expect(cleanConnErrors(out)).toBeNull()
  })
})
