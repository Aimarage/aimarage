import { closeDb, getDb } from '../server/lib/db'
import { runWorker } from '../server/lib/worker'

const controller = new AbortController()
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => controller.abort())
}

await runWorker(getDb, { signal: controller.signal })
await closeDb()
