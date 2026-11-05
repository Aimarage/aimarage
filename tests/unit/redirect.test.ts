import { describe, expect, it } from 'vitest'
import { dropLocalRedirects, isLocalUrl, redirectFor } from '../../server/lib/connections'

describe('Weiterleitungs-Adresse nach Datenübernahme lokal -> live', () => {
  const live = 'https://app.aimarage.com/api/connect/google/callback'

  it('localhost-Adresse gilt live nicht, eigene öffentliche Adresse schon', () => {
    expect(isLocalUrl('http://localhost:3210/api/connect/google/callback')).toBe(true)
    expect(isLocalUrl('http://127.0.0.1:3000/x')).toBe(true)
    expect(isLocalUrl(live)).toBe(false)
    expect(redirectFor('http://localhost:3210/api/connect/google/callback', live)).toBe(live)
    expect(redirectFor('https://aimarage.com/api/connect/instagram/callback', live)).toBe('https://aimarage.com/api/connect/instagram/callback')
    expect(redirectFor(null, live)).toBe(live)
    expect(redirectFor('http://localhost:3210/cb', 'http://localhost:3000/cb')).toBe('http://localhost:3210/cb')
  })

  it('migrate entfernt gespeicherte localhost-Adressen nur, wenn die App öffentlich läuft', () => {
    const s = { apps: { google: { clientId: 'a', redirectUri: 'http://localhost:3210/api/connect/google/callback' }, x: { clientId: 'b', redirectUri: 'https://app.aimarage.com/api/connect/x/callback' } } }
    const out = dropLocalRedirects(s, 'https://app.aimarage.com')
    expect(out?.apps?.google?.redirectUri).toBeNull()
    expect(out?.apps?.google?.clientId).toBe('a')
    expect(out?.apps?.x?.redirectUri).toBe('https://app.aimarage.com/api/connect/x/callback')
    expect(dropLocalRedirects(s, 'http://localhost:3210')).toBeNull()
    expect(dropLocalRedirects(out!, 'https://app.aimarage.com')).toBeNull()
  })
})
