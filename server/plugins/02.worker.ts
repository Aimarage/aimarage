import { config } from '../lib/config'
import { getDb } from '../lib/db'
import { runWorker } from '../lib/worker'

export default defineNitroPlugin((nitro) => {
  if (!config.workerInline || process.env.NODE_ENV === 'test') return
  const controller = new AbortController()
  void runWorker(getDb, { signal: controller.signal, log: m => console.log(`[worker] ${m}`) })
  nitro.hooks.hook('close', () => controller.abort())
})
