import type { MediaStorage } from './storage'
import { contentTypeOf } from './storage'

export interface MigrateResult {
  total: number
  copied: string[]
  skipped: number
  failed: Array<{ key: string, error: string }>
}

// Kopiert alle Dateien von from nach to. Dateien, die im Ziel schon mit gleicher Größe liegen, bleiben unberührt,
// daher kann der Lauf beliebig oft wiederholt werden. Die Quelle wird nie verändert.
export async function migrateStorage(from: MediaStorage, to: MediaStorage, opts: { dryRun?: boolean, concurrency?: number, log?: (line: string) => void } = {}): Promise<MigrateResult> {
  const items = await from.list()
  const result: MigrateResult = { total: items.length, copied: [], skipped: 0, failed: [] }
  const queue = [...items]
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      try {
        const there = await to.stat(it.key)
        if (there && there.size === it.size) {
          result.skipped++
          continue
        }
        if (!opts.dryRun) await to.put(it.key, await from.get(it.key), contentTypeOf(it.key))
        result.copied.push(it.key)
        opts.log?.(`${opts.dryRun ? 'würde kopieren' : 'kopiert'}: ${it.key} (${it.size} B)`)
      }
      catch (err) {
        result.failed.push({ key: it.key, error: (err as Error).message })
        opts.log?.(`Fehler: ${it.key}: ${(err as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker))
  return result
}
