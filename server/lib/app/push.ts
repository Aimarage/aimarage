import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect, type ClientHttp2Session } from 'node:http2'
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { projectCond, projectAccess } from '../access'
import { draftLists } from '../approval-lists'
import type { Db } from '../db'
import { schema } from '../db'
import { envValue } from '../config'

type Device = typeof schema.appDevices.$inferSelect

export interface ApnsConfig { key: KeyObject, keyId: string, teamId: string, topic: string }

export interface PushMessage {
  title: string
  body: string
  badge?: number
  category?: string
  data?: Record<string, string>
  threadId?: string
}

export type PushSender = (device: Device, msg: PushMessage) => Promise<{ ok: boolean, gone?: boolean, error?: string }>

// Apple-Schlüssel (.p8) aus APNS_KEY (Inhalt oder Pfad), dazu APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC (Bundle-ID).
export function apnsConfig(): ApnsConfig | null {
  const raw = envValue('APNS_KEY')?.trim()
  const keyId = envValue('APNS_KEY_ID')?.trim()
  const teamId = envValue('APNS_TEAM_ID')?.trim()
  if (!raw || !keyId || !teamId) return null
  const pem = raw.includes('BEGIN PRIVATE KEY') ? raw.replace(/\\n/g, '\n') : readFileSync(raw, 'utf8')
  return { key: createPrivateKey(pem), keyId, teamId, topic: envValue('APNS_TOPIC')?.trim() || 'com.mayer.aimarage' }
}

let jwtCache: { token: string, at: number } | null = null

