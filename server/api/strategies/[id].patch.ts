import { eq } from 'drizzle-orm'
import { STRATEGY_CATEGORIES } from '~~/shared/utils/plan'
import { getDb, schema } from '~~/server/lib/db'
import { normalizeChannel } from '~~/server/lib/strategy'
import { assertFullAccess } from '~~/server/lib/preview'

const body = z.object({
  channels: z.array(z.object({
    key: z.string().max(60).optional(),
    name: z.string().trim().min(1).max(80),
    category: z.enum(STRATEGY_CATEGORIES),
    why: z.string().max(400).optional(),
    goalIds: z.array(z.string().uuid()).max(20).optional(),
    weight: z.number().int().min(1).max(6),
    days: z.array(z.string().max(2)).max(5).optional(),
    active: z.boolean(),
    base: z.number().optional(),
    time: z.string().nullable().optional(),
  })).max(20),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  assertFullAccess(s.workspace)
  const input = await parseBody(event, body)
  const db = await getDb()
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const [st] = await db.select().from(schema.strategies).where(eq(schema.strategies.id, id))
  if (!st || st.workspaceId !== s.workspace.id) throw createError({ statusCode: 404, statusMessage: 'Strategie nicht gefunden' })
  await assertProjectVisible(db, s, st.projectId, 'Strategie nicht gefunden')
  if (st.status !== 'vorschlag') throw createError({ statusCode: 409, statusMessage: 'Nur Vorschläge sind änderbar' })
  const channels = input.channels.map(c => normalizeChannel(c))
  const keys = new Set<string>()
  for (const c of channels) {
    let k = c.key
    for (let i = 2; keys.has(k); i++) k = `${c.key}-${i}`
    c.key = k
    keys.add(k)
  }
  await db.update(schema.strategies).set({ channels, changes: st.kind === 'initial' ? [] : st.changes }).where(eq(schema.strategies.id, id))
  return { ok: true }
})
