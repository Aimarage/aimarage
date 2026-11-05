import { eq } from 'drizzle-orm'
import { daysLeft } from '../../../shared/utils/api-perms'
import { config } from '../config'
import { now } from '../clock'
import type { DbOrTx } from '../db'
import { schema } from '../db'
import { notify } from '../notify'
import { expiringTokens } from './tokens'

// Meldet einmal je Schlüssel, dass er bald abläuft (Mail an die Person, der er gehört).
export async function warnExpiringTokens(db: DbOrTx, at = now()): Promise<number> {
  let n = 0
  for (const t of await expiringTokens(db, at)) {
    const days = Math.max(0, daysLeft(t.expiresAt, at) ?? 0)
    const url = `${config.appUrl}/einstellungen/api`
    await notify(db, t.workspaceId, t.userId, 'api_token_expiring', {
      tokenId: t.id,
      text: {
        de: { subject: `Aimarage: Schlüssel "${t.name}" läuft in ${days} Tagen ab`, body: `Dein API/MCP-Schlüssel "${t.name}" (...${t.hint}) läuft am ${t.expiresAt!.toISOString().slice(0, 10)} ab. Danach verlieren Programme, die ihn nutzen (z.B. Claude), den Zugang. Unter Einstellungen > API und MCP kannst du ihn verlängern oder widerrufen.`, actionUrl: url, actionLabel: 'Schlüssel ansehen' },
        en: { subject: `Aimarage: key "${t.name}" expires in ${days} days`, body: `Your API/MCP key "${t.name}" (...${t.hint}) expires on ${t.expiresAt!.toISOString().slice(0, 10)}. After that, programs using it (e.g. Claude) lose access. Under Settings > API and MCP you can extend or revoke it.`, actionUrl: url, actionLabel: 'View keys' },
      },
    }, { dedupeKey: `api_token_expiring:${t.id}:${t.expiresAt!.toISOString().slice(0, 10)}` })
    await db.update(schema.apiTokens).set({ expiryWarnedAt: at }).where(eq(schema.apiTokens.id, t.id))
    n++
  }
  return n
}
