import { and, eq } from 'drizzle-orm'
import { today } from '~~/server/lib/clock'
import { schema } from '~~/server/lib/db'
import { rejectExperiment, smallExperiment, startExperiment, stopExperiment } from '~~/server/lib/experiments'

const body = z.object({
  experimentId: z.string().uuid(),
  action: z.enum(['start', 'reject', 'stop']),
})

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'member')
  const input = await parseBody(event, body)
  const [exp] = await db.select().from(schema.experiments).where(and(eq(schema.experiments.id, input.experimentId), eq(schema.experiments.projectId, p.id), eq(schema.experiments.workspaceId, s.workspace.id)))
  if (!exp) throw createError({ statusCode: 404, statusMessage: 'Experiment nicht gefunden' })
  const d = today(s.workspace.timezone)
  if (input.action === 'stop') {
    if (exp.status !== 'laeuft') throw createError({ statusCode: 409, statusMessage: 'Experiment läuft nicht' })
    await stopExperiment(db, p, exp, d, s.user.id)
    return { ok: true }
  }
  if (exp.status !== 'vorschlag') throw createError({ statusCode: 409, statusMessage: 'Vorschlag ist schon entschieden' })
  if (input.action === 'reject') {
    await rejectExperiment(db, p, exp, s.user.id)
    return { ok: true }
  }
  if (!smallExperiment(exp.variable)) throw createError({ statusCode: 409, statusMessage: 'Dieses Experiment ändert die Strategie und startet mit der Strategie-Freigabe' })
  await startExperiment(db, p, exp, d, { userId: s.user.id, agent: false })
  return { ok: true }
})
