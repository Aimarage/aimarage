import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { AwsClient } from 'aws4fetch'
import { config } from './config'

// Ablage für hochgeladene Dateien (Medien, Fundus, Unterlagen). Schlüssel sind relative Pfade wie
// "<workspace>/<draft>/<uuid>.jpg", lokal unter MEDIA_DIR, in S3 unter S3_PREFIX im Bucket.

export interface StoredObject {
  size: number
}

export interface ListedObject extends StoredObject {
  key: string
}

export interface MediaStorage {
  readonly name: 'local' | 's3'
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>
  get(key: string): Promise<Uint8Array>
  stat(key: string): Promise<StoredObject | null>
  stream(key: string): Promise<Readable>
  copy(from: string, to: string): Promise<void>
  remove(key: string): Promise<void>
  list(prefix?: string): Promise<ListedObject[]>
}

export class StorageError extends Error {}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function checkKey(key: string): string {
  const parts = key.split(/[\\/]/)
  if (!parts.length || parts.length > 8 || parts.some(p => !SEGMENT.test(p) || p.includes('..'))) throw new StorageError('Ungültiger Pfad')
  return parts.join('/')
}

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime',
  pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export function contentTypeOf(key: string): string {
  return TYPES[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

export class LocalStorage implements MediaStorage {
  readonly name = 'local' as const

  constructor(private readonly root: string) {}

  path(key: string): string {
    const root = resolve(this.root)
    const full = resolve(root, checkKey(key))
    if (!full.startsWith(root + sep)) throw new StorageError('Ungültiger Pfad')
    return full
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const full = this.path(key)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, data, { mode: 0o600 })
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)))
  }

  async stat(key: string): Promise<StoredObject | null> {
    const s = await stat(this.path(key)).catch(() => null)
    return s?.isFile() ? { size: s.size } : null
  }

  async stream(key: string): Promise<Readable> {
    return createReadStream(this.path(key))
  }

  async copy(from: string, to: string): Promise<void> {
    const dest = this.path(to)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(this.path(from), dest)
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true })
  }

  async list(prefix?: string): Promise<ListedObject[]> {
    const root = resolve(this.root)
    const out: ListedObject[] = []
    const start = prefix ? checkKey(prefix.replace(/\/+$/, '')).split('/') : []
    const walk = async (dir: string, rel: string[]) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (!SEGMENT.test(e.name)) continue
        if (e.isDirectory()) await walk(join(dir, e.name), [...rel, e.name])
        else if (e.isFile()) out.push({ key: [...rel, e.name].join('/'), size: (await stat(join(dir, e.name))).size })
      }
    }
    await walk(start.length ? join(root, ...start) : root, start)
    return out.sort((a, b) => a.key.localeCompare(b.key))
  }
}

export interface S3Options {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  prefix?: string
}

export class S3Storage implements MediaStorage {
  readonly name = 's3' as const
  private readonly client: AwsClient
  private readonly bucketUrl: string
  private readonly keyPrefix: string

  constructor(opts: S3Options) {
    if (!opts.endpoint || !opts.bucket || !opts.accessKey || !opts.secretKey) throw new StorageError('S3-Ablage braucht S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY und S3_SECRET_KEY')
    this.client = new AwsClient({ accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey, service: 's3', region: opts.region || 'us-east-1' })
    this.bucketUrl = `${opts.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(opts.bucket)}`
    const prefix = (opts.prefix ?? '').replace(/^\/+|\/+$/g, '')
    this.keyPrefix = prefix ? `${prefix}/` : ''
  }

  objectKey(key: string): string {
    return this.keyPrefix + checkKey(key)
  }

  private url(key: string): string {
    return `${this.bucketUrl}/${this.objectKey(key).split('/').map(encodeURIComponent).join('/')}`
  }

