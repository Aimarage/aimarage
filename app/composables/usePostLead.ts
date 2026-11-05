import { postErrorText } from '~~/shared/utils/post-errors'

export interface PostLeadInput {
  status: string
  platform: string
  hasAccount: boolean
  live: boolean
  at: string | null
  post: { status: string, scheduledAt: string, updatedAt?: string | null, error: string | null } | null
}

export interface PostLead {
  text: string
  warn: boolean
  switch: boolean
}

export function usePostLead() {
  const { t, locale } = useI18n()
  const { dm, time, isoDay } = useFormat()

  return (i: PostLeadInput): PostLead | null => {
    const p = i.post
    const platform = i.platform
    const at = (iso: string) => ({ day: dm(isoDay(iso)), time: time(iso), platform })
    const lead = (text: string, warn = false, sw = false): PostLead => ({ text, warn, switch: sw })
    if ((i.status === 'erledigt' || i.status === 'ausgewertet') && (p?.status === 'gepostet' || p?.status === 'teilweise')) return lead(t('outlet.lead.posted', { platform }))
    if (p?.status === 'fehler' && !['erledigt', 'ausgewertet', 'verworfen'].includes(i.status)) return lead(t('outlet.lead.failed', { error: p.error ? postErrorText(p.error, locale.value === 'en' ? 'en' : 'de') : '-' }), true)
    if (i.status !== 'freigegeben') return null
    if (!i.hasAccount) return platform ? lead(t('outlet.lead.noAccount', { platform }), true) : null
    if (p?.status === 'laeuft') return lead(t('outlet.lead.running', { platform }))
    if (p?.status === 'geplant') return i.live ? lead(t('outlet.lead.planned', at(p.scheduledAt))) : lead(t('outlet.lead.plannedDry', at(p.scheduledAt)), true, true)
    if (p?.status === 'trocken') return lead(t('outlet.lead.dry', at(p.updatedAt ?? p.scheduledAt)), true, !i.live)
    if (i.at && new Date(i.at).getTime() <= Date.now()) return i.live ? lead(t('outlet.lead.missed'), true) : lead(t('outlet.lead.offline'), true, true)
    return lead(t('outlet.lead.ready', { platform }))
  }
}
