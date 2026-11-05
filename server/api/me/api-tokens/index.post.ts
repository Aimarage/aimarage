import { roleAtLeast } from '~~/shared/utils/domain'
import { API_PERMS, cleanPerms, scopeOfPerms, TOKEN_DAYS } from '~~/shared/utils/api-perms'
import { getDb } from '~~/server/lib/db'
import { logActivity } from '~~/server/lib/activity'
import { createApiToken, TokenLimitError } from '~~/server/lib/api/tokens'

const body = z.object({
  name: z.string().trim().min(1).max(60),
  scope: z.enum(['read', 'write']).optional(),
  approve: z.boolean().optional(),
  perms: z.array(z.enum(API_PERMS)).max(10).optional(),
  projects: z.array(z.string().uuid()).max(100).nullable().optional(),
  days: z.number().int().refine(n => (TOKEN_DAYS as readonly number[]).includes(n)).optional(),
})

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const s = await requireAuth(event)
  const input = await parseBody(event, body)
  const perms = cleanPerms(input.perms ?? (input.scope === 'write' ? ['private', 'draft', 'strategy', 'agent', ...(input.approve ? ['approve'] : [])] : ['private']))
  if (scopeOfPerms(perms) === 'write' && !roleAtLeast(s.role, 'member')) throw createError({ statusCode: 403, statusMessage: 'Als Betrachter nur Tokens zum Lesen' })
  const db = await getDb()
  const projects = await accessibleProjectIds(db, s, input.projects)
  try {
    const t = await createApiToken(db, { userId: s.user.id, workspaceId: s.workspace.id, name: input.name, perms, projectIds: projects, days: input.days })
    await logActivity(db, { workspaceId: s.workspace.id, actor: 'user', userId: s.user.id, action: 'api_token_created', detail: { title: input.name, perms, projects: projects?.length ?? null, expiresAt: t.expiresAt } })
    return t
  }
  catch (err) {
    if (err instanceof TokenLimitError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
