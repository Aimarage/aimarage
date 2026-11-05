import type { MailContent, MailLocale } from './layout'

export interface StepUpVars {
  code: string
  action?: string
  minutes?: number
}

export function stepUp(v: StepUpVars, locale: MailLocale): MailContent {
  const min = v.minutes ?? 10
  if (locale === 'en') {
    return {
      subject: `${v.code} is your Aimarage confirmation code`,
      blocks: [
        { p: v.action ? `Please confirm this action: ${v.action}` : 'Please confirm the action with this code:' },
        { code: v.code },
        { p: `The code is valid for ${min} minutes.` },
        { small: 'If that was not you, change your sign-in details and sign out of all sessions.' },
      ],
    }
  }
  return {
    subject: `${v.code} ist dein Bestätigungscode für Aimarage`,
    blocks: [
      { p: v.action ? `Bitte bestätige diese Aktion: ${v.action}` : 'Bitte bestätige die Aktion mit diesem Code:' },
      { code: v.code },
      { p: `Der Code gilt ${min} Minuten.` },
      { small: 'Warst du das nicht, ändere deine Anmeldedaten und melde alle Sitzungen ab.' },
    ],
  }
}
