import { randomUUID } from 'node:crypto'
import type { DraftMedia } from '../db/schema'
import { safeFetch } from './site'
import { checkKey, StorageError, useStorage } from './storage'

export const MEDIA_TYPES: Record<string, { ext: string, kind: 'image' | 'video', max: number }> = {
  'image/jpeg': { ext: 'jpg', kind: 'image', max: 8 * 1024 * 1024 },
  'image/png': { ext: 'png', kind: 'image', max: 8 * 1024 * 1024 },
  'image/webp': { ext: 'webp', kind: 'image', max: 8 * 1024 * 1024 },
  'image/gif': { ext: 'gif', kind: 'image', max: 8 * 1024 * 1024 },
  'video/mp4': { ext: 'mp4', kind: 'video', max: 200 * 1024 * 1024 },
  'video/quicktime': { ext: 'mov', kind: 'video', max: 200 * 1024 * 1024 },
}

export const MAX_MEDIA_PER_DRAFT = 10

export class MediaError extends Error {}

export function mediaKind(mime: string): 'image' | 'video' | null {
  return MEDIA_TYPES[mime]?.kind ?? null
}

export function sniff(data: Uint8Array): string | null {
  const b = (i: number) => data[i] ?? -1
  if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'image/jpeg'
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return 'image/png'
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'image/gif'
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp'
  const box = String.fromCharCode(b(4), b(5), b(6), b(7))
  if (box === 'ftyp') {
    const brand = String.fromCharCode(b(8), b(9), b(10), b(11))
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4'
  }
  return null
}

export function cleanName(name: string): string {
  return name.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'datei'
}

export function mediaKey(file: string): string {
  try {
    return checkKey(file)
  }
  catch (err) {
    if (err instanceof StorageError) throw new MediaError(err.message)
    throw err
  }
}

export function checkMedia(data: Uint8Array): { mime: string, ext: string, kind: 'image' | 'video' } {
  const mime = sniff(data)
  const t = mime ? MEDIA_TYPES[mime] : null
  if (!mime || !t) throw new MediaError('Nur Bilder (JPG, PNG, WebP, GIF) oder Videos (MP4, MOV)')
  if (data.byteLength > t.max) throw new MediaError(`Datei zu groß (max. ${Math.round(t.max / 1024 / 1024)} MB)`)
  return { mime, ext: t.ext, kind: t.kind }
}

export async function storeFile(dir: string[], ext: string, data: Uint8Array, contentType?: string): Promise<{ id: string, file: string }> {
  const id = randomUUID()
  const file = mediaKey([...dir, `${id}.${ext}`].join('/'))
  await useStorage().put(file, data, contentType)
  return { id, file }
}

export async function storeMedia(dir: string[], input: { name: string, data: Uint8Array }): Promise<DraftMedia> {
  const { mime, ext } = checkMedia(input.data)
  const { id, file } = await storeFile(dir, ext, input.data, mime)
  return { id, name: cleanName(input.name), mime, size: input.data.byteLength, file }
}

export async function saveMedia(workspaceId: string, draftId: string, input: { name: string, data: Uint8Array }): Promise<DraftMedia> {
  return storeMedia([workspaceId, draftId], input)
}

export async function copyMedia(workspaceId: string, draftId: string, src: Pick<DraftMedia, 'name' | 'mime' | 'size' | 'file'>): Promise<DraftMedia> {
  const ext = MEDIA_TYPES[src.mime]?.ext
  if (!ext) throw new MediaError('Unbekannter Dateityp')
  const id = randomUUID()
  const file = mediaKey([workspaceId, draftId, `${id}.${ext}`].join('/'))
  await useStorage().copy(mediaKey(src.file), file)
  return { id, name: src.name, mime: src.mime, size: src.size, file }
}

export async function removeFile(file: string): Promise<void> {
  await useStorage().remove(mediaKey(file))
}

export async function readFileData(file: string): Promise<Uint8Array> {
  return useStorage().get(mediaKey(file))
}

export async function readMedia(m: Pick<DraftMedia, 'file'>): Promise<Uint8Array> {
  return readFileData(m.file)
}

export async function fileExists(file: string): Promise<boolean> {
  return useStorage().stat(mediaKey(file)).then(s => !!s, () => false)
}

export async function mediaExists(m: Pick<DraftMedia, 'file'>): Promise<boolean> {
  return fileExists(m.file)
}

export async function removeMedia(m: Pick<DraftMedia, 'file'>): Promise<void> {
  await removeFile(m.file)
}

export async function openFile(file: string): Promise<{ size: number, stream: () => Promise<import('node:stream').Readable> } | null> {
  let key: string
  try {
    key = mediaKey(file)
  }
  catch {
    return null
  }
  const storage = useStorage()
  const info = await storage.stat(key).catch(() => null)
  if (!info) return null
  return { size: info.size, stream: () => storage.stream(key) }
}

export async function fetchImage(url: string, fetchImpl: typeof fetch = fetch): Promise<{ name: string, data: Uint8Array } | null> {
  const res = await safeFetch(url, { method: 'GET', headers: { Accept: 'image/*' }, signal: AbortSignal.timeout(15_000) }, fetchImpl)
  if (!res.ok || !/^image\//i.test(res.headers.get('content-type') ?? 'image/')) return null
  const max = MEDIA_TYPES['image/jpeg']!.max
  if (Number(res.headers.get('content-length') ?? 0) > max) return null
  const data = new Uint8Array(await res.arrayBuffer())
  if (data.byteLength > max) return null
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'bild')
  return { name, data }
}
