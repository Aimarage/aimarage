import { getDb } from '~~/server/lib/db'
import { UploadError, uploadToTask } from '~~/server/lib/uploads'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const db = await getDb()
  const t = await loadTask(db, s, getRouterParam(event, 'id')!)
  const parts = (await readMultipartFormData(event)) ?? []
  const files = parts.filter(p => p.name === 'file' && p.data?.length).map(p => ({ name: p.filename ?? 'datei', data: new Uint8Array(p.data) }))
  const fundus = parts.find(p => p.name === 'fundus')?.data.toString('utf8') === '1'
  try {
    return { results: await uploadToTask(db, s.workspace, t, s.user.id, files, { fundus }) }
  }
  catch (err) {
    if (err instanceof UploadError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
