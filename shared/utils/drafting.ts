import { oldReleaseHit, releaseHitText, type ReleaseFocus } from './release-focus'
import { hasPlaceholder, platformRule, postLength } from './social'

export const RESEARCH_PREFIX = 'Recherche-Ergebnis:'

const THREAD_ASK = /\b(threads?|subreddits?|forenbeitr\w*|reddit-?(post|beitrag)\w*)\b|(^|[\s(])r\/\w+|\b(link|url|titel|title)\b.{0,60}\b(beitrag\w*|diskussion\w*|forum|foren\w*)\b/i

export function asksForThread(text: string): boolean {
  return THREAD_ASK.test(text)
}

export type TaskType = 'research' | 'pitch' | 'reply' | 'post' | 'mail' | 'article' | 'directory' | 'text'

export interface TaskShape {
  title: string
  description?: string | null
  category: string
  channel?: string | null
  draftKind?: string | null
  agentStep?: string | null
  targetUrl?: string | null
  channelPlaces?: string[] | null
}

export function taskType(t: TaskShape): TaskType {
  const title = t.title.trim()
  if (/^(recherche|research|analyse|scan|sichten|monitoring)\b/i.test(title)) return 'research'
  // Ein Blog-Artikel bleibt ein Artikel, auch wenn der Titel noch "Antwort: ..." heißt (z.B. nach dem Umstellen).
  if (t.draftKind === 'article' || (t.category === 'content' && t.draftKind !== 'mail')) return 'article'
  if (/^nachfass|^follow.?up|^re:|^antwort an\b/i.test(title)) return t.draftKind === 'mail' ? 'mail' : 'reply'
  if (/\bpitch/i.test(title)) return 'pitch'
  if (/^(antwort|reply)\b/i.test(title)) return 'reply'
  if (/\b(recherch|research)/i.test(title) && !/antwort|beitrag|post\b/i.test(title)) return 'research'
  if (t.category === 'outreach' && t.draftKind === 'mail') return 'pitch'
  if (t.draftKind === 'mail') return 'mail'
  if (/\bantwort\b|\breply\b/i.test(title)) return 'reply'
  if (t.category === 'verzeichnis') return 'directory'
  if (t.draftKind === 'article' || t.category === 'content') return 'article'
  if (t.draftKind === 'post' || t.category === 'social' || t.category === 'community') return 'post'
  return 'text'
}

export function needsThread(t: TaskShape): boolean {
  return platformOf(t) === 'reddit' && taskType(t) === 'reply'
}

export function needsTitle(type: TaskType, platform: PlatformKey | null | undefined): boolean {
  return type === 'post' && (platform === 'reddit' || platform === 'forum')
}

export function splitPostTitle(body: string): { title: string, body: string } | null {
  const m = /^\s*([^\n]{3,220})\n\s*\n([\s\S]+)$/.exec(body)
  if (!m) return null
  const line = m[1]!.trim()
  const marked = /^(?:#+\s*|\*\*)?(?:titel|title)\s*:\s*(.+?)(?:\*\*)?$/i.exec(line) ?? /^#+\s+(.+)$/.exec(line) ?? /^\*\*(.+)\*\*$/.exec(line)
  const title = marked?.[1]?.replace(/\*\*/g, '').trim()
  if (!title || title.length > 200 || /https?:\/\//.test(title)) return null
  return { title, body: m[2]!.trim() }
}

export function kindFor(type: TaskType, fallback: string | null | undefined): 'post' | 'mail' | 'article' | 'text' {
  if (type === 'research' || type === 'directory') return 'text'
  if (type === 'pitch' || type === 'mail') return 'mail'
  if (type === 'post' || type === 'reply') return 'post'
  if (type === 'article') return 'article'
  return fallback === 'post' || fallback === 'mail' || fallback === 'article' ? fallback : 'text'
}

export type PlatformKey = 'instagram' | 'x' | 'linkedin' | 'bluesky' | 'mastodon' | 'threads' | 'facebook' | 'tiktok' | 'telegram' | 'youtube' | 'reddit' | 'forum'

const NAMED: [PlatformKey, RegExp][] = [
  ['instagram', /instagram/i],
  ['linkedin', /linkedin/i],
  ['bluesky', /bluesky|bsky\.app/i],
  ['mastodon', /mastodon|fosstodon|mstdn/i],
  ['threads', /threads\.net|\bThreads\b/],
  ['facebook', /facebook/i],
  ['tiktok', /tiktok/i],
  ['telegram', /telegram|(^|[\s/])t\.me\//i],
  ['youtube', /youtube/i],
  ['x', /twitter|x\.com|(^|[\s/(,+&])X(?=$|[\s,)+/&@.;:])/],
]
const NEGATED = /\b(?:nicht|kein\w*|ohne|au(?:ß|ss)er|not|no|without|except)\s+(?:(?:auf|on|f(?:ü|ue)r|for|in|bei)\s+)?[^\s,.;]+/gi

export function namedPlatforms(text: string | null | undefined): PlatformKey[] {
  const s = (text ?? '').replace(NEGATED, ' ')
  if (/reddit|(^|\s)r\/\w+/i.test(s)) return []
  return NAMED.filter(([, re]) => re.test(s)).map(([p]) => p)
}

export function listedPlatforms(channel: string | null | undefined): PlatformKey[] {
  const named = namedPlatforms(channel)
  return named.length >= 2 ? named : []
}

// Plattformen, die eine Social-Aufgabe ausdrücklich nennt: Titel mit mindestens zwei Plattformen hat Vorrang, dann Kanal samt Orten des Strategie-Kanals, sonst Titel, sonst Beschreibung.
export function taskListedPlatforms(t: Pick<TaskShape, 'channel' | 'title' | 'description' | 'channelPlaces'>): PlatformKey[] {
  const title = namedPlatforms(t.title)
  if (title.length >= 2) return title
  const places = (t.channelPlaces ?? []).flatMap(p => namedPlatforms(p))
  if (places.length) {
    const all = [...new Set([...namedPlatforms(t.channel), ...places])]
    if (all.length >= 2) return NAMED.map(([p]) => p).filter(p => all.includes(p))
  }
  for (const text of [t.channel, t.title, t.description]) {
    const named = namedPlatforms(text)
    if (named.length >= 2) return named
    if (named.length === 1 || /reddit|(^|\s)r\/\w+/i.test(text ?? '')) return []
  }
  return []
}

export function platformOf(t: Pick<TaskShape, 'channel' | 'targetUrl' | 'title' | 'category' | 'description' | 'channelPlaces'>): PlatformKey | null {
  if (t.category === 'social' && taskListedPlatforms(t).length) return null
  const s = `${t.channel ?? ''} ${t.targetUrl ?? ''} ${t.title}`
  if (/instagram/i.test(s)) return 'instagram'
  if (/linkedin/i.test(s)) return 'linkedin'
  if (/bluesky|bsky\.app/i.test(s)) return 'bluesky'
  if (/mastodon|fosstodon|mstdn|\.social\/@/i.test(s)) return 'mastodon'
  if (/threads\.net|\bthreads\b/i.test(s)) return 'threads'
  if (/facebook/i.test(s)) return 'facebook'
  if (/tiktok/i.test(s)) return 'tiktok'
  if (/telegram|(^|[\s/])t\.me\//i.test(s)) return 'telegram'
  if (/youtube/i.test(s)) return 'youtube'
  if (/reddit|(^|\s)r\/\w+/i.test(s)) return 'reddit'
  if (/twitter|x\.com|(^|[\s/])X(\s|$|@|\/)/.test(s)) return 'x'
  if (t.category === 'community') return 'forum'
  return null
}

export function markOf(t: Pick<TaskShape, 'channel' | 'targetUrl' | 'title' | 'category' | 'draftKind'>): PlatformKey | 'mail' | null {
  return t.draftKind === 'mail' ? 'mail' : platformOf(t)
}

export const PLATFORM_STYLE: Record<PlatformKey, string> = {
  instagram: 'Instagram: Kein Link in der Caption (dort nicht klickbar), stattdessen kurz "Link in Bio". Erste Zeile muss tragen. Hashtags (5-10) gesammelt am Ende, nicht im Fließtext. Braucht ein Bild oder Video.',
  x: 'X: höchstens 280 Zeichen, KEIN Link und keine Domain (kostet ca. 13-mal mehr), "Link in bio" ist ok. Ein Gedanke, kein Thread, höchstens 1-2 Hashtags.',
  linkedin: 'LinkedIn: sachlich-persönlicher Ton aus Ich-Sicht, Erfahrung oder Erkenntnis statt Werbung, kurze Absätze, keine Clickbait-Einstiege, 3-5 Hashtags am Ende.',
  bluesky: 'Bluesky: höchstens 300 Zeichen inklusive Link, locker und direkt, höchstens 1 Hashtag.',
  mastodon: 'Mastodon: höchstens 500 Zeichen, unaufgeregt, kein Marketing-Sprech; 2-4 Hashtags in CamelCase am Ende (werden dort zum Finden genutzt).',
  threads: 'Threads: höchstens 500 Zeichen, gesprächig, höchstens 1 Hashtag.',
  facebook: 'Facebook: kurz, persönlich, Link am Ende, höchstens 3 Hashtags.',
  tiktok: 'TikTok: Beschreibung zum Video, kurz, 3-5 Hashtags am Ende.',
  telegram: 'Telegram-Kanal: liest nur, wer den Kanal schon abonniert hat (Fans, Kunden), keine Reichweite für Neue. Persönlich und direkt wie eine Nachricht an Stammkunden, gern Neuigkeiten, Hintergründe oder Vorab-Infos. Kurze Absätze, Link im Text (wird als Vorschau gezeigt), 0-3 Hashtags. Mit Bild höchstens 1024 Zeichen.',
  youtube: 'YouTube: Beschreibung zum Video, erste 2 Zeilen tragen, Link danach.',
  reddit: 'Reddit: Kein Marketing-Ton, keine Hashtags, keine Emojis, kein Call-to-Action. Erst echter Mehrwert für die Diskussion, Produkt höchstens am Rand. Offenlegung (dass du dahinter stehst) einmal, knapp, mit eigenen Worten. Subreddit-Regeln zur Eigenwerbung beachten. Grundwissen: Flair ist oft Pflicht; Eigenwerbung oft nur an bestimmten Tagen oder in Megathreads; Faustregel 9:1 (höchstens jeder zehnte Beitrag über Eigenes); Links zum eigenen Produkt meist unerwünscht; Titel sachlich, kein Clickbait; nicht dasselbe in mehreren Subreddits gleichzeitig; neue Konten mit wenig Karma werden oft gefiltert.',
  forum: 'Forum/Community: hilfreich und konkret, kein Werbeton, keine Hashtags. Offenlegung einmal, knapp, mit eigenen Worten.',
}

export const LINK_PLATFORMS: string[] = ['mastodon', 'bluesky', 'linkedin', 'facebook', 'threads', 'telegram']
export const BIO_PLATFORMS: string[] = ['instagram', 'tiktok', 'x']

export const HASHTAG_RANGE: Record<string, [number, number]> = { mastodon: [2, 4], bluesky: [0, 1], x: [0, 2] }

export function hashtagCount(text: string): number {
  return (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length
}

export function needsDisclosure(type: TaskType, category: string): boolean {
  return category === 'community' && (type === 'post' || type === 'reply')
}

const DISCLOSURE_RE = /full disclosure|disclosure:|\bi(?:'m| am) the (?:developer|dev|founder|maker|creator)\b|\bich bin (?:der )?(?:entwickler|gründer)/i

export function firstSentence(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l && !/^(hi|hey|hello|hallo)\b[^.!?]{0,30}[,!]?$/i.test(l)) ?? ''
  const m = line.match(/^.{20,140}?[.!?](?=\s|$)/)
  return (m ? m[0] : line).slice(0, 140)
}

export function normText(s: string): string {
  return s.toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function words(s: string): string[] {
  return normText(s).split(' ').filter(Boolean)
}

export function sentences(text: string): string[] {
  return text.replace(/https?:\/\/\S+/g, ' ').split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => words(s).length >= 4)
}

export function sameOpening(a: string, b: string): boolean {
  const x = words(firstSentence(a)).slice(0, 4).join(' ')
  const y = words(firstSentence(b)).slice(0, 4).join(' ')
  return !!x && x.split(' ').length >= 3 && x === y
}

export function repeatedPhrases(recent: string[], min = 2): string[] {
  const count = new Map<string, { n: number, raw: string }>()
  for (const r of recent) {
    const seen = new Set<string>()
    for (const s of sentences(r)) {
      const k = normText(s)
      if (seen.has(k)) continue
      seen.add(k)
      const c = count.get(k)
      count.set(k, { n: (c?.n ?? 0) + 1, raw: c?.raw ?? s })
    }
  }
  return [...count.values()].filter(c => c.n >= min).sort((a, b) => b.n - a.n).map(c => c.raw).slice(0, 8)
}

export function quotedTerms(text: string): string[] {
  return [...text.matchAll(/["„“]([^"„“”\n]{3,60})["”“]/g)].map(m => m[1]!.trim())
}

const QUOTE_RE = /["„“]([^"„“”\n]{3,60})["”“]/g
const BAN_RE = /\b(?:never|nie|nicht|no|not|neither|nor|don't|do not|avoid|vermeiden|taboo|tabu|kein\w*|verboten|forbidden|banned)\b/i
const REQUIRE_RE = /\b(?:brand|always|immer|must|muss|required|pflicht)\b/i

interface RuleSegment { text: string, quotes: { term: string, before: string }[] }

function ruleSegments(line: string): RuleSegment[] {
  const masked = line.replace(/https?:\/\/\S+/g, m => ' '.repeat(m.length)).replace(QUOTE_RE, m => `"${'_'.repeat(m.length - 2)}"`)
  const quotes = [...line.matchAll(QUOTE_RE)].map(m => ({ term: m[1]!.trim(), at: m.index! }))
  const out: RuleSegment[] = []
  let start = 0
  for (const end of [...[...masked.matchAll(/[.!?](?=\s|$)/g)].map(m => m.index! + 1), masked.length]) {
    if (end <= start) continue
    const text = masked.slice(start, end)
    out.push({ text, quotes: quotes.filter(q => q.at >= start && q.at < end).map(q => ({ term: q.term, before: masked.slice(start, q.at) })) })
    start = end
  }
  return out
}

export function ruleRequired(text: string | null | undefined): string[] {
  if (!text) return []
  const out = new Set<string>()
  for (const line of text.split('\n')) {
    for (const seg of ruleSegments(line)) {
      for (const q of seg.quotes) {
        if (!BAN_RE.test(q.before) && REQUIRE_RE.test(q.before)) out.add(q.term)
      }
    }
  }
  return [...out]
}

export function ruleTerms(text: string | null | undefined): string[] {
  if (!text) return []
  const out = new Set<string>()
  for (const line of text.split('\n')) {
    for (const seg of ruleSegments(line)) {
      for (const q of seg.quotes) {
        if (BAN_RE.test(q.before)) out.add(q.term)
      }
      if (!/taboo|tabu|never name|never mention|nie nennen|nie erwähnen|no location|kein ort/i.test(seg.text)) continue
      const after = seg.text.includes(':') ? seg.text.slice(seg.text.indexOf(':') + 1) : seg.text
      for (let item of after.split(/,|;/)) {
        item = item.replace(/["„“”._]/g, '').replace(/^\s*(never|nie)\s+(name|mention|nennen|erwähnen)?\s*/i, '').replace(/\s+(or|oder)\s+(other|andere|any|jede).*$/i, '').trim()
        for (const part of item.split('/')) {
          const p = part.trim()
          if (p.length >= 3 && p.split(/\s+/).length <= 3 && !/^(any|other|genre|never|no|or|and|it|link|the|oder|und)\b/i.test(p)) out.add(p)
        }
      }
    }
  }
  const req = new Set(ruleRequired(text).map(t => t.toLowerCase()))
  return [...out].filter(t => !req.has(t.toLowerCase()))
}

export interface CheckInput {
  type: TaskType
  category: string
  kind: string
  subject?: string | null
  body: string
  variants?: Record<string, string> | null
  platform: PlatformKey | null
  recent: string[]
  rules?: string | null
  avoid?: string[]
  link?: string | null
  platforms?: string[]
  release?: ReleaseFocus | null
}

export type CheckCode = 'placeholder' | 'repeated_opening' | 'repeated_phrase' | 'instagram_link' | 'too_long' | 'rule_term' | 'research_format' | 'wrong_kind' | 'disclosure_misplaced' | 'missing_subject' | 'missing_link' | 'link_in_bio' | 'belittling' | 'hashtags' | 'missing_variant' | 'missing_title' | 'old_release'

export interface CheckIssue {
  code: CheckCode
  text: string
}

const ISSUE_TEXT: Record<CheckCode, string> = {
  placeholder: 'Platzhalter in eckigen Klammern',
  repeated_opening: 'Einstieg wie in einem der letzten Entwürfe',
  repeated_phrase: 'Formulierung wiederholt sich aus den letzten Entwürfen',
  instagram_link: 'Link in der Instagram-Caption (nicht klickbar, "Link in Bio" verwenden)',
  too_long: 'Text zu lang für die Plattform',
  rule_term: 'Begriff, den die Projekt-Regeln oder Fakten verbieten',
  research_format: 'Recherche-Aufgabe, aber kein Rechercheergebnis (Fundstellen mit Link und Kurzbewertung)',
  wrong_kind: 'Falsche Art für den Aufgabentyp',
  disclosure_misplaced: 'Entwickler-Offenlegung auf eigenem Kanal unnötig',
  missing_subject: 'Betreff fehlt',
  missing_link: 'Link fehlt im Text (auf dieser Plattform gehört der Link direkt in den Beitrag)',
  link_in_bio: '"Link in bio/profile" auf einer Plattform, die Links im Text erlaubt (Link direkt einfügen)',
  belittling: 'Redet das Produkt klein (Größe oder Stand nicht betonen, Nutzen zeigen)',
  hashtags: 'Anzahl Hashtags passt nicht zur Plattform',
  missing_variant: 'Fassung für eine Plattform fehlt',
  missing_title: 'Titel für den neuen Beitrag fehlt (Feld subject)',
  old_release: 'Nennt ein älteres Release statt des aktuellen (aktuelles Release zuerst, älteres nur auf ausdrücklichen Wunsch)',
}

export function issueLabel(i: CheckIssue): string {
  return i.text ? `${ISSUE_TEXT[i.code]}: ${i.text}` : ISSUE_TEXT[i.code]
}

const URL_RE = /https?:\/\/\S+|\b(?:www\.)?[a-z0-9-]+\.(?:com|net|org|io|ai|de|at|app|fm|me)\/\S*/i
const BIO_RE = /\blinks? (?:is |are )?(?:in|im) (?:(?:the|my|our|unserem|meinem) )?(?:bio|profile|profil)\b|\b(?:see|check) (?:the |my |our )?(?:bio|profile)\b/i
const BELITTLE_RE = /\b(?:small|tiny|modest|humble|little) (?:but growing )?(?:catalog(?:ue)?|collection|selection|project|store|shop|library)\b|\bearly[- ]stage\b|\bjust (?:getting )?started\b|\bstill (?:small|tiny|early)\b|\bkleine[nrs]? (?:katalog|auswahl|projekt|shop)\b|\bnoch (?:ganz )?am anfang\b|\bnoch (?:klein|jung)\b/i

function linkHost(link: string | null | undefined): string | null {
  try {
    return link ? new URL(link).host.replace(/^www\./, '').toLowerCase() : null
  }
  catch {
    return null
  }
}

export function platformTexts(i: Pick<CheckInput, 'body' | 'variants' | 'platform' | 'platforms'>): [string, string][] {
  const out: [string, string][] = Object.entries(i.variants ?? {}).filter(([, v]) => v.trim())
  for (const p of [i.platform, ...(i.platforms ?? [])]) {
    if (p && p !== 'forum' && !out.some(([x]) => x === p)) out.push([p, i.body])
  }
  return out
}

export function checkDraft(i: CheckInput): CheckIssue[] {
  const out: CheckIssue[] = []
  const texts = [i.subject ?? '', i.body, ...Object.values(i.variants ?? {})]
  const all = texts.join('\n')
  const ph = all.match(/\[[^\]\n]{2,80}\](?!\()/)
  if (hasPlaceholder(all)) out.push({ code: 'placeholder', text: ph?.[0] ?? '' })
  const rel = i.recent.filter(r => r.trim())
  const hit = rel.find(r => sameOpening(r, i.body))
  if (hit) out.push({ code: 'repeated_opening', text: firstSentence(i.body).slice(0, 80) })
  const mine = new Set(sentences(i.body).map(normText))
  const reps = repeatedPhrases(rel, 2).filter(p => mine.has(normText(p)))
  if (reps.length) out.push({ code: 'repeated_phrase', text: reps[0]!.slice(0, 80) })
  const ig = i.variants?.instagram?.trim() ? i.variants.instagram : i.platform === 'instagram' || i.platforms?.includes('instagram') ? i.body : null
  if (ig && URL_RE.test(ig)) out.push({ code: 'instagram_link', text: '' })
  const per = i.kind === 'article' ? [] : platformTexts(i)
  for (const [p, text] of per) {
    const max = platformRule(p).max
    const len = postLength(p, text)
    if (len > max) out.push({ code: 'too_long', text: `${platformRule(p).label} ${len} Zeichen, max. ${max}` })
  }
  const social = i.type === 'post' && i.category === 'social'
  if (social) {
    const host = linkHost(i.link)
    for (const [p, text] of per) {
      if (!LINK_PLATFORMS.includes(p)) continue
      if (BIO_RE.test(text)) out.push({ code: 'link_in_bio', text: platformRule(p).label })
      else if (host && !text.toLowerCase().includes(host) && !/https?:\/\/\S+/i.test(text)) out.push({ code: 'missing_link', text: platformRule(p).label })
    }
    for (const [p, text] of per) {
      const range = HASHTAG_RANGE[p]
      const n = hashtagCount(text)
      if (range && (n < range[0] || n > range[1])) out.push({ code: 'hashtags', text: `${platformRule(p).label} ${n}, erlaubt ${range[0]}-${range[1]}` })
    }
    const lacking = (i.platforms ?? []).filter(p => i.platforms!.length > 1 && !i.variants?.[p]?.trim())
    if (lacking.length) out.push({ code: 'missing_variant', text: lacking.map(p => platformRule(p).label).join(', ') })
    const small = all.match(BELITTLE_RE)
    if (small) out.push({ code: 'belittling', text: small[0] })
  }
  const lower = all.toLowerCase()
  const terms = [...ruleTerms(i.rules), ...(i.avoid ?? []).flatMap(quotedTerms)]
  const bad = terms.find(t => new RegExp(`(^|[^\\p{L}])${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(lower))
  if (bad) out.push({ code: 'rule_term', text: bad })
  const old = oldReleaseHit(all, i.release)
  if (old && i.release) out.push({ code: 'old_release', text: releaseHitText(old, i.release) })
  if (i.type === 'research') {
    const links = (i.body.match(/https?:\/\/\S+/g) ?? []).length
    const list = /^\s*(\d+[.)]|[-*•])\s+/m.test(i.body)
    if (!links || !list || /^\s*(hi|hey|hello|hallo)\b/i.test(i.body)) out.push({ code: 'research_format', text: '' })
  }
  if ((i.type === 'pitch' || i.type === 'mail') && i.kind !== 'mail') out.push({ code: 'wrong_kind', text: 'Mail erwartet' })
  if (i.type === 'research' && i.kind === 'post') out.push({ code: 'wrong_kind', text: 'Rechercheergebnis erwartet, kein Post' })
  if ((i.type === 'pitch' || i.type === 'mail') && i.kind === 'mail' && !i.subject?.trim()) out.push({ code: 'missing_subject', text: '' })
  if (needsTitle(i.type, i.platform) && !i.subject?.trim()) out.push({ code: 'missing_title', text: '' })
  if (i.category === 'social' && DISCLOSURE_RE.test(i.body)) out.push({ code: 'disclosure_misplaced', text: (i.body.match(DISCLOSURE_RE)?.[0] ?? '') })
  return out
}

export function stripInstagramLinks(text: string, lang = 'en'): string {
  const bio = lang.startsWith('de') ? 'Link im Profil.' : 'Link in bio.'
  const src = text.split('\n')
  const kept: string[] = []
  for (let i = 0; i < src.length; i++) {
    const line = src[i]!
    const urlOnly = /^\s*https?:\/\/\S+\s*$/.test(line)
    if (urlOnly) {
      if (kept.length && /:\s*$/.test(kept[kept.length - 1]!)) kept.pop()
      continue
    }
    kept.push(line.replace(/\s*https?:\/\/\S+/g, '').replace(/\s+$/, ''))
  }
  let out = kept.filter((l, i, a) => !(l.trim() === '' && (i === 0 || a[i - 1]!.trim() === ''))).join('\n').trim()
  if (!/link in (bio|profile)|link im profil/i.test(out)) {
    const tags = out.match(/\n\s*(#[\p{L}\p{N}_]+\s*)+$/u)
    out = tags ? `${out.slice(0, tags.index).trim()}\n\n${bio}\n\n${tags[0].trim()}` : `${out}\n\n${bio}`
  }
  return out
}
