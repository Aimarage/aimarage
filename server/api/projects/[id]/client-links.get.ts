import { clientFeedbackList, listClientLinks } from '~~/server/services/client'

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event, 'admin')
  return { links: await listClientLinks(db, p.id), feedback: await clientFeedbackList(db, p.id), okApproves: !!p.setup?.client?.okApproves }
})
