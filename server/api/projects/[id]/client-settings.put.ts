import { eq } from 'drizzle-orm'
import { logActivity } from '~~/server/lib/activity'
import { schema } from '~~/server/lib/db'

const body = z.object({ okApproves: z.boolean() })

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'owner')
  const input = await parseBody(event, body)
  await db.update(schema.projects).set({ setup: { ...p.setup, client: { ...p.setup?.client, okApproves: input.okApproves } } }).where(eq(schema.projects.id, p.id))
  await logActivity(db, { workspaceId: s.workspace.id, projectId: p.id, actor: 'user', userId: s.user.id, action: input.okApproves ? 'client_ok_approves_on' : 'client_ok_approves_off', detail: { title: p.name } })
  return { ok: true, okApproves: input.okApproves }
})
