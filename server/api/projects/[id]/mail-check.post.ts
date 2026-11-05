import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { checkMail, MailError } from '~~/server/lib/mail'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p) throw createError({ statusCode: 404 })
  try {
    const r = await checkMail(db, s.workspace, p, undefined, s.user.id)
    return { ok: !r.imap && !r.smtp, ...r }
  }
  catch (err) {
    if (err instanceof MailError) return { ok: false, imap: err.message, smtp: null }
    throw err
  }
})
