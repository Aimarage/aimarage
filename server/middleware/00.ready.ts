import { appReady } from '../lib/bootstrap'

export default defineEventHandler(async () => {
  await appReady()
})
