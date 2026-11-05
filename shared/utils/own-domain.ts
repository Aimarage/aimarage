const TLDS = ['com', 'net', 'org', 'info', 'site', 'de', 'at', 'ch', 'eu', 'io', 'app', 'dev', 'ai', 'co', 'me', 'biz']

export interface OwnDomain {
  brand: string
  tld: string
  host: string
}

export function ownDomain(url: string | null | undefined): OwnDomain | null {
  if (!url) return null
  let host: string
  try {
    host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '')
  }
  catch {
    return null
  }
  const i = host.lastIndexOf('.')
  if (i <= 0) return null
  const brand = host.slice(0, i)
  const tld = host.slice(i + 1)
  if (brand.length < 3 || brand.includes('.') || !/^[a-z0-9-]+$/.test(brand)) return null
  return { brand, tld, host }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Eigene Domain mit falscher Endung (linkbox.com statt linkbox.net) auf die geprüfte Projekt-Website umschreiben.
export function fixOwnDomain(text: string, url: string | null | undefined): string {
  const d = ownDomain(url)
  if (!d || !text) return text
  const wrong = TLDS.filter(t => t !== d.tld)
  const re = new RegExp(`(?<!\\b(?:nicht|nie|not|never|statt|instead of)\\s+)(?<![\\w.-])((?:www\\.)?)${escapeRe(d.brand)}\\.(${wrong.join('|')})(?![\\w-])`, 'gi')
  return text.replace(re, (_m, www: string) => `${www}${d.brand}.${d.tld}`)
}

export function hasWrongOwnDomain(text: string, url: string | null | undefined): boolean {
  return fixOwnDomain(text, url) !== text
}
