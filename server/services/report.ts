import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { addDays } from '../../shared/utils/dates'
import { today } from '../lib/clock'
import type { Db } from '../lib/db'
import { schema } from '../lib/db'
import { latestGeo } from '../lib/geo'
import { listGoals } from '../lib/goals'
import { loadHistory } from '../lib/history'
import { listeningSummary } from '../lib/listening'
import { searchSummary } from '../lib/search-console'
import { statsConfigured, utmSummary } from '../lib/traffic'

type Workspace = typeof schema.workspaces.$inferSelect
type Project = typeof schema.projects.$inferSelect

export type ReportLang = 'de' | 'en'

export interface WeeklyReport {
  project: { name: string, url: string | null }
  from: string
  to: string
  published: { day: string, title: string, links: { label: string, url: string }[] }[]
  social: { metric: string, value: number }[]
  traffic: { visits: number, signups: number, purchases: number } | null
  search: { clicks: number, impressions: number, position: number | null } | null
  geo: { mentioned: number, asked: number, week: string } | null
  listening?: { replies: number, clicks: number } | null
  goals: { label: string, current: number, target: number | null, pct: number, state: string, deadline: string | null }[]
  next: { day: string, time: string | null, title: string, channel: string | null }[]
}

const SOCIAL_ORDER = ['reach', 'likes', 'comments', 'shares', 'clicks']

export async function buildWeeklyReport(db: Db, ws: Workspace, project: Project, opts: { days?: number } = {}): Promise<WeeklyReport> {
  const d = today(ws.timezone)
  const days = opts.days ?? 7
  const to = addDays(d, -1)
  const from = addDays(d, -days)
  const history = await loadHistory(db, { workspaceId: ws.id, scope: eq(schema.tasks.projectId, project.id), from, to, timezone: ws.timezone })
  const ids = [...new Set(history.entries.map(e => e.taskId))]
  const socialRows = ids.length
    ? await db.select({ metric: schema.results.metric, total: sql<number>`sum(${schema.results.value})::float` }).from(schema.results)
      .where(and(inArray(schema.results.taskId, ids), eq(schema.results.source, 'social'))).groupBy(schema.results.metric)
    : []
  const social = socialRows.filter(r => SOCIAL_ORDER.includes(r.metric)).sort((a, b) => SOCIAL_ORDER.indexOf(a.metric) - SOCIAL_ORDER.indexOf(b.metric)).map(r => ({ metric: r.metric, value: Math.round(r.total) }))
  const utm = statsConfigured(project.setup?.stats) ? await utmSummary(db, ws.id, [project.id], from, to) : null
  const search = project.setup?.google?.property || project.setup?.bing?.site ? await searchSummary(db, project.id, from, to) : null
  const geo = await latestGeo(db, project.id)
  const listening = await listeningSummary(db, project.id, from, to, ws.timezone)
  const goals = await listGoals(db, ws.id, d, { projectId: project.id })
  const next = await db.select({ day: schema.tasks.dueDate, time: schema.tasks.dueTime, title: schema.tasks.title, channel: schema.tasks.channel }).from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, project.id), sql`${schema.tasks.dueDate} between ${d} and ${addDays(d, 6)}`, notInArray(schema.tasks.status, ['verworfen', 'erledigt', 'ausgewertet']), sql`${schema.tasks.category} <> 'bericht'`, sql`coalesce(${schema.tasks.origin}, '') not like 'setup:%'`))
    .orderBy(schema.tasks.dueDate, schema.tasks.dueTime).limit(40)
  return {
    project: { name: project.name, url: project.url },
    from,
    to,
    published: history.entries.map(e => ({ day: e.day, title: e.title, links: e.links.map(l => ({ label: l.label, url: l.url })) })),
    social,
    traffic: utm ? { visits: utm.totals.visits, signups: utm.totals.signups, purchases: utm.totals.purchases } : null,
    search: search && (search.clicks || search.impressions) ? { clicks: search.clicks, impressions: search.impressions, position: search.position } : null,
    geo: geo?.summary.asked ? { mentioned: geo.summary.mentioned, asked: geo.summary.asked, week: geo.week } : null,
    listening,
    goals: goals.map(g => ({ label: g.label, current: g.progress.current, target: g.targetValue, pct: g.progress.pct, state: g.progress.state, deadline: g.deadline })),
    next: next.map(n => ({ day: n.day!, time: n.time, title: n.title, channel: n.channel })),
  }
}

