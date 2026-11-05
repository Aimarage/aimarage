import { today } from './clock'
import type { DbOrTx } from './db'
import type { schema } from './db'
import { upgradeUrl, type LimitKind } from './limits'
import { notify } from './notify'

type Workspace = typeof schema.workspaces.$inferSelect

const TEXT: Partial<Record<LimitKind, { de: { subject: string, body: string }, en: { subject: string, body: string } }>> = {
  llmEurMonth: {
    de: { subject: 'KI-Budget aufgebraucht', body: 'Das KI-Budget für diesen Monat ist aufgebraucht. Der Agent schreibt bis zum Monatswechsel keine neuen Entwürfe. Bereits freigegebene Beiträge werden weiter veröffentlicht.' },
    en: { subject: 'AI budget used up', body: 'This month\'s AI budget is used up. The agent will not write new drafts until next month. Approved posts are still published.' },
  },
  servicesEurMonth: {
    de: { subject: 'Budget für Dienste aufgebraucht', body: 'Das Budget für Dienste (Websuche, Posten) ist für diesen Monat aufgebraucht. Die Websuche (Threads, Erwähnungen, KI-Sichtbarkeit) und Posts auf X über Aimarage ruhen bis zum Monatswechsel, X-Beiträge bleiben als Entwurf. Entwürfe und Posten auf anderen Plattformen laufen weiter. Ein Zusatzkonto erhöht auch das Budget für Dienste.' },
    en: { subject: 'Service budget used up', body: 'This month\'s budget for services (web search, posting) is used up. Web search (threads, mentions, AI visibility) and posts on X via Aimarage pause until next month, X posts stay as drafts. Drafts and posting on other platforms continue. An extra account also raises the service budget.' },
  },
}

// Einmal je Monat und Art an Inhaber und Admins.
export async function notifyLimit(db: DbOrTx, ws: Pick<Workspace, 'id' | 'timezone'>, kind: LimitKind): Promise<void> {
  const t = TEXT[kind]
  if (!t) return
  const month = today(ws.timezone).slice(0, 7)
  const url = upgradeUrl()
  try {
    await notify(db, ws.id, null, `limit:${kind}`, {
      kind,
      month,
      text: {
        de: { ...t.de, actionUrl: url, actionLabel: 'Tarif ansehen' },
        en: { ...t.en, actionUrl: url, actionLabel: 'View plan' },
      },
    }, { dedupeKey: `limit:${kind}:${ws.id}:${month}` })
  }
  catch (err) {
    console.error('[limits] Hinweis nicht verschickt:', (err as Error).message)
  }
}
