import { clientLink, type ClientLinkVars } from './client-link'
import { emailChange, type EmailChangeVars } from './email-change'
import { genericNotice, type GenericNoticeVars } from './generic-notice'
import { renderMail, type MailBrand, type MailContent, type MailLocale, type RenderedMail } from './layout'
import { loginCode, type LoginCodeVars } from './login-code'
import { stepUp, type StepUpVars } from './step-up'

export type { MailLocale, RenderedMail } from './layout'

export interface SystemMailVars {
  'login-code': LoginCodeVars
  'email-change': EmailChangeVars
  'step-up': StepUpVars
  'generic-notice': GenericNoticeVars
  'client-link': ClientLinkVars
}

export type SystemMailTemplate = keyof SystemMailVars

const TEMPLATES: { [K in SystemMailTemplate]: (v: SystemMailVars[K], locale: MailLocale) => MailContent } = {
  'login-code': loginCode,
  'email-change': emailChange,
  'step-up': stepUp,
  'generic-notice': genericNotice,
  'client-link': clientLink,
}

export const SYSTEM_MAIL_TEMPLATES = Object.keys(TEMPLATES) as SystemMailTemplate[]

export function isSystemMailTemplate(name: string): name is SystemMailTemplate {
  return Object.hasOwn(TEMPLATES, name)
}

export function mailLocale(locale: string | null | undefined): MailLocale {
  return locale?.toLowerCase().startsWith('en') ? 'en' : 'de'
}

export function renderSystemMail<K extends SystemMailTemplate>(template: K, vars: SystemMailVars[K], locale: string | null | undefined, brand: MailBrand | null = null): RenderedMail {
  const loc = mailLocale(locale)
  return renderMail(TEMPLATES[template](vars, loc), loc, brand)
}
