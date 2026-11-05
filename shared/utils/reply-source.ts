import { parseMailDesc } from './digest'
import { parseRedditNote } from './reddit'

// Worauf eine Antwort sich bezieht: steht in der Aufgaben-Beschreibung (Listening, Mail, Link)
// bzw. in der Reddit-Thread-Notiz und wird über dem Entwurf gezeigt.

export type SourceRelation = 'reply' | 'reaction' | 'mention' | 'search' | 'conversation' | 'mail' | 'thread' | 'link'

export interface SourceParent {
  author: string | null
  ours: boolean
  at: string | null
  text: string
  url: string | null
}

export interface ReplySource {
  relation: SourceRelation
  author: string | null
  at: string | null
  age: string | null
  title: string | null
  sub: string | null
  text: string
  url: string | null
  parent: SourceParent | null
}

export interface ListenSourceInput {
  kind: 'search' | 'mention' | 'conversation'
  author: string
  text: string
  url: string
  at: string
  sub?: string | null
  parent?: SourceParent | null
}

function clean(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').replace(/[\u2013\u2014]/g, '-').trim()
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t
}

function stamp(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isNaN(t) ? '' : `, am ${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function unstamp(s: string | undefined): string | null {
  return s ? `${s.replace(' ', 'T')}:00.000Z` : null
}

export function listenSourceLines(h: ListenSourceInput): string[] {
  const p = h.parent ?? null
  const head = h.kind === 'conversation'
    ? `Beitrag zum Mitreden von @${h.author}`
    : h.kind === 'search'
    ? `Passender Post (Social Listening) von @${h.author}${h.sub ? ` in r/${h.sub}` : ''}`
    : p?.ours
      ? `@${h.author} hat auf unseren Beitrag${p.text ? ` "${clean(p.text, 80)}"` : ''} geantwortet`
      : p ? `@${h.author} hat auf einen Beitrag${p.author ? ` von @${p.author}` : ''} geantwortet und uns erwähnt` : `@${h.author} hat uns erwähnt`
  const lines = [`${head}${stamp(h.at)}:`, `"${clean(h.text, 1500)}"`, h.url]
  if (p && (p.text || p.url)) lines.push(`Davor: ${p.author ? `@${p.author}` : 'unbekannt'}${p.ours ? ', unser Beitrag' : ''}${stamp(p.at)}: "${clean(p.text, 400)}"${p.url ? ` ${p.url}` : ''}`)
  return lines
}

const CONVO_HEAD = /^Beitrag zum Mitreden von @(\S+?)(?:, am (\d{4}-\d\d-\d\d \d\d:\d\d) UTC)?:$/
const NEW_HEAD = /^(?:Passender Post \(Social Listening\) von @(\S+?)(?: in r\/(\S+))?|@(\S+) hat (auf unseren Beitrag|auf einen Beitrag|uns erwähnt)[^\n]*?)(?:, am (\d{4}-\d\d-\d\d \d\d:\d\d) UTC)?:$/
const OLD_HEAD = /^(Reaktion auf einen eigenen Beitrag|Passender Post \(Social Listening\)) von @(\S+?)(?: in r\/(\S+))?, (?:vor (\d+) (Std\.|Tagen)|Alter unbekannt):$/
const PARENT = /^Davor: (?:@(\S+)|unbekannt)(, unser Beitrag)?(?:, am (\d{4}-\d\d-\d\d \d\d:\d\d) UTC)?: "(.*)"(?: (https?:\/\/\S+))?$/

function quoted(s: string | undefined): string {
  const t = (s ?? '').trim()
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1) : t
}

export function isNewListenDesc(desc: string | null | undefined): boolean {
  const head = desc?.split('\n')[0] ?? ''
  return !!desc && (NEW_HEAD.test(head) || CONVO_HEAD.test(head))
}

export function parseListenDesc(desc: string | null | undefined, createdAt?: string | null): ReplySource | null {
  if (!desc) return null
  const lines = desc.split('\n')
  const head = lines[0] ?? ''
  const url = /^https?:\/\/\S+$/.test(lines[2]?.trim() ?? '') ? lines[2]!.trim() : null
  const c = CONVO_HEAD.exec(head)
  if (c) return { relation: 'conversation', author: c[1] ?? null, at: unstamp(c[2]), age: null, title: null, sub: null, text: quoted(lines[1]), url, parent: null }
  const n = NEW_HEAD.exec(head)
  if (n) {
    const pm = lines.map(l => PARENT.exec(l)).find(Boolean) ?? null
    const parent: SourceParent | null = pm ? { author: pm[1] ?? null, ours: !!pm[2], at: unstamp(pm[3]), text: pm[4] ?? '', url: pm[5] ?? null } : null
    const relation: SourceRelation = n[1] ? 'search' : n[4] === 'uns erwähnt' ? 'mention' : n[4] === 'auf unseren Beitrag' ? 'reply' : 'mention'
    return { relation, author: n[1] ?? n[3] ?? null, at: unstamp(n[5]), age: null, title: null, sub: n[2] ?? null, text: quoted(lines[1]), url, parent }
  }
  const o = OLD_HEAD.exec(head)
  if (!o) return null
  let at: string | null = null
  const base = createdAt ? Date.parse(createdAt) : Number.NaN
  if (o[4] && !Number.isNaN(base)) at = new Date(base - Number(o[4]) * (o[5] === 'Std.' ? 3_600_000 : 86_400_000)).toISOString()
  return { relation: o[1] === 'Passender Post (Social Listening)' ? 'search' : 'reaction', author: o[2] ?? null, at, age: null, title: null, sub: o[3] ?? null, text: quoted(lines[1]), url, parent: null }
}

function linkSource(desc: string, title: string | null | undefined): ReplySource | null {
  const m = /^Link: (https?:\/\/\S+)\n[\s\S]*?Inhalt \(Auszug\):\n([\s\S]*)$/.exec(desc)
  if (!m || /^Seite nicht lesbar/.test(m[2]!)) return null
  const t = title?.replace(/^Antwort: /, '').trim() || null
  return { relation: 'link', author: null, at: null, age: null, title: t, sub: null, text: clean(m[2]!, 600), url: m[1]!, parent: null }
}

export function replySourceOf(o: {
  description: string | null | undefined
  createdAt?: string | Date | null
  title?: string | null
  notes?: { text: string, byAgent: boolean, createdAt: string | Date }[]
  notesSince?: string | Date | null
  mailDate?: string | null
}): ReplySource | null {
  const desc = o.description?.trim() ?? ''
  const created = o.createdAt ? new Date(o.createdAt).toISOString() : null
  const listen = parseListenDesc(desc, created)
  if (listen) return listen
  const mail = parseMailDesc(desc)
  if (mail) return { relation: 'mail', author: mail.who || mail.from, at: o.mailDate ?? null, age: null, title: mail.subject || null, sub: null, text: mail.body, url: null, parent: null }
  const since = o.notesSince ? new Date(o.notesSince).getTime() - 2000 : 0
  const notes = [...(o.notes ?? [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  for (const n of notes) {
    if (!n.byAgent || new Date(n.createdAt).getTime() < since) continue
    const r = parseRedditNote(n.text)
    if (r?.kind === 'thread') {
      const sub = /reddit\.com\/r\/([^/]+)/.exec(r.url)?.[1] ?? null
      return { relation: 'thread', author: null, at: null, age: r.age ?? null, title: r.title, sub, text: r.excerpt, url: r.url, parent: null }
    }
  }
  return desc ? linkSource(desc, o.title) : null
}

// Rest der Beschreibung ohne die Zeilen, die der Bezugs-Block schon zeigt.
export function sourceRest(desc: string | null | undefined, src: ReplySource | null): string {
  const d = desc?.trim() ?? ''
  if (!src || !d) return d
  if (src.relation === 'link') return d.split('\n').filter(l => l.startsWith('Wunsch: ')).join('\n')
  if (src.relation === 'mail' || src.relation === 'thread') return d
  const lines = d.split('\n')
  return lines.slice(src.url ? 3 : 2).filter(l => !PARENT.test(l)).join('\n').trim()
}
