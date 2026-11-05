import { bingKey, listBingSites, pickBingSite } from '~~/server/lib/bing-webmaster'
import { SearchError } from '~~/server/lib/search-console'

export default defineEventHandler(async (event) => {
  const { s, p } = await projectById(event, 'admin')
  const current = p.setup?.bing?.off ? null : p.setup?.bing?.site ?? null
  const key = bingKey(s.workspace)
  if (!key) return { sites: [], suggested: null, current, error: 'Kein Bing-API-Schlüssel eingetragen' }
  try {
    const sites = await listBingSites(key)
    return { sites, suggested: pickBingSite(sites, p.url), current, error: null }
  }
  catch (err) {
    if (err instanceof SearchError) return { sites: [], suggested: null, current, error: err.message }
    throw err
  }
})
