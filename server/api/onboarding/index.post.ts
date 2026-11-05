import { isValidIso } from '~~/shared/utils/dates'
import { getDb } from '~~/server/lib/db'
import { foldersAllowed } from '~~/server/lib/folder'
import { enqueueJob } from '~~/server/lib/jobs'
import { clientIp } from '~~/server/lib/api/http'
import { createProjectRecord, normalizeUrl } from '~~/server/lib/onboarding'
import { startPreview } from '~~/server/lib/preview'

const body = z.object({
  name: z.string().trim().max(60).nullable().optional(),
  url: z.string().trim().min(3).max(300),
  description: z.string().trim().max(2000).nullable().optional(),
  folder: z.string().trim().max(500).nullable().optional(),
  defer: z.boolean().optional(),
  goals: z.array(z.object({
    label: z.string().trim().min(1).max(120),
    targetValue: z.number().finite().min(0).nullable().optional(),
    deadline: z.string().refine(isValidIso).nullable().optional(),
    metricKey: z.string().trim().max(40).regex(/^[a-z0-9_]*$/).nullable().optional(),
    mode: z.enum(['sum', 'last', 'month']).optional(),
  })).max(10).default([]),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  if (!normalizeUrl(input.url)) throw createError({ statusCode: 400, statusMessage: 'Ungültige Website-Adresse' })
  const db = await getDb()
  const fields = { name: input.name, url: input.url, description: input.description, folder: (foldersAllowed() && input.folder) || null, goals: input.goals.map(g => ({ ...g, metricKey: g.metricKey || null })) }
  // Pausierter Workspace: einmalige Vorschau (Projekt + Analyse mit KI-Deckel), nur mit Website, ohne Unterlagen.
  const preview = !!s.workspace.pausedAt
  const p = preview
    ? await db.transaction(async (tx) => {
        await startPreview(tx, s.workspace, s.user.email, clientIp(event))
        return createProjectRecord(tx, s.workspace, s.user.id, fields, { preview: true })
      })
    : await createProjectRecord(db, s.workspace, s.user.id, fields)
  if (preview || !input.defer) await enqueueJob(db, 'onboard_project', { workspaceId: s.workspace.id, payload: { projectId: p.id, ...(preview ? { preview: true } : {}) }, dedupeKey: `onboard:${p.id}`, maxAttempts: 1 })
  return { id: p.id, slug: p.slug, preview }
})
