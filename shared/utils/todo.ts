import type { TaskStatus } from './domain'
import { approveMinutes, INFO_BUNDLE_MIN, SELF_DEFAULT_MIN } from './time-budget'
import type { WhereKind } from './where'

// "Das ist zu tun": eine Anweisung aus Sicht des Menschen, ohne KI-Aufruf, nur aus Aufgabenart, Kanal, Status und Freigabe-Lage.

export type TodoMain = 'approve' | 'review' | 'answer' | 'copyOpen' | 'copy' | 'open' | 'check' | 'done' | 'send' | 'mailto' | 'edit' | 'none'
export type TodoOut = 'reply' | 'auto' | 'blog' | 'mail' | 'mailSelf' | 'self'

export interface TodoFacts {
  status: TaskStatus | string
  category: string
  draftKind?: string | null
  forClaude?: boolean
  owner?: 'agent' | 'human' | 'none'
  agentBusy?: boolean
  draft?: 'open' | 'approved' | 'gone' | null
  info?: boolean
  out: TodoOut
  route?: 'auto' | 'approve' | 'self' | null
  scheduledAt?: string | null
  running?: boolean
  platform?: string | null
  place?: string | null
  placeKind?: WhereKind | null
  missing?: boolean
  url?: string | null
  flair?: string | null
  flairRequired?: boolean
  waitDay?: number | null
  to?: string | null
  host?: string | null
  checkable?: boolean
  humanStep?: string | null
  estimateMin?: number | null
  doneAt?: string | null
  posted?: boolean
  sent?: boolean
  account?: string | null
  accountFree?: boolean
  sweep?: boolean
}

export interface Todo {
  key: string
  params: Record<string, string>
  text: string | null
  why: string | null
  whyParams: Record<string, string>
  min: number
  main: TodoMain
  at: string | null
  flair: string | null
  flairRequired: boolean
  waitDay: number | null
  doneAt: string | null
}

const IMPERATIVE = /^(melde|reiche|trag|trage|kopiere|poste|öffne|schreib|schreibe|lies|prüfe|gib|sende|schick|schicke|ruf|leg|lege|antworte|kommentiere|registriere|lade|füll|fülle|such|suche|frag|frage|bitte|log|sign|submit|open|copy|post|read|check|send|reply|create|register|upload|fill|ask|comment|add)(?=[\s,.:!]|$)/i
const PERSONAL = /(^|[\s(])(du|dich|dir|dein|deine|deinen|deinem|deiner|deines|you|your)(?=[\s,.:!)]|$)/i
const AGENT_VIEW = /(^|\s)(der agent|agent schreibt|ich (schreibe|erstelle|bereite)|claude code)(?=[\s,.:!]|$)/i

// Nur Sätze, die den Menschen direkt ansprechen ("Melde dich bei ... an"), nicht "Prüfen und selbst posten".
export function personalStep(s: string | null | undefined): boolean {
  const x = s?.trim()
  if (!x || x.length > 220 || x.includes('\n')) return false
  if (x.split(/\s+/).length < 5 || AGENT_VIEW.test(x)) return false
  return PERSONAL.test(x) || IMPERATIVE.test(x)
}

function sentence(s: string): string {
  const x = s.trim().replace(/\s+/g, ' ')
  return /[.!?)]$/.test(x) ? x : `${x}.`
}

const SELF_WHY: Record<string, string> = { verzeichnis: 'selfDirectory', community: 'selfCommunity', social: 'selfSocial', content: 'selfContent', outreach: 'selfOutreach', launch: 'selfLaunch', pflege: 'selfCare' }

