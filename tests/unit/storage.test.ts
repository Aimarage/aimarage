import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AwsClient } from 'aws4fetch'
import { copyMedia, fileExists, openFile, readMedia, removeMedia, storeMedia } from '../../server/lib/media'
import { checkKey, LocalStorage, type MediaStorage, parseListXml, purgeWorkspaceStorage, resetStorage, S3Storage, useStorage, workspaceStorageBytes } from '../../server/lib/storage'
import { migrateStorage } from '../../server/lib/storage-migrate'

const JPG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4])
const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

async function readAll(s: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of s) chunks.push(Buffer.from(c as Buffer))
  return Buffer.concat(chunks).toString()
}

async function roundTrip(s: MediaStorage) {
  await s.put('ws/d1/a.txt', bytes('hallo'))
  expect(text(await s.get('ws/d1/a.txt'))).toBe('hallo')
  expect(await s.stat('ws/d1/a.txt')).toEqual({ size: 5 })
  expect(await s.stat('ws/d1/fehlt.txt')).toBeNull()
  expect(await readAll(await s.stream('ws/d1/a.txt'))).toBe('hallo')
  await s.copy('ws/d1/a.txt', 'ws/d2/b.txt')
  expect(text(await s.get('ws/d2/b.txt'))).toBe('hallo')
  expect((await s.list()).map(o => o.key)).toEqual(['ws/d1/a.txt', 'ws/d2/b.txt'])
  await s.remove('ws/d1/a.txt')
  await s.remove('ws/d1/a.txt')
  expect(await s.stat('ws/d1/a.txt')).toBeNull()
  expect((await s.list()).map(o => o.key)).toEqual(['ws/d2/b.txt'])
  await s.put('wsx/d1/c.txt', bytes('abc'))
  expect((await s.list('ws')).map(o => o.key)).toEqual(['ws/d2/b.txt'])
  expect(await workspaceStorageBytes('wsx', s)).toBe(3)
  expect(await purgeWorkspaceStorage('wsx', s)).toBe(1)
  expect((await s.list()).map(o => o.key)).toEqual(['ws/d2/b.txt'])
}

function fakeS3(): Promise<{ server: Server, endpoint: string, objects: Map<string, Buffer> }> {
  const objects = new Map<string, Buffer>()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x')
    const key = decodeURIComponent(url.pathname.slice(1))
    if (!/^AWS4-HMAC-SHA256 Credential=key\//.test(req.headers.authorization ?? '')) return res.writeHead(403).end()
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const bucket = key.split('/')[0]!
      const prefix = url.searchParams.get('prefix') ?? ''
      const items = [...objects.entries()].filter(([k]) => k.startsWith(`${bucket}/${prefix}`)).sort()
      const xml = items.map(([k, v]) => `<Contents><Key>${k.slice(bucket.length + 1).replace(/&/g, '&amp;')}</Key><Size>${v.length}</Size></Contents>`).join('')
      return res.writeHead(200, { 'Content-Type': 'application/xml' }).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${xml}</ListBucketResult>`)
    }
    if (req.method === 'PUT') {
      const src = req.headers['x-amz-copy-source']
      if (typeof src === 'string') {
        const data = objects.get(decodeURIComponent(src.slice(1)))
        if (!data) return res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>')
        objects.set(key, data)
        return res.writeHead(200).end('<CopyObjectResult/>')
      }
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      objects.set(key, Buffer.concat(chunks))
      return res.writeHead(200).end()
    }
    const data = objects.get(key)
    if (req.method === 'DELETE') {
      objects.delete(key)
      return res.writeHead(204).end()
    }
    if (!data) return res.writeHead(404).end()
    res.writeHead(200, { 'Content-Length': data.length })
    return res.end(req.method === 'HEAD' ? undefined : data)
  })
  return new Promise(ok => server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number }
    ok({ server, endpoint: `http://127.0.0.1:${addr.port}`, objects })
  }))
}

