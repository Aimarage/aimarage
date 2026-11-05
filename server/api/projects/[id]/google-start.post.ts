import { config } from '~~/server/lib/config'
import { SearchError, startGoogle } from '~~/server/lib/search-console'

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'admin')
  try {
    return { url: await startGoogle(db, s.workspace, p.id, config.appUrl) }
  }
  catch (err) {
    if (err instanceof SearchError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
