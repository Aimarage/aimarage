import type { FetchLike, OutletMedia } from '../outlets'
import { firstUrl, jsonOf, PlatformError, statusText, timeoutSignal, wait, type AdapterCtx, type Creds, type PlatformAdapter, type SocialConn } from './types'

const API = 'https://api.telegram.org'
export const TG_MAX_TEXT = 4096
export const TG_MAX_CAPTION = 1024
export const TG_MAX_PHOTO = 10_000_000
export const TG_MAX_VIDEO = 50_000_000

type Json = Record<string, unknown>

export function telegramChat(input: string): string {
  const raw = input.trim()
  if (/^-?\d+$/.test(raw)) return raw
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]+)\/?$/i.exec(raw)
  const name = (m ? m[1]! : raw).replace(/^@/, '')
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name)) throw new PlatformError('Telegram: Kanal als @kanalname, t.me/kanalname oder Chat-ID (z.B. -1001234567890) angeben')
  return `@${name}`
}

export function telegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function telegramPostUrl(conn: Pick<SocialConn, 'handle' | 'ext'>, messageId: number | string): string | null {
  if (conn.handle) return `https://t.me/${conn.handle}/${messageId}`
  const id = conn.ext?.chatId ?? ''
  return /^-100\d+$/.test(id) ? `https://t.me/c/${id.slice(4)}/${messageId}` : null
}

export async function tgCall(token: string, method: string, body: Json | FormData, ctx: Pick<AdapterCtx, 'fetch' | 'sleep'>, ms = 30_000): Promise<Json> {
  const isForm = body instanceof FormData
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await ctx.fetch(`${API}/bot${token}/${method}`, { method: 'POST', ...(isForm ? {} : { headers: { 'Content-Type': 'application/json' } }), body: isForm ? body : JSON.stringify(body), signal: timeoutSignal(ms) })
    }
    catch (err) {
      throw new PlatformError(`Telegram: nicht erreichbar (${(err as Error).message.split(token).join('***').replace(/https?:\/\/\S+/g, '').slice(0, 120)})`)
    }
    const data = await jsonOf(res)
    if (res.ok && data.ok === true) return data
    const retry = Number((data.parameters as Json | undefined)?.retry_after ?? 0)
    if (res.status === 429 && attempt === 0 && retry > 0 && retry <= 30) {
      await wait(ctx, retry * 1000)
      continue
    }
    const desc = typeof data.description === 'string' ? data.description.split(token).join('***').slice(0, 300) : ''
    if (res.status === 401 || res.status === 404) throw new PlatformError('Telegram: Bot-Token abgelehnt (bei @BotFather neu kopieren)', res.status)
    throw new PlatformError(`Telegram: ${res.status >= 500 || res.status === 429 ? statusText(res.status) : `HTTP ${res.status}${desc ? `: ${desc}` : ''}`}`, res.status)
  }
}

function chatId(conn: Pick<SocialConn, 'ext' | 'handle'>): string {
  const id = conn.ext?.chatId || (conn.handle ? `@${conn.handle}` : '')
  if (!id) throw new PlatformError('Telegram: Kanal fehlt, bitte neu verbinden')
  return id
}

function mediaMethod(m: OutletMedia): { method: 'sendPhoto' | 'sendVideo', field: 'photo' | 'video', max: number } | null {
  if (/^image\/(jpeg|png|webp)$/.test(m.mime)) return { method: 'sendPhoto', field: 'photo', max: TG_MAX_PHOTO }
  if (m.mime.startsWith('video/')) return { method: 'sendVideo', field: 'video', max: TG_MAX_VIDEO }
  return null
}

