import type { MailBlock, MailContent, MailLocale } from './layout'

export interface ClientLinkVars {
  sender: string
  project: string
  url: string
  expires?: string | null
}

export function clientLink(v: ClientLinkVars, locale: MailLocale): MailContent {
  const blocks: MailBlock[] = []
  if (locale === 'en') {
    blocks.push({ p: `${v.sender} would like your feedback on the planned posts for ${v.project}.` })
    blocks.push({ link: v.url, label: 'Review posts' })
    blocks.push({ small: `${v.expires ? `The link is valid until ${v.expires}. ` : ''}You can reply to this email with questions.` })
    return { subject: `Please review: posts for ${v.project}`, blocks }
  }
  blocks.push({ p: `${v.sender} bittet um deine Rückmeldung zu den geplanten Beiträgen für ${v.project}.` })
  blocks.push({ link: v.url, label: 'Beiträge ansehen' })
  blocks.push({ small: `${v.expires ? `Der Link gilt bis ${v.expires}. ` : ''}Bei Fragen einfach auf diese Mail antworten.` })
  return { subject: `Bitte ansehen: Beiträge für ${v.project}`, blocks }
}
