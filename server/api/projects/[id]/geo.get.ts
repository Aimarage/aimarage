import { latestGeo } from '~~/server/lib/geo'

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event)
  const geo = p.setup?.geo
  return { questions: geo?.questions ?? [], generatedAt: geo?.generatedAt ?? null, editedAt: geo?.editedAt ?? null, last: await latestGeo(db, p.id) }
})
