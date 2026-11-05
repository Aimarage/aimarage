import { appReady } from '../lib/bootstrap'

export default defineNitroPlugin(() => {
  appReady().catch(err => console.error('[db] Start fehlgeschlagen:', err))
})
