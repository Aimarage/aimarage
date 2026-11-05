import type { MailBlock, MailContent, MailLocale } from './layout'

export interface GenericNoticeVars {
  subject: string
  body: string
  name?: string
  actionUrl?: string
  actionLabel?: string
  // Abmeldelink (Tagesmail), steht klein am Ende.
  unsubscribeUrl?: string
}

export function genericNotice(v: GenericNoticeVars, locale: MailLocale): MailContent {
  const blocks: MailBlock[] = []
  if (v.name) blocks.push({ p: locale === 'en' ? `Hi ${v.name},` : `Hallo ${v.name},` })
  for (const part of v.body.split(/\r?\n\s*\r?\n/).map(s => s.trim()).filter(Boolean)) blocks.push(/^## [^\n]+$/.test(part) ? { h: part.slice(3).trim() } : { p: part })
  if (v.actionUrl && /^https?:\/\//.test(v.actionUrl)) blocks.push({ link: v.actionUrl, label: v.actionLabel || (locale === 'en' ? 'Open Aimarage' : 'Aimarage öffnen') })
  if (v.unsubscribeUrl && /^https?:\/\//.test(v.unsubscribeUrl)) blocks.push({ small: locale === 'en' ? `Don't want this daily mail? Unsubscribe: ${v.unsubscribeUrl}` : `Diese Tagesmail nicht mehr bekommen? Abbestellen: ${v.unsubscribeUrl}` })
  return { subject: v.subject, blocks }
}
