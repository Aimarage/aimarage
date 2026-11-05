export type HelpLang = 'de' | 'en'

export interface HelpSection {
  id: string
  title: string
  path: string | null
  keywords: string[]
  hosted: boolean
  internal: boolean
  body: string
}

export interface HelpDoc {
  intro: string
  sections: HelpSection[]
}

const META = /^(stichworte|keywords|pfad|path|nur|only|öffentlich|oeffentlich|public):\s*(.*)$/i

export function parseHelp(md: string): HelpDoc {
  const sections: HelpSection[] = []
  const intro: string[] = []
  let cur: HelpSection | null = null
  for (const raw of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*\{#([a-z0-9-]+)\}\s*$/.exec(raw)
    if (h) {
      if (cur) sections.push(finish(cur))
      cur = { id: h[2]!, title: h[1]!.trim(), path: null, keywords: [], hosted: false, internal: false, body: '' }
      continue
    }
    if (!cur) {
      if (!/^#\s/.test(raw)) intro.push(raw)
      continue
    }
    const m = META.exec(raw.trim())
    if (m && !cur.body.trim()) {
      const key = m[1]!.toLowerCase()
      if (key === 'pfad' || key === 'path') cur.path = m[2]!.trim() || null
      else if (key === 'nur' || key === 'only') cur.hosted = /hosted/i.test(m[2]!)
      else if (key === 'public' || key.endsWith('ffentlich')) cur.internal = /^(nein|no|false)$/i.test(m[2]!.trim())
      else cur.keywords.push(...m[2]!.split(',').map(k => fold(k)).filter(Boolean))
      continue
    }
    cur.body += `${raw}\n`
  }
  if (cur) sections.push(finish(cur))
  return { intro: intro.join('\n').trim(), sections }
}

const INTERN = /^intern(al)?:\s*/i

export function agentBody(body: string): string {
  return body.split('\n').map(l => l.replace(INTERN, '')).join('\n')
}

export function publicBody(body: string): string {
  return body.split('\n').filter(l => !INTERN.test(l.trim())).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function agentDoc(doc: HelpDoc): HelpDoc {
  return { ...doc, sections: doc.sections.map(s => ({ ...s, body: agentBody(s.body) })) }
}

export function publicDoc(doc: HelpDoc): HelpDoc {
  return { ...doc, sections: doc.sections.filter(s => !s.internal).map(s => ({ ...s, body: publicBody(s.body) })) }
}

function finish(s: HelpSection): HelpSection {
  return { ...s, body: s.body.trim() }
}

export function fold(s: string): string {
  return s.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/['"„“”‚‘’`]/g, '')
    .replace(/[^a-z0-9/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function words(s: string): string[] {
  return fold(s).split(' ').filter(w => w.length > 2)
}

export function scoreSection(query: string, keywords: string[], title: string): number {
  const q = ` ${fold(query)} `
  if (!q.trim()) return 0
  let score = 0
  for (const k of keywords) {
    if (!k) continue
    if (q.includes(` ${k} `)) score += k.includes(' ') ? 4 : 3
    else if (k.length >= 5 && !k.includes(' ') && q.includes(` ${k}`)) score += 2
  }
  const qWords = new Set(words(query))
  for (const w of words(title)) if (qWords.has(w)) score += 1
  return score
}

export const HELP_MIN_SCORE = 3

export interface HelpPick { id: string, score: number }

export function pickHelp(query: string, docs: HelpDoc[], max = 2, min = HELP_MIN_SCORE): HelpPick[] {
  const byId = new Map<string, { keywords: string[], titles: string[] }>()
  for (const d of docs) {
    for (const s of d.sections) {
      const e = byId.get(s.id) ?? { keywords: [], titles: [] }
      e.keywords.push(...s.keywords)
      e.titles.push(s.title)
      byId.set(s.id, e)
    }
  }
  const order = [...byId.keys()]
  return order
    .map(id => ({ id, score: scoreSection(query, byId.get(id)!.keywords, byId.get(id)!.titles.join(' ')) }))
    .filter(p => p.score >= min)
    .sort((a, b) => b.score - a.score || order.indexOf(a.id) - order.indexOf(b.id))
    .slice(0, max)
}

const ASKS = /\?|^(was|wie|wo|wann|warum|wieso|weshalb|welche[rsnm]?|wofuer|wozu|kann ich|muss ich|darf ich|gibt es|erklaer|hilfe|what|how|where|when|why|which|can i|do i|is there|explain|help)\b/

export function looksLikeHelpQuestion(text: string): boolean {
  const t = text.trim().slice(0, 600)
  if (!t) return false
  return t.includes('?') || ASKS.test(fold(t))
}

export function helpPath(path: string | null, slug: string): string | null {
  return path ? path.replace(/<projekt>|<project>/g, slug) : null
}

export function renderSection(s: HelpSection, slug: string): string {
  const path = helpPath(s.path, slug)
  return helpPath([`### ${s.title}`, path ? `Link: ${path}` : '', s.body].filter(Boolean).join('\n'), slug)!
}

export type HelpInline = { t: 'text', v: string } | { t: 'code', v: string } | { t: 'link', v: string, href: string }
export type HelpBlock =
  | { t: 'p', parts: HelpInline[] }
  | { t: 'h', v: string, id: string }
  | { t: 'ul', items: HelpInline[][], start: number }
  | { t: 'ol', items: HelpInline[][], start: number }
  | { t: 'code', v: string }

const URL_RE = /https?:\/\/[^\s<>"'`]+/g

function links(text: string): HelpInline[] {
  const out: HelpInline[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)]+$/, '')
    const at = m.index!
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) })
    out.push({ t: 'link', v: url, href: url })
    last = at + url.length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

export function helpInline(text: string): HelpInline[] {
  const out: HelpInline[] = []
  text.split(/(`[^`]+`)/).forEach((part) => {
    if (!part) return
    if (/^`[^`]+`$/.test(part)) out.push({ t: 'code', v: part.slice(1, -1) })
    else out.push(...links(part))
  })
  return out
}

export function helpBlocks(body: string): HelpBlock[] {
  const blocks: HelpBlock[] = []
  let para: string[] = []
  let list: { t: 'ul' | 'ol', items: HelpInline[][], start: number } | null = null
  let code: string[] | null = null
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', parts: helpInline(para.join(' ')) })
    para = []
    if (list) blocks.push(list as HelpBlock)
    list = null
  }
  for (const raw of body.split(/\r?\n/)) {
    if (code) {
      if (/^```/.test(raw.trim())) {
        blocks.push({ t: 'code', v: code.join('\n') })
        code = null
      }
      else code.push(raw)
      continue
    }
    const line = raw.trim()
    if (/^```/.test(line)) {
      flush()
      code = []
      continue
    }
    if (!line) {
      flush()
      continue
    }
    const h = /^#{3,4}\s+(.+)$/.exec(line)
    if (h) {
      flush()
      blocks.push({ t: 'h', v: h[1]!, id: fold(h[1]!).replace(/ /g, '-') })
      continue
    }
    const li = /^(?:([-*])|(\d+)\.)\s+(.+)$/.exec(line)
    if (li) {
      const kind = li[1] ? 'ul' : 'ol'
      if (para.length || (list && list.t !== kind)) flush()
      list ??= { t: kind, items: [], start: Number(li[2] ?? 1) }
      list.items.push(helpInline(li[3]!))
      continue
    }
    if (list) {
      const items = list.items
      items[items.length - 1]!.push(...helpInline(` ${line}`))
      continue
    }
    para.push(line)
  }
  if (code) blocks.push({ t: 'code', v: code.join('\n') })
  flush()
  return blocks
}

export function helpPlain(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{3,4}\s+.*$/gm, ' ')
    .replace(/^(?:[-*]|\d+\.)\s+/gm, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function helpExcerpt(body: string, max = 160): string {
  const text = helpPlain(body)
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '))
  if (end > 60) return cut.slice(0, end + 1)
  return `${cut.slice(0, cut.lastIndexOf(' '))} ...`
}

export const HELP_SITE = 'https://aimarage.com'

export function helpBaseUrl(appUrl: string, lang: HelpLang, hosted: boolean): string {
  return `${hosted ? HELP_SITE : appUrl.replace(/\/+$/, '')}${lang === 'en' ? '/en/help' : '/hilfe'}`
}

export function withAppUrl(md: string, appUrl: string, helpUrl = `${appUrl.replace(/\/+$/, '')}/hilfe`): string {
  return md.replace(/\{APP_URL\}/g, appUrl.replace(/\/+$/, '')).replace(/\{HELP_URL\}/g, helpUrl)
}

export function helpSectionUrl(appUrl: string, id: string | null, lang: HelpLang, ext = ''): string {
  return `${appUrl}/hilfe${id ? `/${id}` : ''}${ext}${lang === 'en' ? '?lang=en' : ''}`
}

export type HelpUrl = (id: string | null, ext?: string) => string

export function helpMarkdown(doc: HelpDoc, url: HelpUrl, lang: HelpLang, id?: string): string | null {
  const title = lang === 'en' ? 'Aimarage help' : 'Aimarage-Hilfe'
  if (id) {
    const s = doc.sections.find(x => x.id === id)
    if (!s) return null
    const more = lang === 'en' ? 'All help topics' : 'Alle Hilfe-Themen'
    return `# ${s.title}\n\n${s.body}\n\n${more}: ${url(null, '.md')}\n`
  }
  const parts = doc.sections.map(s => `## ${s.title}\n\n${url(s.id)}\n\n${s.body}`)
  return `# ${title}\n\n${doc.intro}\n\n${parts.join('\n\n')}\n`
}
