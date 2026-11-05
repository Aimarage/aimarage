import { getDb } from '~~/server/lib/db'
import { SttError, transcribe, transcribeLimiter, TRANSCRIBE_MAX_BYTES } from '~~/server/lib/transcribe'

export default defineEventHandler(async (event) => {
  const s = await requireAuth(event, 'member')
  const db = await getDb()
  const wait = await transcribeLimiter.hit(db, s.user.id)
  if (wait) throw createError({ statusCode: 429, statusMessage: 'Zu viele Aufnahmen, bitte später noch einmal' })
  const parts = (await readMultipartFormData(event)) ?? []
  const file = parts.find(p => p.name === 'audio')
  if (!file?.data.length) throw createError({ statusCode: 400, statusMessage: 'Keine Aufnahme' })
  if (file.data.length > TRANSCRIBE_MAX_BYTES) throw createError({ statusCode: 413, statusMessage: 'Aufnahme zu lang' })
  const lang = parts.find(p => p.name === 'lang')?.data.toString('utf8').slice(0, 5) || null
  try {
    return { text: await transcribe(db, s.workspace, { data: file.data, type: file.type ?? 'audio/webm', name: file.filename ?? 'audio.webm' }, lang && /^[a-z]{2}$/.test(lang) ? lang : null) }
  }
  catch (err) {
    if (err instanceof SttError) throw createError({ statusCode: 502, statusMessage: err.message })
    throw err
  }
})
