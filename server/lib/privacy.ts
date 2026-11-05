import { privateDataProblems } from '../../shared/utils/private-data'
import { config } from './config'

// Private Daten in einem Entwurf: fremde E-Mail-Adressen (nicht bei Mails), private Links, Zugangsdaten.
export function draftPrivacy(project: { url?: string | null } | null, draft: { kind: string, subject?: string | null, body: string, variants?: Record<string, string> | null }): string[] {
  let appHost: string | null = null
  try {
    appHost = new URL(config.appUrl).hostname
  }
  catch {}
  return privateDataProblems([draft.subject, draft.body, ...Object.values(draft.variants ?? {})], { ownHosts: [project?.url], appHost, mail: draft.kind === 'mail' })
}
