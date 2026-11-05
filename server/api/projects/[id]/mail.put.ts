import { and, eq } from 'drizzle-orm'
import { logActivity } from '~~/server/lib/activity'
import { getDb, schema } from '~~/server/lib/db'
import { buildMailSettings, checkMail, MailError, publicMail } from '~~/server/lib/mail'
import { assertMailServer } from '~~/server/lib/site'
import { assertAccountLimit } from '~~/server/lib/limits'

const host = z.string().trim().min(3).max(200).regex(/^[a-z0-9.-]+$/i, 'Nur Servername, z.B. mail.example.com')
const body = z.object({
  imapHost: host,
  imapPort: z.number().int().min(1).max(65535),
  imapSecure: z.boolean(),
  smtpHost: host,
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  user: z.string().trim().min(1).max(200),
  smtpUser: z.string().trim().max(200).nullable().optional(),
  from: z.string().trim().min(3).max(200).refine(v => /@/.test(v), 'Absender braucht eine Adresse'),
  imapPassword: z.string().min(1).max(500).optional(),
  smtpPassword: z.string().min(1).max(500).optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  await assertAccountLimit(db, s.workspace, p.setup?.mail ? 0 : 1)
  try {
    await assertMailServer('imap', input.imapHost, input.imapPort)
    await assertMailServer('smtp', input.smtpHost, input.smtpPort)
  }
  catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  try {
    const mail = buildMailSettings(s.workspace.id, p.id, p.setup?.mail, input)
    await db.update(schema.projects).set({ setup: { ...p.setup, mail } }).where(eq(schema.projects.id, p.id))
    await logActivity(db, { workspaceId: s.workspace.id, projectId: p.id, actor: 'user', userId: s.user.id, action: 'mailbox_saved', detail: { title: p.name } })
    const fresh = (await db.select().from(schema.projects).where(eq(schema.projects.id, p.id)))[0]!
    const check = await checkMail(db, s.workspace, fresh, undefined, s.user.id)
    return { ok: !check.imap && !check.smtp, check, mail: publicMail((await db.select().from(schema.projects).where(eq(schema.projects.id, p.id)))[0]!.setup.mail) }
  }
  catch (err) {
    if (err instanceof MailError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
