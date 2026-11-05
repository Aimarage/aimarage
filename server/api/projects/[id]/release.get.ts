import { desc, eq } from 'drizzle-orm'
import { addDays } from '~~/shared/utils/dates'
import { DEFAULT_RELEASE_TIME } from '~~/shared/utils/release'
import { platformRule } from '~~/shared/utils/social'
import { schema } from '~~/server/lib/db'
import { releaseEnv } from '~~/server/lib/release'

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'member')
  const env = await releaseEnv(db, s.workspace, p)
  const docs = await db.select({ id: schema.projectDocuments.id, name: schema.projectDocuments.name }).from(schema.projectDocuments).where(eq(schema.projectDocuments.projectId, p.id)).orderBy(desc(schema.projectDocuments.createdAt)).limit(50)
  return {
    today: env.today,
    start: addDays(env.today, 1),
    platforms: env.postable.filter(x => !env.excluded.includes(x)).map(x => ({ id: x, label: platformRule(x).label })),
    time: env.bestTime ?? DEFAULT_RELEASE_TIME,
    timeSource: env.bestTime ? 'data' : 'default',
    hasBlog: env.hasBlog,
    weekend: env.weekend,
    images: env.fundus.length,
    documents: docs,
  }
})
