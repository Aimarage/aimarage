import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '~~/server/lib/db'
import { BlogApiError, buildBlogApi, publicBlogApi } from '~~/server/lib/blog-api'
import { BLOG_TYPES } from '~~/server/lib/blog'
import { assertAccountLimit } from '~~/server/lib/limits'

const field = z.string().trim().max(80).regex(/^[\w-]*$/).nullable().optional()
const body = z.object({
  type: z.enum(BLOG_TYPES).optional(),
  url: httpUrl(500).optional(),
  token: z.string().trim().min(8).max(500).optional(),
  user: z.string().trim().max(120).nullable().optional(),
  status: z.enum(['publish', 'draft']).nullable().optional(),
  category: z.number().int().min(1).max(1e9).nullable().optional(),
  collectionId: z.string().trim().max(60).regex(/^[\w-]*$/).nullable().optional(),
  fields: z.object({ title: field, slug: field, body: field, description: field }).nullable().optional(),
  git: z.object({
    provider: z.enum(['github', 'gitlab']),
    base: z.string().trim().max(200).nullable().optional(),
    repo: z.string().trim().min(3).max(200),
    branch: z.string().trim().max(200).nullable().optional(),
    dir: z.string().trim().min(1).max(200),
    file: z.string().trim().max(120).nullable().optional(),
    publicUrl: z.string().trim().min(10).max(500),
    imageDir: z.string().trim().max(200).nullable().optional(),
  }).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const input = await parseBody(event, body)
  const id = getRouterParam(event, 'id')!
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 404 })
  const db = await getDb()
  const [p] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.workspaceId, s.workspace.id)))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  await assertAccountLimit(db, s.workspace, p.setup?.blogApi ? 0 : 1)
  try {
    const blogApi = buildBlogApi(s.workspace.id, p.id, p.setup?.blogApi, input)
    await db.update(schema.projects).set({ setup: { ...p.setup, blogApi } }).where(eq(schema.projects.id, p.id))
    return { ok: true, blogApi: publicBlogApi(blogApi) }
  }
  catch (err) {
    if (err instanceof BlogApiError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
