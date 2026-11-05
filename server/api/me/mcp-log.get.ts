import { roleAtLeast } from '~~/shared/utils/domain'
import { getDb } from '~~/server/lib/db'
import { CALL_LOG_DAYS, listCalls } from '~~/server/lib/api/call-log'

const query = z.object({ token: z.string().uuid().optional(), before: z.coerce.number().int().positive().optional(), all: z.enum(['0', '1']).optional() })

// Protokoll der API/MCP-Aufrufe: Inhaber und Admins sehen den ganzen Arbeitsbereich, alle anderen nur ihre eigenen Schlüssel.
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const s = await requireAuth(event)
  const q = parseQuery(event, query)
  const admin = roleAtLeast(s.role, 'admin')
  const all = admin && q.all !== '0'
  const db = await getDb()
  const calls = await listCalls(db, { workspaceId: s.workspace.id, userId: all ? null : s.user.id, tokenId: q.token ?? null, before: q.before ?? null, limit: 100 })
  return { calls, admin, days: CALL_LOG_DAYS }
})
