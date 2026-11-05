import { roleAtLeast } from '~~/shared/utils/domain'
import { API_PERMS, cleanPerms, scopeOfPerms, TOKEN_DAYS } from '~~/shared/utils/api-perms'
import { getDb } from '~~/server/lib/db'
import { logActivity } from '~~/server/lib/activity'
import { updateApiToken } from '~~/server/lib/api/tokens'

const body = z.object({
  perms: z.array(z.enum(API_PERMS)).max(10).optional(),
  projects: z.array(z.string().uuid()).max(100).nullable().optional(),
  extendDays: z.number().int().refine(n => (TOKEN_DAYS as readonly number[]).includes(n)).optional(),
  name: z.string().trim().min(1).max(60).optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event)
  const input = await parseBody(event, body)
  if (input.perms && scopeOfPerms(cleanPerms(input.perms)) === 'write' && !roleAtLeast(s.role, 'member')) throw createError({ statusCode: 403, statusMessage: 'Als Betrachter nur Tokens zum Lesen' })
  const db = await getDb()
  const projects = input.projects === undefined ? undefined : await accessibleProjectIds(db, s, input.projects)
  const t = await updateApiToken(db, s.user.id, getRouterParam(event, 'id')!, { perms: input.perms, projectIds: projects, extendDays: input.extendDays, name: input.name })
  if (!t) throw createError({ statusCode: 404, statusMessage: 'Token nicht gefunden' })
  await logActivity(db, { workspaceId: s.workspace.id, actor: 'user', userId: s.user.id, action: 'api_token_changed', detail: { title: t.name, perms: t.perms, projects: t.projectIds?.length ?? null, expiresAt: t.expiresAt } })
  return t
})
