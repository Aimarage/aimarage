export function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  }
  catch {
    return false
  }
}

export function safeHttpUrl(value: string | null | undefined): string | null {
  return value && isHttpUrl(value) ? value : null
}

export type TextPart = { text: string, href: string | null }

export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = []
  const re = /https?:\/\/[^\s<>"')\]]+/g
  let last = 0
  for (const m of text.matchAll(re)) {
    let url = m[0]
    const trail = /[.,;:!?]+$/.exec(url)
    if (trail) url = url.slice(0, -trail[0].length)
    const href = safeHttpUrl(url)
    if (!href) continue
    if (m.index > last) parts.push({ text: text.slice(last, m.index), href: null })
    parts.push({ text: url, href })
    last = m.index + url.length
  }
  if (last < text.length) parts.push({ text: text.slice(last), href: null })
  return parts
}