export function todoOf(f: TodoFacts): Todo {
  const base = { params: {} as Record<string, string>, text: null, why: null, whyParams: {} as Record<string, string>, min: 0, main: 'none' as TodoMain, at: null, flair: null, flairRequired: false, waitDay: null, doneAt: null }
  const nothing = (key: string, extra: Partial<Todo> = {}): Todo => ({ ...base, key: `nothing.${key}`, ...extra })
  const platform = f.platform ?? ''
  if (f.status === 'verworfen') return nothing('dropped')
  if (f.status === 'erledigt' || f.status === 'ausgewertet' || ((f.posted || f.sent) && !!f.doneAt)) {
    const how = f.sent ? 'sent' : f.posted ? 'posted' : 'plain'
    return { ...base, key: f.doneAt ? `done.${how}` : 'done.any', doneAt: f.doneAt ?? null }
  }
  if (f.draft === 'gone') return nothing('gone')
  if (f.forClaude) return nothing('claude', { why: 'claude' })
  if (f.status === 'wartet') return nothing('waiting', { why: 'waiting' })
  if (f.info && f.draft === 'open') return { ...base, key: 'do.answer', why: 'info', min: INFO_BUNDLE_MIN, main: 'answer' }
  if (f.agentBusy && f.draft !== 'open') return nothing('writing')

  const approveMin = approveMinutes(f.draftKind, f.category)
  const selfPost = (): Todo => {
    const place = f.place?.trim() || null
    const main: TodoMain = f.url ? 'copyOpen' : 'copy'
    const extra = { flair: f.flair?.trim() || null, flairRequired: !!f.flairRequired }
    const min = f.draft === 'open' ? approveMin + 2 : 3
    if (f.missing && f.placeKind !== 'social') return { ...base, ...extra, key: 'do.whereMissing', why: 'manual', min, main: 'copy' }
    if (f.waitDay && place) return { ...base, ...extra, key: 'do.waitDay', params: { place }, why: 'waitDay', whyParams: { place }, waitDay: f.waitDay, min, main }
    const why = f.placeKind === 'community' ? 'community' : f.placeKind === 'social' ? (platform ? 'noAccount' : 'manual') : 'manual'
    const whyParams = { platform }
    const read = f.draft === 'open' ? 'Read' : ''
    if (f.placeKind === 'community') return { ...base, ...extra, key: place ? `do.postIn${read}` : `do.postCommunity${read}`, params: { place: place ?? '' }, why, whyParams, min, main }
    if (f.placeKind === 'directory') return { ...base, ...extra, key: place ? `do.directoryText${read}` : `do.directoryTextAny${read}`, params: { place: place ?? '' }, why: 'directoryText', min, main }
    if (f.placeKind === 'social') return { ...base, ...extra, key: platform ? `do.postOn${read}` : `do.postAny${read}`, params: { platform }, why, whyParams, min, main }
    if (f.placeKind === 'mail') return { ...base, key: 'do.mailSelf', params: { to: f.to ?? '' }, why: 'mail', min: approveMinutes('mail', f.category), main: 'mailto' }
    return { ...base, ...extra, key: place ? `do.publishOn${read}` : `do.publishAny${read}`, params: { place: place ?? '' }, why, whyParams, min, main }
  }

  if (f.draft === 'open') {
    if (f.out === 'reply') return { ...base, key: 'do.reply', params: { platform }, why: 'reply', min: approveMin, main: 'approve' }
    if (f.out === 'auto') return { ...base, key: platform ? 'do.approveAuto' : 'do.approveAutoAny', params: { platform }, why: 'approve', min: approveMin, main: 'approve', at: f.scheduledAt ?? null }
    if (f.out === 'blog') return { ...base, key: f.host ? 'do.approveBlog' : 'do.approveBlogAny', params: { host: f.host ?? '' }, why: 'approve', min: approveMin, main: 'approve' }
    if (f.out === 'mail') return { ...base, key: f.to ? 'do.mailSend' : 'do.mailSendAny', params: { to: f.to ?? '' }, why: 'mail', min: approveMinutes('mail', f.category), main: 'send' }
    if (f.out === 'mailSelf') return { ...base, key: f.to ? 'do.mailSelf' : 'do.mailSelfAny', params: { to: f.to ?? '' }, why: 'mail', min: approveMinutes('mail', f.category), main: 'mailto' }
    return selfPost()
  }

  if (f.draft === 'approved' || f.status === 'freigegeben') {
    if (f.out === 'reply') return nothing('reply', { params: { platform } })
    if (f.out === 'auto') {
      if (f.running) return nothing('posting', { params: { platform } })
      if (f.scheduledAt) return nothing('autoAt', { params: { platform }, at: f.scheduledAt })
      return nothing('auto', { params: { platform } })
    }
    if (f.out === 'blog') return f.scheduledAt ? nothing('blogAt', { params: { host: f.host ?? '' }, at: f.scheduledAt }) : nothing('blog', { params: { host: f.host ?? '' } })
    if (f.out === 'mail') return nothing('mail')
    if (f.draft === 'approved') return selfPost()
  }

  if (f.sweep && f.owner !== 'human') return nothing('sweep', { why: 'sweep' })
  if (f.status === 'geplant' && f.owner === 'agent') return f.route === 'auto' ? nothing('agentAuto') : nothing('agentDraft', { why: 'later' })
  if (f.owner === 'none') return { ...base, key: 'do.assign', why: 'assign', main: 'edit' }

  const min = f.estimateMin ?? SELF_DEFAULT_MIN
  const main: TodoMain = f.url ? 'open' : f.checkable ? 'check' : 'done'
  if (typeof f.account === 'string') {
    const key = !f.account ? 'do.accountAny' : f.accountFree ? 'do.accountFree' : 'do.account'
    return { ...base, key, params: { place: f.account }, why: 'account', min: f.estimateMin ?? 2, main }
  }
  const why = SELF_WHY[f.category] ?? null
  if (personalStep(f.humanStep)) return { ...base, key: 'do.text', text: sentence(f.humanStep!), why, min, main }
  const place = f.place?.trim() || null
  if (f.category === 'verzeichnis') return { ...base, key: place ? 'do.directory' : 'do.directoryAny', params: { place: place ?? '' }, why, min, main }
  if (f.category === 'community') return { ...base, key: place ? 'do.communityIn' : 'do.communityAny', params: { place: place ?? '' }, why, min, main }
  const step = f.humanStep?.trim().replace(/[.\s]+$/, '')
  if (step && step.length <= 80 && !step.includes('\n')) return { ...base, key: 'do.step', params: { step }, why, min, main }
  return { ...base, key: 'do.selfAny', why, min, main }
}
