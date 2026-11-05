import type { MailContent, MailLocale } from './layout'

export interface EmailChangeVars {
  code: string
  email: string
  minutes?: number
}

export function emailChange(v: EmailChangeVars, locale: MailLocale): MailContent {
  const min = v.minutes ?? 10
  if (locale === 'en') {
    return {
      subject: `${v.code} confirms your new email address`,
      blocks: [
        { p: `Enter this code in Aimarage to use ${v.email} as your new email address:` },
        { code: v.code },
        { p: `The code is valid for ${min} minutes.` },
        { small: 'If you did not request this change, ignore this email. Your address stays the same.' },
      ],
    }
  }
  return {
    subject: `${v.code} bestätigt deine neue E-Mail-Adresse`,
    blocks: [
      { p: `Gib diesen Code in Aimarage ein, um ${v.email} als neue E-Mail-Adresse zu verwenden:` },
      { code: v.code },
      { p: `Der Code gilt ${min} Minuten.` },
      { small: 'Wenn du das nicht angefordert hast, ignoriere diese Mail. Deine Adresse bleibt unverändert.' },
    ],
  }
}
