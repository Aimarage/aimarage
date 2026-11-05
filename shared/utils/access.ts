
// Zugangsfehler, die Abrufe oder Posts verhindern: stehen ganz oben unter "Für dich" (Dashboard, Morgen-Mail), je ca. 1 Minute.

export type AccessKind = 'google' | 'bing' | 'mail' | 'blogApi' | 'stats' | 'social' | 'llm'

export interface AccessProblem {
  key: string
  kind: AccessKind
  // Dienst, z.B. "Google Search Console", "X (@tonebase)".
  what: string
  projectId: string | null
  projectName: string | null
  message: string
  // Relativer Link direkt zum Neu-Verbinden bzw. zur Stelle, wo der Zugang steht.
  path: string
  min: number
  // Plattform-Zugang (Einstellungen > Plattform-Zugänge), zu dem die Verbindung gehört.
  app: string | null
}

export const ACCESS_MIN = 1

// Kurze Netz- oder Serverstörungen sind kein Zugangsfehler, der nächste Abruf klärt sie.
const TRANSIENT = /nicht erreichbar|vorübergehend|timed? ?out|timeout|zeitüberschreitung|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|socket|Fehler 5\d\d|\b50[0234]\b|rate.?limit|429|zu viele anfragen/i

// Zugang abgelaufen oder widerrufen: neu verbinden hilft (statt Website wählen oder trennen).
export function isAccessExpired(message: string | null | undefined): boolean {
  return !!message && /abgelaufen|widerrufen|neu verbinden|unlesbar|invalid_grant|expired|revoked|\b401\b/i.test(message)
}

export function isTransient(message: string): boolean {
  return TRANSIENT.test(message)
}

export interface AccessProject {
  id: string
  slug: string
  name: string
  setup: {
    google?: { secret?: unknown, error?: string | null } | null
    bing?: { site?: string | null, off?: boolean, error?: string | null } | null
    mail?: { error?: string | null } | null
    blogApi?: { error?: string | null } | null
    stats?: { error?: string | null } | null
    social?: { accountIds?: string[] } | null
  } | null
}

export interface AccessConn {
  id: string
  provider?: string
  platform: string
  name: string
  handle?: string | null
  error?: string | null
}

const SERVICE: Record<Exclude<AccessKind, 'social'>, { de: string, en: string }> = {
  google: { de: 'Google Search Console', en: 'Google Search Console' },
  bing: { de: 'Bing Webmaster Tools', en: 'Bing Webmaster Tools' },
  mail: { de: 'Postfach', en: 'Mailbox' },
  blogApi: { de: 'Blog-API', en: 'Blog API' },
  stats: { de: 'Besucher-Statistik', en: 'Visitor statistics' },
  llm: { de: 'Eigener KI-Schlüssel', en: 'Own AI key' },
}

const APP_OAUTH = ['meta', 'instagram', 'threads', 'linkedin', 'tiktok', 'x']

export function accessProblems(projects: AccessProject[], conns: AccessConn[], llmError?: { code: string, message: string } | null, locale: 'de' | 'en' = 'de'): AccessProblem[] {
  const out: AccessProblem[] = []
  const push = (kind: AccessKind, p: AccessProject | null, message: string | null | undefined, path: string, what?: string, app: string | null = kind === 'google' || kind === 'bing' ? kind : null) => {
    if (!message?.trim() || isTransient(message)) return
    out.push({ key: `${kind}:${p?.id ?? 'ws'}${what ? `:${what}` : ''}`, kind, what: what ?? SERVICE[kind as Exclude<AccessKind, 'social'>][locale], projectId: p?.id ?? null, projectName: p?.name ?? null, message: message.trim(), path, min: ACCESS_MIN, app })
  }
  for (const p of projects) {
    const s = p.setup ?? {}
    if (s.google?.secret) push('google', p, s.google.error, `/p/${p.slug}/berichte?reconnect=google`)
    if (s.bing?.site && !s.bing.off) push('bing', p, s.bing.error, /schlüssel|key|401|403/i.test(s.bing.error ?? '') ? '/einstellungen/apps?app=bing' : `/p/${p.slug}/berichte?tab=bing`)
    push('mail', p, s.mail?.error, `/p/${p.slug}/konten`)
    push('blogApi', p, s.blogApi?.error, `/p/${p.slug}/einstellungen`)
    push('stats', p, s.stats?.error, `/p/${p.slug}/einstellungen`)
  }
  for (const c of conns) {
    if (!c.error?.trim() || isTransient(c.error)) continue
    const p = projects.find(x => x.setup?.social?.accountIds?.includes(c.id))
    if (!p) continue
    const what = `${c.name}${c.handle ? ` (${c.handle})` : ''}`
    const app = c.provider === 'youtube' ? 'google' : c.provider && APP_OAUTH.includes(c.provider) ? c.provider : null
    push('social', p, c.error, `/p/${p.slug}/konten?connect=${c.platform}`, what, app)
  }
  if (llmError?.code === 'auth') push('llm', null, llmError.message, '/einstellungen/ki')
  return out
}

export function accessText(a: AccessProblem, locale: 'de' | 'en'): string {
  const where = a.projectName ? ` (${a.projectName})` : ''
  return locale === 'en' ? `Reconnect access: ${a.what}${where} - ${a.message}` : `Zugang neu verbinden: ${a.what}${where} - ${a.message}`
}
