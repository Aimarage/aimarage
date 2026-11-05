import { deleteSession, SESSION_COOKIE } from '~~/server/lib/auth'
import { getDb } from '~~/server/lib/db'

export default defineEventHandler(async (event) => {
  const token = getCookie(event, SESSION_COOKIE)
  if (token) await deleteSession(await getDb(), token)
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
  return { ok: true }
})
