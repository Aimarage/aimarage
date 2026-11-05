import { describe, expect, it } from 'vitest'
import { buildPost, tiktokChoice, TIKTOK_DEFAULT, zernioOutlet } from '../../server/lib/zernio'
import type { SocialConfig } from '../../server/lib/social'

const base = { profile: 'p', text: 'Neuer Song draußen', variants: {}, at: null, timezone: 'Europe/Vienna', externalId: 'e1', media: [] }

function settingsOf(body: Record<string, unknown>): Record<string, unknown> {
  return ((body.platforms as Record<string, unknown>[])[0]!.platformSpecificData as { tiktokSettings: Record<string, unknown> }).tiktokSettings
}

describe('Zernio: tiktokSettings', () => {
  it('Video: alle Pflichtfelder, Standard öffentlich mit Kommentaren, Duett und Stitch', () => {
    const s = settingsOf(buildPost({ ...base, platforms: ['tiktok'], accounts: { tiktok: 'a2' } }, [{ url: 'https://m/v.mp4', mime: 'video/mp4' }]))
    expect(s).toEqual({ privacy_level: 'PUBLIC_TO_EVERYONE', allow_comment: true, allow_duet: true, allow_stitch: true, content_preview_confirmed: true, express_consent_given: true })
  })

  it('Foto-Karussell: media_type photo, Beschreibung, ohne Duett und Stitch', () => {
    const s = settingsOf(buildPost({ ...base, platforms: ['tiktok'], accounts: { tiktok: 'a2' }, aiGenerated: true }, [{ url: 'https://m/b.jpg', mime: 'image/jpeg' }]))
    expect(s).toEqual({ privacy_level: 'PUBLIC_TO_EVERYONE', allow_comment: true, content_preview_confirmed: true, express_consent_given: true, media_type: 'photo', photo_cover_index: 0, description: 'Neuer Song draußen' })
  })

  it('creator-info: erlaubte Sichtbarkeit und abgeschaltete Interaktionen werden übernommen', () => {
    expect(tiktokChoice({})).toEqual(TIKTOK_DEFAULT)
    const c = tiktokChoice({ privacyLevels: [{ value: 'FOLLOWER_OF_CREATOR' }, { value: 'SELF_ONLY' }], postingLimits: { interactionSettings: { allow_comment: { enabled: true }, allow_duet: { enabled: false }, allow_stitch: { enabled: true } } } })
    expect(c).toEqual({ privacy: 'FOLLOWER_OF_CREATOR', comment: true, duet: false, stitch: true })
  })

  it('post fragt creator-info ab und sendet die Werte mit', async () => {
    const calls: { url: string, body?: Record<string, unknown> }[] = []
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined })
      const data = url.includes('/tiktok/creator-info')
        ? { privacyLevels: [{ value: 'PUBLIC_TO_EVERYONE' }], postingLimits: { interactionSettings: { allow_comment: { enabled: false } } } }
        : { post: { _id: 'p1', status: 'scheduled', platforms: [{ platform: 'tiktok', status: 'pending' }] } }
      return new Response(JSON.stringify(data), { status: 200 })
    }
    const cfg = { apiKey: 'k', keySource: 'own' } as SocialConfig
    await zernioOutlet.post(cfg, { ...base, platforms: ['tiktok'], accounts: { tiktok: 'acc 1' }, media: [{ name: 'v.mp4', mime: 'video/mp4', data: new Uint8Array([1]), url: 'https://m/v.mp4' }] }, fetchImpl as never)
    expect(calls[0]!.url).toContain('/accounts/acc%201/tiktok/creator-info?mediaType=video')
    const s = settingsOf(calls[1]!.body!)
    expect(s.allow_comment).toBe(false)
    expect(s.allow_duet).toBe(true)
    expect(s.content_preview_confirmed).toBe(true)
  })
})
