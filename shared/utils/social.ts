export type MediaNeed = 'none' | 'image_or_video' | 'video'

export interface PlatformRule {
  label: string
  max: number
  maxWithMedia?: number
  media: MediaNeed
  hashtags: string
  auto: boolean
  note?: string
  maxMedia?: number
  maxVideos?: number
  imageTypes?: string[]
  soloVideo?: boolean
}

export const PLATFORM_RULES: Record<string, PlatformRule> = {
  x: { label: 'X', max: 280, media: 'none', hashtags: '0-2', auto: true, note: 'links' },
  bluesky: { label: 'Bluesky', max: 300, media: 'none', hashtags: '0-1', auto: true },
  threads: { label: 'Threads', max: 500, media: 'none', hashtags: '0-1', auto: true, maxMedia: 20, imageTypes: ['image/jpeg', 'image/png'] },
  linkedin: { label: 'LinkedIn', max: 3000, media: 'none', hashtags: '3-5', auto: true },
  facebook: { label: 'Facebook', max: 5000, media: 'none', hashtags: '0-3', auto: true, maxMedia: 10, soloVideo: true },
  mastodon: { label: 'Mastodon', max: 500, media: 'none', hashtags: '2-4', auto: true },
  instagram: { label: 'Instagram', max: 2200, media: 'image_or_video', hashtags: '5-10', auto: true, maxMedia: 10, imageTypes: ['image/jpeg'] },
  telegram: { label: 'Telegram', max: 4096, maxWithMedia: 1024, media: 'none', hashtags: '0-3', auto: true },
  tiktok: { label: 'TikTok', max: 2200, media: 'video', hashtags: '3-5', auto: true },
  youtube: { label: 'YouTube', max: 5000, media: 'video', hashtags: '2-3', auto: true, maxVideos: 1 },
  pinterest: { label: 'Pinterest', max: 800, media: 'image_or_video', hashtags: '0', auto: false, note: 'board' },
  reddit: { label: 'Reddit', max: 40000, media: 'none', hashtags: '0', auto: false, note: 'community' },
}

export function platformRule(p: string): PlatformRule {
  return PLATFORM_RULES[p.toLowerCase()] ?? { label: p, max: 2000, media: 'none', hashtags: '0-3', auto: false, note: 'unknown' }
}

export function postablePlatform(p: string): boolean {
  return platformRule(p).auto
}

export type PostIssue = 'too_long' | 'image_needed' | 'video_needed' | 'not_supported' | 'empty' | 'placeholder' | 'too_many_media' | 'media_format' | 'mixed_media'

export function textLength(text: string): number {
  return [...text].length
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url
    const path = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash
    return path.length > 15 ? `${u.host}${path.slice(0, 13)}...` : u.host + path
  }
  catch {
    return url
  }
}

export function shortLinks(text: string): string {
  return text.replace(/https?:\/\/[^\s)>\]]+/g, (m) => {
    const url = m.replace(/[.,;:!?]+$/, '')
    return shortUrl(url) + m.slice(url.length)
  })
}

export function postLength(platform: string, text: string): number {
  if (platform === 'x') return textLength(text.replace(/https?:\/\/\S+/g, 'x'.repeat(23)))
  if (platform === 'bluesky') return textLength(shortLinks(text))
  return textLength(text)
}

export function hasPlaceholder(text: string): boolean {
  return /\[[^\]\n]{2,80}\](?!\()|\{\{[^}\n]*\}\}|<(?:name|vorname|link|url|firma|company)>/i.test(text)
}

export function postIssues(platform: string, text: string, media: { mime: string }[]): PostIssue[] {
  const r = platformRule(platform)
  const out: PostIssue[] = []
  if (!r.auto) out.push('not_supported')
  if (!text.trim()) out.push('empty')
  if (hasPlaceholder(text)) out.push('placeholder')
  const hasVideo = media.some(m => m.mime.startsWith('video/'))
  const hasAny = media.length > 0
  if (postLength(platform, text) > (hasAny && r.maxWithMedia ? r.maxWithMedia : r.max)) out.push('too_long')
  if (r.media === 'video' && !hasVideo) out.push('video_needed')
  if (r.media === 'image_or_video' && !hasAny) out.push('image_needed')
  const videos = media.filter(m => m.mime.startsWith('video/')).length
  if ((r.maxMedia && media.length > r.maxMedia) || (r.maxVideos && videos > r.maxVideos)) out.push('too_many_media')
  if (r.imageTypes && media.some(m => m.mime.startsWith('image/') && !r.imageTypes!.includes(m.mime))) out.push('media_format')
  if (r.soloVideo && videos && media.length > 1) out.push('mixed_media')
  return out
}

export function textFor(platform: string, body: string, variants: Record<string, string> | null | undefined): string {
  const v = variants?.[platform]
  return v && v.trim() ? v : body
}

export function mediaNeed(platforms: string[]): MediaNeed {
  const needs = platforms.map(p => platformRule(p).media)
  if (needs.includes('video')) return 'video'
  if (needs.includes('image_or_video')) return 'image_or_video'
  return 'none'
}

export const POST_STATUSES = ['geplant', 'laeuft', 'gepostet', 'teilweise', 'fehler', 'trocken', 'abgebrochen'] as const
