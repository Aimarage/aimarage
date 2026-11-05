import { config } from '~~/server/lib/config'
import { getDb } from '~~/server/lib/db'
import { finishOAuth } from '~~/server/lib/connections'
import { isOAuthProvider, parsePastedRedirect } from '~~/server/lib/platforms/oauth'
import { PlatformError } from '~~/server/lib/platforms/types'

const body = z.object({ url: z.string().trim().min(4).max(4000) })

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'admin')
  const provider = getRouterParam(event, 'provider')!
  if (!isOAuthProvider(provider)) throw createError({ statusCode: 404 })
  const input = await parseBody(event, body)
  try {
    const { code, state } = parsePastedRedirect(input.url)
    const list = await finishOAuth(await getDb(), s.workspace, provider, code, state, config.appUrl)
    return { ok: true, names: list.map(c => c.name) }
  }
  catch (err) {
    if (err instanceof PlatformError) return { ok: false, error: err.message }
    return { ok: false, error: (err as Error).message.slice(0, 300) }
  }
})
