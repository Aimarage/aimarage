// Kopiert die lokalen Medien (MEDIA_DIR) in den S3-Bucket aus S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_PREFIX.
// Idempotent: schon vorhandene Dateien mit gleicher Größe werden übersprungen. Lokal wird nichts gelöscht.
// Aufruf: npm run storage:migrate -- [--dry-run] [--check]
// --check: nur prüfen, ob der Bucket mit den Zugangsdaten erreichbar ist (Testdatei schreiben, lesen, löschen).
import { config } from '../server/lib/config'
import { localStorageDriver, s3StorageDriver } from '../server/lib/storage'
import { migrateStorage } from '../server/lib/storage-migrate'

const dryRun = process.argv.includes('--dry-run')
const from = localStorageDriver()
let to
try {
  to = s3StorageDriver()
}
catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}

if (process.argv.includes('--check')) {
  const key = `probe/check-${Date.now()}.txt`
  try {
    await to.put(key, new TextEncoder().encode('aimarage'), 'text/plain')
    const back = new TextDecoder().decode(await to.get(key))
    await to.remove(key)
    if (back !== 'aimarage') throw new Error('Inhalt stimmt nicht')
    console.log(`Bucket erreichbar: ${config.s3.endpoint}/${config.s3.bucket}${config.s3.prefix ? `/${config.s3.prefix}` : ''}`)
    process.exit(0)
  }
  catch (err) {
    console.error(`Bucket nicht erreichbar: ${(err as Error).message}`)
    process.exit(1)
  }
}

console.log(`${dryRun ? 'Probelauf' : 'Kopiere'}: ${config.mediaDir} -> ${config.s3.endpoint}/${config.s3.bucket}${config.s3.prefix ? `/${config.s3.prefix}` : ''}`)
const res = await migrateStorage(from, to, { dryRun, log: line => console.log(line) })
console.log(`${res.total} Dateien, ${dryRun ? 'zu kopieren' : 'kopiert'} ${res.copied.length}, schon da ${res.skipped}, Fehler ${res.failed.length}`)
if (res.failed.length) process.exit(1)
if (!dryRun && config.storageDriver !== 's3') console.log('Jetzt STORAGE_DRIVER=s3 setzen und neu starten.')
