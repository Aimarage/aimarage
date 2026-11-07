import { config } from '~~/server/lib/config'
import { getDb } from '~~/server/lib/db'
import { workspaceBrand } from '~~/server/lib/extensions'
import { clientDrafts, clientLang } from '~~/server/services/client'

export default defineEventHandler(async (event) => {
  const c = await clientGate(event)
  const db = await getDb()
  const brand = await workspaceBrand(db, c.ws.id)
  return {
    brand: brand ? { name: brand.name, logoUrl: brand.logoUrl, accent: brand.accent, marker: brand.marker, font: brand.font } : null,
    project: { name: c.project.name, url: c.project.url },
    lang: clientLang(c.project),
    timezone: c.ws.timezone,
    canReport: c.link.canReport,
    expiresAt: c.link.expiresAt?.toISOString() ?? null,
    drafts: await clientDrafts(db, c, config.appUrl),
  }
})