const T = {
  de: {
    title: 'Wochenbericht',
    period: 'Zeitraum',
    published: 'Veröffentlicht',
    none: 'Nichts in diesem Zeitraum.',
    metrics: 'Kennzahlen',
    social: 'Social Media',
    traffic: 'Besucher über Kampagnen-Links (UTM)',
    visits: 'Besuche',
    signups: 'Anmeldungen',
    purchases: 'Käufe',
    search: 'Suche (Google, Bing)',
    clicks: 'Klicks',
    impressions: 'Impressionen',
    position: 'Ø Position',
    geo: 'KI-Sichtbarkeit',
    geoLine: 'In {m} von {a} KI-Antworten genannt (Woche ab {w})',
    listening: 'Antworten auf Social Listening',
    replies: 'Antworten',
    noMetrics: 'Noch keine Zahlen.',
    goals: 'Ziele',
    noGoals: 'Keine Ziele hinterlegt.',
    until: 'bis',
    next: 'Nächste Woche geplant',
    noNext: 'Noch nichts geplant.',
    print: 'Drucken / Als PDF speichern',
    created: 'Erstellt mit Aimarage',
    states: { done: 'erreicht', on_track: 'im Plan', behind: 'im Rückstand', open: 'offen' } as Record<string, string>,
    metric: { reach: 'Reichweite', likes: 'Likes', comments: 'Kommentare', shares: 'Geteilt', clicks: 'Klicks' } as Record<string, string>,
    locale: 'de-AT',
  },
  en: {
    title: 'Weekly report',
    period: 'Period',
    published: 'Published',
    none: 'Nothing in this period.',
    metrics: 'Metrics',
    social: 'Social media',
    traffic: 'Visitors via campaign links (UTM)',
    visits: 'Visits',
    signups: 'Sign-ups',
    purchases: 'Purchases',
    search: 'Search (Google, Bing)',
    clicks: 'Clicks',
    impressions: 'Impressions',
    position: 'Avg. position',
    geo: 'AI visibility',
    geoLine: 'Mentioned in {m} of {a} AI answers (week of {w})',
    listening: 'Social listening replies',
    replies: 'Replies',
    noMetrics: 'No numbers yet.',
    goals: 'Goals',
    noGoals: 'No goals set.',
    until: 'by',
    next: 'Planned for next week',
    noNext: 'Nothing planned yet.',
    print: 'Print / Save as PDF',
    created: 'Created with Aimarage',
    states: { done: 'reached', on_track: 'on track', behind: 'behind', open: 'open' } as Record<string, string>,
    metric: { reach: 'Reach', likes: 'Likes', comments: 'Comments', shares: 'Shares', clicks: 'Clicks' } as Record<string, string>,
    locale: 'en-GB',
  },
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function safeUrl(u: string): string | null {
  try {
    const x = new URL(u)
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : null
  }
  catch {
    return null
  }
}

export function renderReportHtml(r: WeeklyReport, lang: ReportLang = 'de', opts: { brand?: string } = {}): string {
  const t = T[lang]
  const num = (n: number) => new Intl.NumberFormat(t.locale).format(n)
  const day = (iso: string) => new Intl.DateTimeFormat(t.locale, { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`))
  const long = (iso: string) => new Intl.DateTimeFormat(t.locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`))
  const kv = (label: string, value: string) => `<div class="kv"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`
  const published = r.published.length
    ? `<ul class="list">${r.published.map(p => `<li><span class="d">${esc(day(p.day))}</span><span class="g">${esc(p.title)}${p.links.length ? `<span class="links">${p.links.map((l) => {
      const u = safeUrl(l.url)
      return u ? `<a href="${esc(u)}">${esc(l.label)}</a>` : esc(l.label)
    }).join(' · ')}</span>` : ''}</span></li>`).join('')}</ul>`
    : `<p class="empty">${t.none}</p>`
  const blocks: string[] = []
  if (r.social.length) blocks.push(`<div class="block" data-k="social"><h3>${t.social}</h3>${r.social.map(s => kv(t.metric[s.metric] ?? s.metric, num(s.value))).join('')}</div>`)
  if (r.traffic) blocks.push(`<div class="block" data-k="utm"><h3>${t.traffic}</h3>${kv(t.visits, num(r.traffic.visits))}${kv(t.signups, num(r.traffic.signups))}${kv(t.purchases, num(r.traffic.purchases))}</div>`)
  if (r.search) blocks.push(`<div class="block" data-k="search"><h3>${t.search}</h3>${kv(t.clicks, num(r.search.clicks))}${kv(t.impressions, num(r.search.impressions))}${r.search.position ? kv(t.position, String(r.search.position)) : ''}</div>`)
  if (r.geo) blocks.push(`<div class="block" data-k="geo"><h3>${t.geo}</h3><p>${esc(t.geoLine.replace('{m}', String(r.geo.mentioned)).replace('{a}', String(r.geo.asked)).replace('{w}', day(r.geo.week)))}</p></div>`)
  if (r.listening) blocks.push(`<div class="block" data-k="listening"><h3>${t.listening}</h3>${kv(t.replies, num(r.listening.replies))}${kv(t.clicks, num(r.listening.clicks))}</div>`)
  const goals = r.goals.length
    ? `<ul class="list">${r.goals.map(g => `<li><span class="g">${esc(g.label)}<span class="bar"><span style="width:${Math.max(0, Math.min(100, g.pct))}%"></span></span></span><span class="v">${esc(num(g.current))}${g.target !== null ? ` / ${esc(num(g.target))}` : ''} · ${esc(t.states[g.state] ?? g.state)}${g.deadline ? ` · ${t.until} ${esc(day(g.deadline))}` : ''}</span></li>`).join('')}</ul>`
    : `<p class="empty">${t.noGoals}</p>`
  const next = r.next.length
    ? `<ul class="list">${r.next.map(n => `<li><span class="d">${esc(day(n.day))}${n.time ? ` ${esc(n.time)}` : ''}</span><span class="g">${esc(n.title)}${n.channel ? ` <span class="muted">· ${esc(n.channel)}</span>` : ''}</span></li>`).join('')}</ul>`
    : `<p class="empty">${t.noNext}</p>`
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${esc(t.title)} - ${esc(r.project.name)} - ${esc(r.from)}</title>
<style>
@font-face { font-family: 'Familjen Grotesk'; font-style: normal; font-weight: 400 700; font-display: swap; src: url('/fonts/familjen-grotesk-latin-wght-normal.woff2') format('woff2'); }
:root { --bg: #ffffff; --text: #1a2433; --muted: #535e6d; --line: #dfe3e0; --accent: #1d5e4a; --soft: #f7f8f5; }
@media (prefers-color-scheme: dark) { :root { --bg: #121b2a; --text: #eef2f7; --muted: #a9b4c3; --line: #2a374b; --accent: #74cfa9; --soft: #1b2739; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 'Familjen Grotesk', 'IBM Plex Sans', system-ui, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 1px solid var(--line); padding-bottom: 16px; }
h1 { margin: 0; font-size: 22px; font-weight: 600; }
h2 { margin: 28px 0 10px; font-size: 15px; font-weight: 600; }
h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--muted); }
p { margin: 0; }
.sub { color: var(--muted); margin-top: 4px; }
.print { flex: none; border: 1px solid var(--line); background: var(--soft); color: var(--text); border-radius: 6px; padding: 8px 12px; font: inherit; cursor: pointer; }
.list { list-style: none; margin: 0; padding: 0; }
.list li { display: flex; gap: 12px; padding: 7px 0; border-top: 1px solid var(--line); }
.list li:first-child { border-top: 0; }
.d { flex: none; width: 116px; color: var(--muted); }
.g { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.v { flex: none; color: var(--muted); text-align: right; }
.links { display: block; font-size: 12px; }
a { color: var(--accent); text-underline-offset: 3px; }
.muted, .empty { color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.block { border: 1px solid var(--line); border-radius: 8px; padding: 12px; break-inside: avoid; }
.kv { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
.kv strong { font-weight: 600; font-variant-numeric: tabular-nums; }
.bar { display: block; height: 4px; margin-top: 6px; background: var(--line); border-radius: 2px; overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--accent); }
footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
@media (max-width: 480px) {
  header { flex-direction: column; }
  .list li { flex-wrap: wrap; gap: 2px 12px; }
  .d { width: auto; }
  .v { text-align: left; }
}
@media print {
  :root { --bg: #ffffff; --text: #000000; --muted: #444444; --line: #cccccc; --accent: #1d5e4a; --soft: #ffffff; }
  @page { size: A4; margin: 16mm 14mm; }
  main { max-width: none; padding: 0; }
  .print { display: none; }
  h2 { break-after: avoid; }
  .list li { break-inside: avoid; }
}
</style>
</head>
<body>
<main>
<header>
<div>
<h1>${esc(t.title)}: ${esc(r.project.name)}</h1>
<p class="sub" data-k="period">${t.period}: ${esc(long(r.from))} - ${esc(long(r.to))}</p>
</div>
<button class="print" type="button" onclick="window.print()">${t.print}</button>
</header>
<section data-k="published"><h2>${t.published} (${r.published.length})</h2>${published}</section>
<section data-k="metrics"><h2>${t.metrics}</h2>${blocks.length ? `<div class="grid">${blocks.join('')}</div>` : `<p class="empty">${t.noMetrics}</p>`}</section>
<section data-k="goals"><h2>${t.goals}</h2>${goals}</section>
<section data-k="next"><h2>${t.next}</h2>${next}</section>
<footer>${opts.brand ? esc(opts.brand) : t.created}${r.project.url ? ` · ${esc(r.project.url.replace(/^https?:\/\//, ''))}` : ''}</footer>
</main>
</body>
</html>
`
}

export function reportHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': 'default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-hashes\' \'sha256-MguIPR6qNR8D3B+eAlK+bIRTZe8t3wkOY4B/56Me9FU=\'; img-src \'self\'; frame-ancestors \'none\'',
  }
}