  async put(key: string, data: Uint8Array, contentType?: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), {
      method: 'PUT',
      body: data as Uint8Array<ArrayBuffer>,
      headers: { 'Content-Type': contentType ?? contentTypeOf(key), 'Content-Length': String(data.byteLength), 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD' },
    })
    if (!res.ok) throw new StorageError(`S3 PUT ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`)
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.client.fetch(this.url(key))
    if (!res.ok) throw new StorageError(`S3 GET ${key}: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async stat(key: string): Promise<StoredObject | null> {
    const res = await this.client.fetch(this.url(key), { method: 'HEAD' })
    if (res.status === 404) return null
    if (!res.ok) throw new StorageError(`S3 HEAD ${key}: ${res.status}`)
    return { size: Number(res.headers.get('content-length') ?? 0) }
  }

  async stream(key: string): Promise<Readable> {
    const res = await this.client.fetch(this.url(key))
    if (!res.ok || !res.body) throw new StorageError(`S3 GET ${key}: ${res.status}`)
    return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  }

  async copy(from: string, to: string): Promise<void> {
    const bucket = decodeURIComponent(this.bucketUrl.split('/').pop()!)
    const source = `/${encodeURIComponent(bucket)}/${this.objectKey(from).split('/').map(encodeURIComponent).join('/')}`
    const res = await this.client.fetch(this.url(to), { method: 'PUT', headers: { 'x-amz-copy-source': source, 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD' } })
    const body = await res.text()
    if (!res.ok || /<Error>/.test(body)) throw new StorageError(`S3 COPY ${from}: ${res.status} ${body.slice(0, 200)}`)
  }

  async remove(key: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new StorageError(`S3 DELETE ${key}: ${res.status}`)
  }

  async list(prefix?: string): Promise<ListedObject[]> {
    const out: ListedObject[] = []
    const full = this.keyPrefix + (prefix ? `${checkKey(prefix.replace(/\/+$/, ''))}/` : '')
    let token: string | undefined
    do {
      const url = new URL(this.bucketUrl)
      url.searchParams.set('list-type', '2')
      if (full) url.searchParams.set('prefix', full)
      if (token) url.searchParams.set('continuation-token', token)
      const res = await this.client.fetch(url.toString())
      if (!res.ok) throw new StorageError(`S3 LIST: ${res.status}`)
      const page = parseListXml(await res.text())
      for (const o of page.items) out.push({ key: o.key.slice(this.keyPrefix.length), size: o.size })
      token = page.next
    } while (token)
    return out
  }
}

function xmlText(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&')
}

export function parseListXml(xml: string): { items: Array<{ key: string, size: number }>, next?: string } {
  const items = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => {
    const block = m[1]!
    const pick = (tag: string) => block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? ''
    return { key: xmlText(pick('Key')), size: Number(pick('Size')) }
  })
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
  const next = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1]
  return { items, next: truncated && next ? xmlText(next) : undefined }
}

let cached: { sig: string, driver: MediaStorage } | undefined

export function localStorageDriver(): LocalStorage {
  return new LocalStorage(config.mediaDir)
}

export function s3StorageDriver(): S3Storage {
  return new S3Storage(config.s3)
}

export function useStorage(): MediaStorage {
  const s3 = config.storageDriver === 's3'
  const sig = s3 ? JSON.stringify(['s3', config.s3]) : `local:${config.mediaDir}`
  if (cached?.sig !== sig) cached = { sig, driver: s3 ? s3StorageDriver() : localStorageDriver() }
  return cached.driver
}

export async function workspaceStorageBytes(workspaceId: string, storage: MediaStorage = useStorage()): Promise<number> {
  return (await storage.list(workspaceId)).reduce((n, o) => n + o.size, 0)
}

export async function purgeWorkspaceStorage(workspaceId: string, storage: MediaStorage = useStorage()): Promise<number> {
  const items = await storage.list(workspaceId)
  for (const o of items) await storage.remove(o.key)
  if (storage instanceof LocalStorage) await rm(storage.path(workspaceId), { recursive: true, force: true })
  return items.length
}

export function resetStorage(): void {
  cached = undefined
}
