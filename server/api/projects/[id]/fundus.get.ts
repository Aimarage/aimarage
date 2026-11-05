import { fundusView, listFundus } from '~~/server/lib/fundus'

export default defineEventHandler(async (event) => {
  const { db, p } = await projectById(event)
  const items = await listFundus(db, p.id, { checkedOnly: getQuery(event).checked === '1' })
  return { items: items.map(fundusView) }
})