// Anbieter-Token für APNs (ES256), Apple erlaubt eine Erneuerung höchstens alle 20 Minuten.
export function apnsJwt(cfg: ApnsConfig, nowMs = Date.now()): string {
  if (jwtCache && nowMs - jwtCache.at < 40 * 60_000) return jwtCache.token
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = `${b64({ alg: 'ES256', kid: cfg.keyId })}.${b64({ iss: cfg.teamId, iat: Math.floor(nowMs / 1000) })}`
  const sig = sign('sha256', Buffer.from(head), { key: cfg.key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  jwtCache = { token: `${head}.${sig}`, at: nowMs }
  return jwtCache.token
}

export function apnsPayload(msg: PushMessage): Record<string, unknown> {
  return {
    aps: {
      'alert': { title: msg.title, body: msg.body },
      'sound': 'default',
      ...(msg.badge !== undefined ? { badge: msg.badge } : {}),
      ...(msg.category ? { category: msg.category } : {}),
      ...(msg.threadId ? { 'thread-id': msg.threadId } : {}),
    },
    ...msg.data,
  }
}

const sessions = new Map<string, ClientHttp2Session>()

function http2For(host: string): ClientHttp2Session {
  const s = sessions.get(host)
  if (s && !s.closed && !s.destroyed) return s
  const next = connect(`https://${host}`)
  next.on('error', () => sessions.delete(host))
  next.on('close', () => sessions.delete(host))
  next.unref()
  sessions.set(host, next)
  return next
}

export function apnsSender(cfg: ApnsConfig): PushSender {
  return (device, msg) => new Promise((resolve) => {
    const host = device.pushEnv === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com'
    const req = http2For(host).request({
      ':method': 'POST',
      ':path': `/3/device/${device.pushToken}`,
      'authorization': `bearer ${apnsJwt(cfg)}`,
      'apns-topic': cfg.topic,
      'apns-push-type': 'alert',
      'content-type': 'application/json',
    })
    let status = 0
    let body = ''
    req.setTimeout(15_000, () => req.close())
    req.on('response', (h) => { status = Number(h[':status']) })
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      const reason = (() => {
        try {
          return (JSON.parse(body) as { reason?: string }).reason
        }
        catch {
          return undefined
        }
      })()
      resolve({ ok: status === 200, gone: status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered', error: status === 200 ? undefined : `${status} ${reason ?? ''}`.trim() })
    })
    req.on('error', err => resolve({ ok: false, error: err.message }))
    req.end(JSON.stringify(apnsPayload(msg)))
  })
}

const tx = (l: string | null, de: string, en: string) => (l === 'en' ? en : de)

// Neue Freigaben melden: je Person einmal je Entwurf (push_sent), mit Anzahl als Kennzahl am App-Symbol.
export async function notifyApprovals(db: Db, send: PushSender | null = null): Promise<number> {
  const cfg = send ? null : apnsConfig()
  const sender = send ?? (cfg ? apnsSender(cfg) : null)
  if (!sender) return 0
  const devices = await db.select().from(schema.appDevices)
  if (!devices.length) return 0
  const groups = new Map<string, Device[]>()
  for (const d of devices) groups.set(`${d.workspaceId}|${d.userId}`, [...groups.get(`${d.workspaceId}|${d.userId}`) ?? [], d])
  let sent = 0
  for (const list of groups.values()) {
    const { workspaceId, userId } = list[0]!
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId))
    const [m] = await db.select({ role: schema.memberships.role }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, userId)))
    if (!ws || !m || ws.pausedAt || ws.deletedAt) continue
    const access = await projectAccess(db, { workspaceId, userId, role: m.role })
    const lists = await draftLists(db, ws, projectCond(access, schema.tasks.projectId))
    const open = lists.yours.filter(r => r.draft.status === 'offen' && (!r.view.userId || r.view.userId === userId))
    if (!open.length) continue
    const keys = open.map(r => `draft:${r.task.id}`)
    const done = new Set((await db.select({ key: schema.pushSent.key }).from(schema.pushSent).where(and(eq(schema.pushSent.userId, userId), inArray(schema.pushSent.key, keys)))).map(r => r.key))
    const fresh = open.filter(r => !done.has(`draft:${r.task.id}`))
    if (!fresh.length) continue
    const locale = list[0]!.locale
    const one = fresh.length === 1 ? fresh[0]! : null
    // Knöpfe nur, wenn die App den Entwurf freigeben kann: keine Mail, keine offene Rückfrage.
    const buttons = !!one && one.draft.kind !== 'mail' && !(await hasQuestion(db, one.task.id, one.draft.createdAt))
    const msg: PushMessage = one
      ? { title: tx(locale, 'Freigabe', 'Approval'), body: one.task.title, badge: open.length, ...(buttons ? { category: 'APPROVAL' } : {}), data: { approvalId: one.draft.id }, threadId: 'approvals' }
      : { title: tx(locale, 'Freigaben', 'Approvals'), body: tx(locale, `${fresh.length} neue Entwürfe warten auf dich.`, `${fresh.length} new drafts are waiting for you.`), badge: open.length, threadId: 'approvals' }
    for (const d of list) {
      const res = await sender(d, msg)
      if (res.gone) await db.delete(schema.appDevices).where(eq(schema.appDevices.id, d.id))
      else if (res.ok) {
        sent++
        await db.update(schema.appDevices).set({ lastPushAt: new Date() }).where(eq(schema.appDevices.id, d.id))
      }
      else console.error('[push]', res.error)
    }
    await db.insert(schema.pushSent).values(fresh.map(r => ({ userId, key: `draft:${r.task.id}` }))).onConflictDoNothing()
  }
  return sent
}

async function hasQuestion(db: Db, taskId: string, since: Date): Promise<boolean> {
  const [n] = await db.select({ id: schema.taskNotes.id }).from(schema.taskNotes)
    .where(and(eq(schema.taskNotes.taskId, taskId), eq(schema.taskNotes.byAgent, true), sql`${schema.taskNotes.text} like 'Info nötig:%'`, gte(schema.taskNotes.createdAt, new Date(since.getTime() - 2000))))
    .limit(1)
  return !!n
}

export async function prunePushSent(db: Db): Promise<void> {
  await db.delete(schema.pushSent).where(lt(schema.pushSent.sentAt, new Date(Date.now() - 60 * 86_400_000)))
}

export function pushReady(): boolean {
  try {
    return !!apnsConfig()
  }
  catch {
    return false
  }
}
