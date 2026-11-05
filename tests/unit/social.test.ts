import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resetSecretCache } from '../../server/lib/secret'
import { applySocialUpdate, listSocialAccounts, parseAccounts, parseProfiles, projectAccounts, socialConfig, socialEnvAllowed } from '../../server/lib/social'

const WS = '33333333-3333-3333-3333-333333333333'
const KEY = 'upload-post-key-12345678wxyz'

beforeEach(() => {
  process.env.APP_SECRET = 'test-secret'
  resetSecretCache()
})
afterAll(() => {
  delete process.env.APP_SECRET
  resetSecretCache()
})

describe('Social-Posting-Dienst', () => {
  it('Upload-Post ist Standard, Schlüssel verschlüsselt, Arbeitsbereich vor .env', () => {
    const s = applySocialUpdate(undefined, { apiKey: KEY }, WS)
    expect(JSON.stringify(s)).not.toContain(KEY)
    expect(s.key?.hint).toBe('wxyz')
    const cfg = socialConfig(s, WS, { UPLOADPOST_API_KEY: 'env-key-aaaaaaaa' })
    expect(cfg.provider).toBe('uploadpost')
    expect(cfg.apiKey).toBe(KEY)
    expect(socialConfig(undefined, WS, { UPLOAD_POST_API_KEY: 'env-key-aaaaaaaa' }).keySource).toBe('env')
    expect(socialConfig(s, 'other-ws', {}).apiKey).toBe('')
  })
  it('SOCIAL_ENV_FALLBACK=false: .env-Schlüssel nur mit Betreiber-Ausnahme im Workspace', () => {
    const env = { UPLOAD_POST_API_KEY: 'env-key-aaaaaaaa' }
    const prev = process.env.SOCIAL_ENV_FALLBACK
    try {
      delete process.env.SOCIAL_ENV_FALLBACK
      expect(socialEnvAllowed({})).toBe(true)
      process.env.SOCIAL_ENV_FALLBACK = 'false'
      expect(socialEnvAllowed({})).toBe(false)
      expect(socialEnvAllowed({ socialEnvFallback: true })).toBe(true)
      expect(socialConfig(undefined, WS, env).keySource).toBe('none')
      expect(socialConfig(undefined, WS, env, socialEnvAllowed({ socialEnvFallback: true })).apiKey).toBe('env-key-aaaaaaaa')
      const own = applySocialUpdate(undefined, { apiKey: KEY }, WS)
      expect(socialConfig(own, WS, env, false).apiKey).toBe(KEY)
    }
    finally {
      if (prev === undefined) delete process.env.SOCIAL_ENV_FALLBACK
      else process.env.SOCIAL_ENV_FALLBACK = prev
    }
  })
  it('Dienstwechsel verwirft Schlüssel und Kontenliste', () => {
    const s = { ...applySocialUpdate(undefined, { apiKey: KEY }, WS), accounts: [{ id: 'a', platform: 'bluesky', name: 'x', profileId: 'p', profileName: 'p' }] }
    const n = applySocialUpdate(s, { provider: 'zernio' }, WS)
    expect(n.key).toBeUndefined()
    expect(n.accounts).toBeUndefined()
    expect(socialConfig(n, WS, {}).apiKey).toBe('')
  })
  it('Upload-Post: Profile und Konten lesen, Zuordnung je Projekt', async () => {
    const data = { success: true, profiles: [{ username: 'tonebase', social_accounts: { bluesky: { handle: '@tonebase.com', display_name: 'tonebase' }, tiktok: '' } }, { username: 'linkbox', social_accounts: {} }] }
    const acc = parseAccounts('uploadpost', data)
    expect(acc).toEqual([{ id: 'tonebase:bluesky', platform: 'bluesky', name: '@tonebase.com', profileId: 'tonebase', profileName: 'tonebase' }])
    expect(parseProfiles('uploadpost', data, acc).map(p => p.id)).toEqual(['tonebase', 'linkbox'])
    expect(projectAccounts({ profileIds: ['tonebase'] }, acc)).toHaveLength(1)
    expect(projectAccounts({ profileIds: ['linkbox'] }, acc)).toHaveLength(0)
    expect(projectAccounts(null, acc)).toHaveLength(0)
    const calls: { url: string, auth: string, method: string }[] = []
    const r = await listSocialAccounts({ provider: 'uploadpost', baseUrl: '', apiKey: KEY, keySource: 'workspace', unreadable: false }, async (url, init) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization!, method: String(init.method) })
      return new Response(JSON.stringify(data), { status: 200 })
    })
    expect(r.ok).toBe(true)
    expect(calls[0]).toEqual({ url: 'https://api.upload-post.com/api/uploadposts/users', auth: `Apikey ${KEY}`, method: 'GET' })
  })
  it('Zernio: Konten mit Profil', () => {
    const acc = parseAccounts('zernio', { accounts: [{ _id: '1', platform: 'twitter', username: '@acme', displayName: 'Acme', profileId: { _id: 'p1', name: 'My Brand' }, isActive: true }] })
    expect(acc[0]).toEqual({ id: '1', platform: 'twitter', name: 'Acme', profileId: 'p1', profileName: 'My Brand' })
  })
  it('Fehler ohne Schlüssel im Text', async () => {
    const r = await listSocialAccounts({ provider: 'uploadpost', baseUrl: '', apiKey: KEY, keySource: 'workspace', unreadable: false }, async () => new Response(`invalid ${KEY}`, { status: 401 }))
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain(KEY)
  })
})
