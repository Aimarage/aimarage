import { and, eq, isNull } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { accountsUsed } from '~~/server/lib/limits'
import { countPasskeys } from '~~/server/lib/webauthn'

// Karte "Erste Schritte" auf dem Dashboard, aus vorhandenen Daten berechnet.
export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const db = await getDb()
  const ws = s.workspace
  const [project] = await db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.workspaceId, ws.id), isNull(schema.projects.archivedAt))).limit(1)
  const [strategy] = await db.select({ id: schema.strategies.id }).from(schema.strategies).where(and(eq(schema.strategies.workspaceId, ws.id), eq(schema.strategies.status, 'aktiv'))).limit(1)
  const steps = {
    project: !!project,
    strategy: !!strategy,
    account: (await accountsUsed(db, ws)) > 0,
    mainSwitch: !!ws.settings?.publishLive || !!ws.settings?.sendLive,
    passkey: (await countPasskeys(db, s.user.id)) > 0,
  }
  return { steps, hidden: !!s.user.prefs?.firstStepsHidden }
})