describe('Speicher-Schicht', () => {
  it('lässt keine fremden Pfade zu', () => {
    expect(checkKey('ws/d/a.jpg')).toBe('ws/d/a.jpg')
    for (const bad of ['../a.jpg', 'ws/../../etc/passwd', '/abs.jpg', 'ws//a.jpg', 'ws/.hidden', 'ws/a..b/c']) expect(() => checkKey(bad)).toThrow()
  })

  it('liest S3-Listen', () => {
    const page = parseListXml('<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>p/a&amp;b.jpg</Key><Size>3</Size></Contents><NextContinuationToken>t1</NextContinuationToken></ListBucketResult>')
    expect(page).toEqual({ items: [{ key: 'p/a&b.jpg', size: 3 }], next: 't1' })
  })

  it('lokal: schreiben, lesen, kopieren, auflisten, löschen', async () => {
    await roundTrip(new LocalStorage(mkdtempSync(join(tmpdir(), 'ma-store-'))))
  })

  it('Migration ist wiederholbar und kennt einen Probelauf', async () => {
    const from = new LocalStorage(mkdtempSync(join(tmpdir(), 'ma-from-')))
    const to = new LocalStorage(mkdtempSync(join(tmpdir(), 'ma-to-')))
    await from.put('ws/d/a.jpg', JPG)
    await from.put('ws/docs/p/b.pdf', bytes('%PDF-1'))
    await to.put('ws/docs/p/b.pdf', bytes('%PDF-1'))
    const dry = await migrateStorage(from, to, { dryRun: true })
    expect(dry).toMatchObject({ total: 2, copied: ['ws/d/a.jpg'], skipped: 1, failed: [] })
    expect(await to.stat('ws/d/a.jpg')).toBeNull()
    expect((await migrateStorage(from, to)).copied).toEqual(['ws/d/a.jpg'])
    expect(await to.get('ws/d/a.jpg')).toEqual(JPG)
    expect(await migrateStorage(from, to)).toMatchObject({ copied: [], skipped: 2 })
    expect(await from.stat('ws/d/a.jpg')).toEqual({ size: JPG.length })
  })
})

describe('S3-Ablage gegen einen S3-Nachbau', () => {
  let fake: Awaited<ReturnType<typeof fakeS3>>
  beforeAll(async () => {
    fake = await fakeS3()
  })
  afterAll(() => new Promise<void>(ok => fake.server.close(() => ok())))
  afterEach(() => {
    for (const k of ['STORAGE_DRIVER', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_PREFIX', 'MEDIA_DIR']) delete process.env[k]
    resetStorage()
  })

  it('Grundfunktionen mit Präfix', async () => {
    fake.objects.clear()
    await roundTrip(new S3Storage({ endpoint: fake.endpoint, region: 'fsn1', bucket: 'b', accessKey: 'key', secretKey: 'geheim', prefix: '/live/' }))
    expect([...fake.objects.keys()]).toEqual(['b/live/ws/d2/b.txt'])
  })

  it('Medien, Kopien, Links und Löschen laufen mit STORAGE_DRIVER=s3 über den Bucket', async () => {
    fake.objects.clear()
    Object.assign(process.env, { STORAGE_DRIVER: 's3', S3_ENDPOINT: fake.endpoint, S3_BUCKET: 'b', S3_ACCESS_KEY: 'key', S3_SECRET_KEY: 'geheim', S3_PREFIX: 'live', MEDIA_DIR: mkdtempSync(join(tmpdir(), 'ma-unused-')) })
    expect(useStorage().name).toBe('s3')
    const m = await storeMedia(['ws', 'fundus', 'p'], { name: 'a.jpg', data: JPG })
    expect(fake.objects.has(`b/live/${m.file}`)).toBe(true)
    const c = await copyMedia('ws', 'd', m)
    expect(await readMedia(c)).toEqual(JPG)
    const f = await openFile(c.file)
    expect(f?.size).toBe(JPG.length)
    expect(await openFile('../x.jpg')).toBeNull()
    await removeMedia(m)
    expect(await fileExists(m.file)).toBe(false)
    expect(await fileExists(c.file)).toBe(true)
  })

  it('Migration lokal -> S3', async () => {
    fake.objects.clear()
    const from = new LocalStorage(mkdtempSync(join(tmpdir(), 'ma-mig-')))
    await from.put('ws/d/a.jpg', JPG)
    const to = new S3Storage({ endpoint: fake.endpoint, region: 'fsn1', bucket: 'b', accessKey: 'key', secretKey: 'geheim' })
    expect((await migrateStorage(from, to, { dryRun: true })).copied).toEqual(['ws/d/a.jpg'])
    expect(fake.objects.size).toBe(0)
    expect((await migrateStorage(from, to)).copied).toEqual(['ws/d/a.jpg'])
    expect(await migrateStorage(from, to)).toMatchObject({ copied: [], skipped: 1 })
  })

  it('ohne Zugangsdaten klare Fehlermeldung', () => {
    expect(() => new S3Storage({ endpoint: '', region: '', bucket: '', accessKey: '', secretKey: '' })).toThrow(/S3_ENDPOINT/)
  })
})

const endpoint = process.env.S3_TEST_ENDPOINT
describe.skipIf(!endpoint)('S3-Ablage gegen echten S3-Server (MinIO)', () => {
  it('Grundfunktionen', async () => {
    const accessKey = process.env.S3_TEST_KEY!
    const secretKey = process.env.S3_TEST_SECRET!
    const bucket = `aimarage-test-${Date.now()}`
    const admin = new AwsClient({ accessKeyId: accessKey, secretAccessKey: secretKey, service: 's3', region: 'us-east-1' })
    expect((await admin.fetch(`${endpoint}/${bucket}`, { method: 'PUT' })).ok).toBe(true)
    await roundTrip(new S3Storage({ endpoint: endpoint!, region: 'us-east-1', bucket, accessKey, secretKey, prefix: 'test' }))
  })
})
