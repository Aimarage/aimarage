import { config } from '~~/server/lib/config'
import { googleAccessToken, listSites, pickProperty, SearchError } from '~~/server/lib/search-console'

export default defineEventHandler(async (event) => {
  const { s, p } = await projectById(event, 'admin')
  try {
    const sites = await listSites(await googleAccessToken(s.workspace, p, config.appUrl))
    return { sites: sites.map(x => x.siteUrl), suggested: pickProperty(sites, p.url), current: p.setup?.google?.property ?? null, error: null }
  }
  catch (err) {
    if (err instanceof SearchError) return { sites: [], suggested: null, current: p.setup?.google?.property ?? null, error: err.message }
    throw err
  }
})
