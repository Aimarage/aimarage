import { platformOf, taskListedPlatforms, type TaskShape } from './drafting'

// Gestrichene Plattformen eines Projekts (setup.blockedPlatforms). Alle Module fragen hier nach:
// Planung, Entwurf, Posten, Mitreden, Konten-Health und Tagesmail.

const ALIASES: Record<string, string> = {
  x: 'x', twitter: 'x', 'x.com': 'x', linkedin: 'linkedin', instagram: 'instagram', insta: 'instagram', ig: 'instagram',
  facebook: 'facebook', fb: 'facebook', meta: 'facebook', bluesky: 'bluesky', bsky: 'bluesky', mastodon: 'mastodon',
  threads: 'threads', tiktok: 'tiktok', youtube: 'youtube', yt: 'youtube', pinterest: 'pinterest', reddit: 'reddit', telegram: 'telegram',
}

export const BLOCKABLE_PLATFORMS = [...new Set(Object.values(ALIASES))]

export function platformKeyOf(raw: string | null | undefined): string | null {
  const w = (raw ?? '').trim().toLowerCase().replace(/^@/, '')
  return ALIASES[w] ?? null
}

type WithBlocked = { setup?: { blockedPlatforms?: string[] | null } | null } | null | undefined

export function blockedPlatforms(project: WithBlocked): string[] {
  return [...new Set((project?.setup?.blockedPlatforms ?? []).map(p => platformKeyOf(p) ?? p.toLowerCase()))]
}

export function isPlatformBlocked(project: WithBlocked, platform: string | null | undefined): boolean {
  if (!platform) return false
  const key = platformKeyOf(platform) ?? platform.toLowerCase()
  return blockedPlatforms(project).includes(key)
}

export function allowedPlatforms<T extends string>(project: WithBlocked, list: T[]): T[] {
  const blocked = blockedPlatforms(project)
  return blocked.length ? list.filter(p => !blocked.includes(platformKeyOf(p) ?? p.toLowerCase())) : list
}

export function blockRuleLine(label: string): string {
  return `Kein ${label}: gestrichen, nie vorschlagen, planen, posten oder melden.`
}

type BlockTask = Pick<TaskShape, 'channel' | 'targetUrl' | 'title' | 'category' | 'description' | 'channelPlaces'> & { origin?: string | null }

// Gestrichene Plattform, auf die eine Aufgabe ausschließlich zielt (Post, Antwort, Konto anlegen), sonst null.
export function taskBlockedPlatform(project: WithBlocked, t: BlockTask): string | null {
  const blocked = blockedPlatforms(project)
  if (!blocked.length) return null
  if (t.origin?.startsWith('setup:account:')) {
    const p = platformKeyOf(t.origin.slice('setup:account:'.length))
    return p && blocked.includes(p) ? p : null
  }
  const listed = t.category === 'social' ? taskListedPlatforms(t) : []
  if (listed.length) return listed.every(p => blocked.includes(p)) ? listed[0]! : null
  const one = platformOf(t)
  return one && blocked.includes(one) ? one : null
}
