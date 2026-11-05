import { eq } from 'drizzle-orm'
import { queueUserMessage, runTurn } from '~~/server/lib/chat'
import { getDb, schema } from '~~/server/lib/db'
import { UploadError, uploadHint, uploadToProject } from '~~/server/lib/uploads'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const parts = (await readMultipartFormData(event)) ?? []
  const field = (name: string) => parts.find(p => p.name === name)?.data.toString('utf8') ?? ''
  const db = await getDb()
  const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, field('conversationId')))
  if (!conv || conv.workspaceId !== s.workspace.id || conv.userId !== s.user.id) throw createError({ statusCode: 404, statusMessage: 'Gespräch nicht gefunden' })
  if (!conv.projectId) throw createError({ statusCode: 400, statusMessage: 'Bitte erst ein Projekt wählen, dann die Datei hochladen' })
  await assertProjectVisible(db, s, conv.projectId, 'Projekt nicht gefunden')
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, conv.projectId))
  if (!project) throw createError({ statusCode: 404, statusMessage: 'Projekt nicht gefunden' })
  const files = parts.filter(p => p.name === 'file' && p.data?.length).map(p => ({ name: p.filename ?? 'datei', data: new Uint8Array(p.data) }))
  let results
  try {
    results = await uploadToProject(db, s.workspace, project, s.user.id, files, { fundus: field('fundus') !== '0' })
  }
  catch (err) {
    if (err instanceof UploadError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
  const text = field('text').trim().slice(0, 6000)
  const page = field('page').slice(0, 300)
  const actor = { ...(await chatActor(db, s)), page: page.startsWith('/') ? page : null }
  const m = await queueUserMessage(db, actor, conv, `[${uploadHint(results)}]${text ? `\n${text}` : ''}`)
  void runTurn(db, actor, conv.id).catch(err => console.error('[chat]', err))
  return { results, ...m }
})
