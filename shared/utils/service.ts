import { taskWhere, type WhereTask } from './where'

export interface TaskService {
  name: string
  what: string | null
  why: string | null
  cost: string | null
  account: 'neu' | 'vorhanden'
  register: string | null
  steps: string[]
  url: string | null
  fits: boolean
  fitReason: string | null
  checkedAt: string
}

export type ServiceTask = WhereTask & { humanStep: string | null, forClaude?: boolean | null }

const SUBMIT_CATEGORIES = ['verzeichnis', 'launch']

export function isForeignTask(t: ServiceTask): boolean {
  if (!t.humanStep?.trim() || t.forClaude || t.draftKind === 'mail') return false
  // Artikel und Blog-Aufgaben reicht niemand bei einem Dienst ein, auch wenn der Kanal wie ein fremder Ort klingt ("SEO & Ratgeber").
  if (t.draftKind === 'article' || t.category === 'content') return false
  if (SUBMIT_CATEGORIES.includes(t.category)) return true
  const w = taskWhere(t)
  return (w.kind === 'community' && w.mark === 'forum') || w.kind === 'external'
}

export function needsSubmitUrl(t: Pick<ServiceTask, 'category'>): boolean {
  return SUBMIT_CATEGORIES.includes(t.category)
}

export const SERVICE_RECHECK_DAYS = 7

export function needsServiceCheck(t: ServiceTask & { service?: TaskService | null }, at: Date): boolean {
  if (!isForeignTask(t)) return false
  const s = t.service
  if (!s) return true
  if (s.url || t.targetUrl || !needsSubmitUrl(t)) return false
  return at.getTime() - new Date(s.checkedAt).getTime() > SERVICE_RECHECK_DAYS * 86_400_000
}

export function serviceName(t: Pick<ServiceTask, 'title' | 'channel'>, generic: string[] = []): string {
  const ch = t.channel?.trim()
  if (ch && !generic.some(g => g.toLowerCase() === ch.toLowerCase())) return ch
  const after = t.title.split(':').slice(1).join(':').trim()
  return (after || t.title).replace(/\s*\(.*\)$/, '').trim()
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ACCOUNT_WORD = /konto|account|login|log-in|eingeloggt|registriert|profil|zugang/i

export function accountKnown(name: string, texts: string[], platforms: string[] = []): boolean {
  const n = name.trim().toLowerCase()
  if (!n) return false
  if (platforms.some(p => p.toLowerCase() === n || n.startsWith(`${p.toLowerCase()} `))) return true
  const re = new RegExp(`(^|[^\\p{L}\\d])${escapeRe(n)}([^\\p{L}\\d]|$)`, 'iu')
  return texts.some(x => re.test(x) && ACCOUNT_WORD.test(x) && !/kein(e|en)?\s+(konto|account)/i.test(x))
}

const LOGIN = /einlogg|log\s?in|anmelden mit deinem|mit deinem konto|mit deinem account/i
const REGISTER = /registrier|konto anlegen|konto erstellen|account anlegen|sign\s?up|neues konto/i

export function cleanSteps(steps: string[], known: boolean, register: string | null): string[] {
  const out = steps.map(s => s.replace(/[\u2013\u2014]/g, '-').trim()).filter(Boolean)
  const fixed = known ? out : out.map(s => (LOGIN.test(s) && !REGISTER.test(s) ? `Konto anlegen${register ? ` (${register})` : ''}` : s))
  return [...new Set(fixed)].slice(0, 3)
}
