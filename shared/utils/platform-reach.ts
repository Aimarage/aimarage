// Reichweite der Plattformen, Stand Herbst 2026, monatlich aktive Nutzer in Mio. (gerundet, öffentliche Angaben der Anbieter und Branchenzahlen).
export interface PlatformReach {
  key: string
  label: string
  users: number
  note: string
  video?: boolean
  re: RegExp
}

export const PLATFORM_REACH: PlatformReach[] = [
  { key: 'facebook', label: 'Facebook', users: 3000, note: 'über 3 Mrd. monatlich', re: /facebook|\bfb\b/i },
  { key: 'instagram', label: 'Instagram', users: 3000, note: '3 Mrd. monatlich, Reels', video: true, re: /instagram|\breels?\b/i },
  { key: 'youtube', label: 'YouTube', users: 2700, note: '2,7 Mrd. monatlich, Shorts', video: true, re: /youtube|\bshorts\b/i },
  { key: 'tiktok', label: 'TikTok', users: 2000, note: 'ca. 2 Mrd. monatlich (mit Douyin)', video: true, re: /tiktok/i },
  { key: 'telegram', label: 'Telegram', users: 1000, note: 'über 1 Mrd. monatlich, eher für bestehende Fans', re: /telegram|(^|[\s/])t\.me\//i },
  { key: 'pinterest', label: 'Pinterest', users: 600, note: 'ca. 600 Mio. monatlich', re: /pinterest/i },
  { key: 'x', label: 'X', users: 550, note: 'ca. 550 Mio. monatlich', re: /twitter|x\.com|(^|[\s/(,+&])X(?=$|[\s,)+/&@.;:])/ },
  { key: 'reddit', label: 'Reddit', users: 515, note: 'ca. 515 Mio. pro Woche', re: /reddit|(^|[\s(])r\/\w+/i },
  { key: 'threads', label: 'Threads', users: 500, note: 'ca. 500 Mio. monatlich', re: /threads\.net|\bThreads\b/ },
  { key: 'linkedin', label: 'LinkedIn', users: 300, note: 'ca. 1,2 Mrd. Mitglieder, ca. 300 Mio. monatlich aktiv, B2B', re: /linkedin/i },
  { key: 'discord', label: 'Discord', users: 200, note: 'über 200 Mio. monatlich', re: /discord/i },
  { key: 'bluesky', label: 'Bluesky', users: 10, note: 'ca. 10 Mio. aktiv', re: /bluesky|bsky\.app/i },
  { key: 'mastodon', label: 'Mastodon', users: 1, note: 'unter 1 Mio. aktiv', re: /mastodon|fosstodon|mstdn/i },
]

export type ReachTier = 'big' | 'niche'

export const BIG_REACH = 200

export function reachTier(users: number): ReachTier {
  return users >= BIG_REACH ? 'big' : 'niche'
}

export function platformsIn(text: string): PlatformReach[] {
  return PLATFORM_REACH.filter(p => p.re.test(text))
}

// Kanal mit erkannter Plattform: große Reichweite, wenn eine genannte Plattform groß ist, sonst Nische.
export function channelReach(c: { name: string, category?: string, places?: string[] }): ReachTier | null {
  if (c.category && !['social', 'community'].includes(c.category)) return null
  const found = platformsIn([c.name, ...(c.places ?? [])].join('\n'))
  if (!found.length) return null
  return found.some(p => reachTier(p.users) === 'big') ? 'big' : 'niche'
}

export function reachTable(): string {
  return [
    'Reichweite der Plattformen (Stand Herbst 2026, Nutzer gerundet):',
    ...PLATFORM_REACH.map(p => `- ${p.label}: ${p.note}${reachTier(p.users) === 'niche' ? ' (Nische)' : ''}`),
  ].join('\n')
}

export const REACH_RULE = [
  'Kanäle nach Reichweite mal Passung zur Zielgruppe wählen (Marketing 1x1: dort hingehen, wo die meisten Leute der Zielgruppe sind).',
  'Der größte Teil der Arbeit (höchste Stufen) geht in die 2-3 Plattformen mit der größten Reichweite, auf denen die Zielgruppe wirklich ist.',
  `Kleine Plattformen (unter ${BIG_REACH} Mio., z.B. Bluesky, Mastodon) nur nebenbei mit kleiner Stufe und nur bei klarer Nischen-Passung; in why dann "Nische" nennen, sonst "große Reichweite".`,
  'Bei Musik stehen Video-Plattformen ganz vorn (Instagram Reels, TikTok, YouTube Shorts).',
].join(' ')

const REACH_ALIAS: Record<string, string> = { twitter: 'x', bsky: 'bluesky', meta: 'facebook', fb: 'facebook', ig: 'instagram', yt: 'youtube' }

// Rang nach Reichweite (0 = größte); unbekannte Plattformen stehen vor Bluesky und Mastodon.
export function reachRank(key: string): number {
  const k = key.toLowerCase()
  const i = PLATFORM_REACH.findIndex(p => p.key === (REACH_ALIAS[k] ?? k))
  return i >= 0 ? i : PLATFORM_REACH.length - 2.5
}

export function byReach<T>(list: readonly T[], key: (t: T) => string): T[] {
  return list.map((t, i) => ({ t, i, r: reachRank(key(t)) })).sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.t)
}
