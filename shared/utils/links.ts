import { PLATFORM_RULES } from './social'

export interface TaskLink {
  platform: string | null
  url: string
  postedAt: string
}

export function linkLabel(platform: string | null, url: string): string {
  if (platform && PLATFORM_RULES[platform.toLowerCase()]) return PLATFORM_RULES[platform.toLowerCase()]!.label
  const blog = /^blog:([a-z]{2})$/i.exec(platform ?? '')
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    }
    catch {
      return url
    }
  })()
  if (blog) return `${host} ${blog[1]!.toUpperCase()}`
  return platform || host
}
