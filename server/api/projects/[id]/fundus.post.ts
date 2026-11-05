import { addFundusItem, fundusView } from '~~/server/lib/fundus'
import { MediaError } from '~~/server/lib/media'

export default defineEventHandler(async (event) => {
  const { s, db, p } = await projectById(event, 'member')
  const parts = (await readMultipartFormData(event)) ?? []
  const files = parts.filter(x => x.name === 'file' && x.data?.length)
  if (!files.length) throw createError({ statusCode: 400, statusMessage: 'Keine Datei' })
  if (files.length > 20) throw createError({ statusCode: 400, statusMessage: 'Höchstens 20 Dateien auf einmal' })
  const field = (name: string) => parts.find(x => x.name === name)?.data.toString('utf8') ?? ''
  const added = []
  try {
    for (const f of files) added.push(fundusView(await addFundusItem(db, s.workspace, p, { name: f.filename ?? 'datei', data: new Uint8Array(f.data), description: field('description'), tags: field('tags').split(','), checked: field('checked') === '1', source: 'upload', userId: s.user.id })))
  }
  catch (err) {
    if (err instanceof MediaError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
  return { items: added }
})
