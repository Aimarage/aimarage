import type { DraftMedia } from '../db/schema'
import { config } from './config'
import { MEDIA_TYPES } from './media'
import { decryptSecret, encryptSecret } from './secret'

const CONTEXT = 'media-link'
export const MEDIA_LINK_TTL_S = 2 * 86_400

export function isPublicBase(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  }
  catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h || h === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(h)) return false
  if (!h.includes('.') && !h.includes(':')) return false
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return false
  if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:')) return false
  return true
}

export function mediaLinkBase(): string | null {
  const base = config.publicUrl
  return isPublicBase(base) ? base : null
}

export function mediaLink(m: Pick<DraftMedia, 'file' | 'mime'>, base: string, at = Date.now()): string {
  const token = encryptSecret(JSON.stringify({ f: m.file, t: m.mime, e: Math.floor(at / 1000) + MEDIA_LINK_TTL_S }), CONTEXT)
  return `${base.replace(/\/+$/, '')}/m/${token}.${MEDIA_TYPES[m.mime]?.ext ?? 'bin'}`
}

export function openMediaLink(name: string, at = Date.now()): { file: string, mime: string } | null {
  const token = name.replace(/\.[a-z0-9]{2,4}$/i, '')
  const plain = decryptSecret(token, CONTEXT)
  if (!plain) return null
  try {
    const d = JSON.parse(plain) as { f?: unknown, t?: unknown, e?: unknown }
    if (typeof d.f !== 'string' || typeof d.t !== 'string' || typeof d.e !== 'number') return null
    if (d.e * 1000 < at || !MEDIA_TYPES[d.t]) return null
    return { file: d.f, mime: d.t }
  }
  catch {
    return null
  }
}
