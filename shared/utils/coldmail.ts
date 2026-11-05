import { safeHttpUrl } from './url'

export const COLD_MAIL_NOTE = 'Verworfen: keine Kaltmails.'
export const COLD_MAIL_TEXT = `${COLD_MAIL_NOTE} Werbemails ohne vorherige Einwilligung sind in Österreich (§ 174 TKG 2021) und Deutschland (§ 7 UWG) unzulässig, auch an Firmen. Mails gehen nur als Antwort auf eine eingegangene Mail oder an Adressen, die ausdrücklich um Einsendungen per Mail bitten; dann den Link zur Quelle als Ziel-Adresse oder Notiz vermerken.`
export const COLD_MAIL_RULE = 'Keine Kaltmails (§ 174 TKG 2021, § 7 UWG): Mails nur als Antwort auf eine eingegangene Mail oder an Adressen, die ausdrücklich um Einsendungen per Mail bitten (z.B. Kurator mit Einsende-Adresse, Redaktion mit Tipp-Adresse). Dann den Link zur Seite, auf der das steht, im Auftrag (brief) nennen. Sonst keine Mail-Aufgaben planen.'

const SUBMIT = /(einsend|einreich|zusend|submission|submit|pitch us|pitch to us|send us|send your|schick uns|schickt uns|sende uns|tipps? an|news ?tips?|tips?@|leserbrief|gastbeitr|guest post|write for us|für uns schreiben|demo-?(mail|adresse))/i
const URL_RE = /https?:\/\/[^\s<>"')\]]+/i

export interface MailTask {
  category: string
  draftKind: string | null
  title: string
  description?: string | null
  targetUrl?: string | null
}

export function mailRelevant(t: Pick<MailTask, 'category' | 'draftKind'>): boolean {
  return t.draftKind === 'mail' || t.category === 'outreach'
}

export function submissionSource(texts: (string | null | undefined)[], targetUrl?: string | null): string | null {
  const all = texts.filter(Boolean).join('\n')
  if (!SUBMIT.test(all)) return null
  return safeHttpUrl(targetUrl?.trim()) ?? URL_RE.exec(all)?.[0] ?? null
}

export function planAllowsMail(t: MailTask): boolean {
  return !mailRelevant(t) || !!submissionSource([t.title, t.description], t.targetUrl)
}
