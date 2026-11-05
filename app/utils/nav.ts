import { ALL_SLUG } from '~~/shared/utils/domain'

export function projectSectionPath(path: string, slug: string): string {
  const m = /^\/p\/[^/]+(\/(kalender|aufgaben|freigaben|berichte|verlauf|agent|strategie|konten|einstellungen))?/.exec(path)
  if (m?.[2] === 'einstellungen' && slug === ALL_SLUG) return `/p/${slug}`
  return `/p/${slug}${m?.[1] ?? ''}`
}
