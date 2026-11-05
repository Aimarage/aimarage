import { config } from '~~/server/lib/config'
import { assertClientLinks } from '~~/server/lib/limits'
import { SystemMailError } from '~~/server/lib/system-mail'
import { ClientLinkError, clientLinkMails, createClientLink, sendClientLinkMail } from '~~/server/services/client'

const body = z.object({
  label: z.string().trim().max(60).nullable().optional(),
  days: z.number().int().min(1).max(365).nullable().optional(),
  canReport: z.boolean().optional(),
  sendTo: z.email().max(254).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'admin')
  assertClientLinks(s.workspace)
  const input = await parseBody(event, body)
  try {
    if (input.sendTo && (await clientLinkMails.retryAfter(db, s.workspace.id))) throw createError({ statusCode: 429, statusMessage: 'Zu viele Link-Mails heute, bitte morgen erneut' })
    const r = await createClientLink(db, { workspaceId: s.workspace.id, projectId: p.id, userId: s.user.id, label: input.label, days: input.days, canReport: input.canReport })
    const url = `${config.appUrl}/k/${r.token}`
    let mailed = false
    if (input.sendTo) {
      await clientLinkMails.fail(db, s.workspace.id)
      const expiresAt = input.days ? new Date(Date.now() + input.days * 86_400_000) : null
      try {
        await sendClientLinkMail(db, { ws: s.workspace, project: p, to: input.sendTo, url, sender: { name: s.user.name, email: s.user.email }, expiresAt })
        mailed = true
      }
      catch (err) {
        if (!(err instanceof SystemMailError)) throw err
        console.error(`[client] Link-Mail fehlgeschlagen: ${err.message}`)
      }
    }
    return { id: r.id, url, mailed }
  }
  catch (err) {
    if (err instanceof ClientLinkError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
