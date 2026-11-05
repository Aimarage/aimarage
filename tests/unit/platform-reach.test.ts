import { describe, expect, it } from 'vitest'
import { byReach, channelReach, PLATFORM_REACH, reachRank, reachTable, reachTier } from '../../shared/utils/platform-reach'
import { strategyPrompt } from '../../server/prompts/de'

describe('platform-reach', () => {
  it('stuft große Plattformen und Nischen ein', () => {
    expect(reachTier(PLATFORM_REACH.find(p => p.key === 'instagram')!.users)).toBe('big')
    expect(reachTier(PLATFORM_REACH.find(p => p.key === 'bluesky')!.users)).toBe('niche')
    expect(reachTier(PLATFORM_REACH.find(p => p.key === 'mastodon')!.users)).toBe('niche')
  })

  it('erkennt die Reichweite eines Kanals aus Name und Orten', () => {
    expect(channelReach({ name: 'Social Media', category: 'social', places: ['Instagram Reels', 'Bluesky'] })).toBe('big')
    expect(channelReach({ name: 'Social Media (Bluesky)', category: 'social' })).toBe('niche')
    expect(channelReach({ name: 'Musiker-Communities', category: 'community', places: ['r/SunoAI'] })).toBe('big')
    expect(channelReach({ name: 'Blog und Ratgeber', category: 'content', places: ['YouTube'] })).toBeNull()
    expect(channelReach({ name: 'Foren', category: 'community', places: ['KVR Audio'] })).toBeNull()
  })

  it('steht als Tabelle mit Regel im Strategie-Prompt', () => {
    const p = strategyPrompt({ name: 'Test', analysis: '', goals: [] })
    expect(p).toContain(reachTable())
    expect(p).toContain('Reichweite mal Passung')
    expect(p).toContain('Video-Plattformen')
    expect(p).not.toMatch(/[–—]/)
  })

  it('sortiert Plattformen nach Reichweite, Mastodon zuletzt', () => {
    const list = ['mastodon', 'bluesky', 'linkedin', 'unbekannt', 'x', 'instagram', 'facebook']
    expect(byReach(list, p => p)).toEqual(['facebook', 'instagram', 'x', 'linkedin', 'unbekannt', 'bluesky', 'mastodon'])
    expect(reachRank('twitter')).toBe(reachRank('x'))
    expect(reachRank('bsky')).toBe(reachRank('bluesky'))
    expect(byReach([{ k: 'a' }, { k: 'b' }], o => o.k).map(o => o.k)).toEqual(['a', 'b'])
  })
})
