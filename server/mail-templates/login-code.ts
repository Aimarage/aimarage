import type { MailContent, MailLocale } from './layout'

export interface LoginCodeVars {
  code: string
  minutes?: number
}

export function loginCode(v: LoginCodeVars, locale: MailLocale): MailContent {
  const min = v.minutes ?? 10
  if (locale === 'en') {
    return {
      subject: `${v.code} is your Aimarage sign-in code`,
      blocks: [
        { p: 'Your sign-in code:' },
        { code: v.code },
        { p: `The code is valid for ${min} minutes and can only be used once.` },
        { small: 'If you did not try to sign in, you can ignore this email.' },
      ],
    }
  }
  return {
    subject: `${v.code} ist dein Anmeldecode für Aimarage`,
    blocks: [
      { p: 'Dein Anmeldecode:' },
      { code: v.code },
      { p: `Der Code gilt ${min} Minuten und nur einmal.` },
      { small: 'Wenn du dich nicht anmelden wolltest, kannst du diese Mail ignorieren.' },
    ],
  }
}