export const telegramAdapter: PlatformAdapter = {
  provider: 'telegram',
  label: 'Telegram',
  platforms: ['telegram'],
  async post(conn, creds, req, ctx) {
    const chat = chatId(conn)
    const text = req.text.trim()
    const media = req.media.find(m => mediaMethod(m))
    let data: Json
    if (media) {
      const how = mediaMethod(media)!
      if ([...text].length > TG_MAX_CAPTION) throw new PlatformError(`Telegram: Bildunterschrift länger als ${TG_MAX_CAPTION} Zeichen`)
      if (media.data.byteLength > how.max) throw new PlatformError(`Telegram: Datei größer als ${how.max / 1_000_000} MB`)
      const fd = new FormData()
      fd.append('chat_id', chat)
      fd.append(how.field, new Blob([media.data as unknown as ArrayBuffer], { type: media.mime }), media.name || 'bild')
      if (text) {
        fd.append('caption', telegramHtml(text))
        fd.append('parse_mode', 'HTML')
      }
      data = await tgCall(creds.token!, how.method, fd, ctx, 120_000)
    }
    else {
      if (!text) throw new PlatformError('Telegram: Text fehlt')
      if ([...text].length > TG_MAX_TEXT) throw new PlatformError(`Telegram: Text länger als ${TG_MAX_TEXT} Zeichen`)
      const link = req.link ?? firstUrl(text)
      data = await tgCall(creds.token!, 'sendMessage', { chat_id: chat, text: telegramHtml(text), parse_mode: 'HTML', link_preview_options: link ? { url: link, prefer_large_media: true } : { is_disabled: true } }, ctx)
    }
    const msg = data.result as Json
    const id = String(msg.message_id)
    const username = typeof (msg.chat as Json | undefined)?.username === 'string' ? String((msg.chat as Json).username) : conn.handle
    return { platform: 'telegram', ok: true, postId: id, url: telegramPostUrl({ handle: username ?? null, ext: conn.ext }, id) }
  },
  async followers(conn, creds, ctx) {
    const d = await tgCall(creds.token!, 'getChatMemberCount', { chat_id: chatId(conn) }, ctx, 15_000)
    return typeof d.result === 'number' ? d.result : null
  },
}

export async function verifyTelegram(input: { token: string, chat: string }, f: FetchLike): Promise<{ creds: Creds, conn: Omit<SocialConn, 'id' | 'secret'> }> {
  const token = input.token.trim()
  if (!/^\d+:[\w-]{20,}$/.test(token)) throw new PlatformError('Telegram: Das sieht nicht wie ein Bot-Token aus (Form 123456789:ABC..., von @BotFather)')
  const ref = telegramChat(input.chat)
  const ctx = { fetch: f }
  const bot = (await tgCall(token, 'getMe', {}, ctx, 15_000)).result as Json
  let chat: Json
  try {
    chat = (await tgCall(token, 'getChat', { chat_id: ref }, ctx, 15_000)).result as Json
  }
  catch (err) {
    if (err instanceof PlatformError && (err.status === 400 || err.status === 403)) throw new PlatformError(`Telegram: Kanal ${ref} nicht gefunden oder der Bot ist dort nicht Mitglied. Bot als Admin zum Kanal hinzufügen.`, err.status)
    throw err
  }
  if (chat.type !== 'channel') throw new PlatformError('Telegram: Das ist kein Kanal. Aimarage postet nur in Telegram-Kanäle.')
  const member = (await tgCall(token, 'getChatMember', { chat_id: chat.id, user_id: bot.id }, ctx, 15_000)).result as Json
  const admin = member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages !== false)
  if (!admin) throw new PlatformError(`Telegram: Der Bot @${String(bot.username)} ist im Kanal kein Admin mit dem Recht "Nachrichten veröffentlichen".`)
  const handle = typeof chat.username === 'string' ? chat.username : null
  const title = typeof chat.title === 'string' && chat.title ? chat.title : handle ?? String(chat.id)
  return {
    creds: { token },
    conn: { provider: 'telegram', platform: 'telegram', name: handle ? `${title} (@${handle})` : title, handle, url: handle ? `https://t.me/${handle}` : null, ext: { chatId: String(chat.id), bot: String(bot.username ?? '') } },
  }
}
