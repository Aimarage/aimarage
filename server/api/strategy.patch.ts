import type { StrategyChange } from '~~/server/db/schema'
import { today } from '~~/server/lib/clock'
import { getDb } from '~~/server/lib/db'
import { activeStrategy, changeStrategy } from '~~/server/lib/strategy'
import { assertFullAccess } from '~~/server/lib/preview'

const body = z.object({
  project: z.string().max(60),
  key: z.string().max(60),
  weight: z.number().int().min(1).max(6).optional(),
  active: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  assertFullAccess(s.workspace)
  const input = await parseBody(event, body)
  const db = await getDb()
  const project = await resolveProject(db, s, input.project)
  if (!project) throw createError({ statusCode: 400, statusMessage: 'Projekt fehlt' })
  const cur = await activeStrategy(db, project.id)
  const ch = cur?.channels.find(c => c.key === input.key)
  if (!cur || !ch) throw createError({ statusCode: 404, statusMessage: 'Kanal nicht gefunden' })
  const changes: StrategyChange[] = []
  if (input.active === false && ch.active) changes.push({ channelKey: ch.key, name: ch.name, change: 'pause', from: ch.weight, to: ch.weight, reason: 'Von Hand pausiert' })
  if (input.active === true && !ch.active) changes.push({ channelKey: ch.key, name: ch.name, change: 'resume', from: ch.weight, to: ch.weight, reason: 'Von Hand fortgesetzt' })
  if (input.weight && input.weight !== ch.weight) changes.push({ channelKey: ch.key, name: ch.name, change: input.weight > ch.weight ? 'more' : 'less', from: ch.weight, to: input.weight, reason: 'Von Hand geändert' })
  if (!changes.length) return { ok: true, created: 0 }
  const r = await changeStrategy(db, project, changes, today(s.workspace.timezone), { kind: 'manual', byAgent: false, userId: s.user.id })
  return { ok: true, created: r.created }
})
