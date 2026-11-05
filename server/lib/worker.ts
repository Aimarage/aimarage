import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { minutesOf, startOfWeek, timeOf, weekday } from '../../shared/utils/dates'
import { runDailyBriefing, runDraftTask, runDraftTasks, runFollowups, runMaterialize, runOnboardProject, runMailSync, runPublishArticle, runWithdrawArticle, runPublishPost, runPublishStatus, runReconcileTasks, runRethinkStrategy, runSendMail, runSocialStats, runConnRecheck, runStrategyReview, runUtmSync, runWeeklyReport } from './agent'
import { nowTime, today } from './clock'
import { runTaskChecks } from './task-check'
import type { Db } from './db'
import { schema } from './db'
import { config } from './config'
import { extensionJobHandler, extensionSchedule, extensionSystemSchedule, reportError } from './extensions'
import { isLimitError } from './limits'
import { useStorage, workspaceStorageBytes } from './storage'
import { pruneSessions } from './auth'
import { pruneAuthCodes } from './auth-codes'
import { pruneRateLimits } from './ratelimit'
import { pruneCalls } from './api/call-log'
import { warnExpiringTokens } from './api/token-expiry'
import { runSearchSync, runSeoAudit, runSiteRead } from './seo-jobs'
import { runFeedSync } from './feeds'
import { runGeoCheck } from './geo'
import { digestDocument } from './documents'
import { runSystemMailJob } from './system-mail'
import { runMorningMail } from './morning-digest'
import { listeningSources, runListening, runListeningReply } from './listening'
import { hasTransientConn } from './connections'
import { drainTalk } from './talk'
import { claimJob, completeJob, enqueueJob, failJob, requeueStale, type JobRow, type JobType } from './jobs'
import { installBraveMeter } from './brave-usage'
import { cleanupZernio, recordZernioUsage } from './zernio'
import { notifyApprovals, prunePushSent, pushReady } from './app/push'

export interface ScheduleEntry {
  type: JobType
  time: string
  weekday?: number
  weekly?: boolean
}

// Routine-Jobs je Workspace um 0-45 Minuten versetzt, damit nicht alle Workspaces gleichzeitig starten.
// Fest bleiben das Briefing (eigene Uhrzeit) und alles mit eigenem Zeitpunkt (geplante Posts, Mails).
export const MAX_OFFSET_MIN = 45
const FIXED_TIME: JobType[] = ['daily_briefing']

export function workspaceOffset(workspaceId: string): number {
  return createHash('sha256').update(workspaceId).digest().readUInt32BE(0) % (MAX_OFFSET_MIN + 1)
}

export function shiftTime(time: string, offset: number, briefing: string): string {
  const t = minutesOf(time)
  const b = minutesOf(briefing)
  let m = t + offset
  if (t < b && m > b - 10) m = Math.max(t, b - 10)
  return timeOf(m)
}

export function scheduleFor(ws: typeof schema.workspaces.$inferSelect): ScheduleEntry[] {
  const briefing = ws.settings?.briefingTime || '06:30'
  const offset = workspaceOffset(ws.id)
  return baseSchedule(ws).map(e => FIXED_TIME.includes(e.type) ? e : { ...e, time: shiftTime(e.time, offset, briefing) })
}

function baseSchedule(ws: typeof schema.workspaces.$inferSelect): ScheduleEntry[] {
  return [
    { type: 'geo_check', time: '04:00', weekly: true },
    { type: 'strategy_review', time: '04:30', weekly: true },
    { type: 'materialize_recurrences', time: '05:00' },
    { type: 'draft_tasks', time: '05:30' },
    { type: 'followups', time: '06:00' },
    { type: 'daily_briefing', time: ws.settings?.briefingTime || '06:30' },
    { type: 'social_stats', time: '07:00' },
    { type: 'utm_sync', time: '07:15' },
    { type: 'search_sync', time: '07:30' },
    { type: 'seo_audit', time: '03:30', weekly: true },
    { type: 'site_read', time: '03:00', weekly: true },
    { type: 'weekly_report', time: '14:00', weekday: 5 },
  ]
}

export function dueEntries(entries: ScheduleEntry[], date: string, time: string): ScheduleEntry[] {
  return entries.filter(e => (e.weekly ? weekday(date) > 1 || minutesOf(time) >= minutesOf(e.time) : minutesOf(time) >= minutesOf(e.time)) && (!e.weekday || weekday(date) === e.weekday))
}

async function hasFeeds(db: Db, workspaceId: string): Promise<boolean> {
  const rows = await db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.workspaceId, workspaceId), sql`jsonb_array_length(coalesce(${schema.projects.setup}->'feeds', '[]'::jsonb)) > 0`, isNull(schema.projects.archivedAt))).limit(1)
  return rows.length > 0
}

async function hasMailbox(db: Db, workspaceId: string): Promise<boolean> {
  const rows = await db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.workspaceId, workspaceId), sql`${schema.projects.setup}->'mail' is not null`, isNull(schema.projects.archivedAt))).limit(1)
  return rows.length > 0
}

// Social Listening zweimal am Tag (je Workspace versetzt).
export const LISTEN_SLOTS = ['09:00', '17:00']

export const SYSTEM_TIMEZONE = 'Europe/Vienna'

export function systemSchedule(): ScheduleEntry[] {
  return [
    { type: 'storage_usage', time: '02:30' },
    ...extensionSystemSchedule() as ScheduleEntry[],
  ]
}

async function scheduleSystem(db: Db): Promise<number> {
  const d = today(SYSTEM_TIMEZONE)
  const t = nowTime(SYSTEM_TIMEZONE)
  let n = 0
  for (const e of dueEntries(systemSchedule(), d, t)) {
    if (await enqueueJob(db, e.type, { dedupeKey: `${e.type}:system:${e.weekly ? startOfWeek(d) : d}`, maxAttempts: 2 })) n++
  }
  if (await enqueueJob(db, 'auth_cleanup', { dedupeKey: `auth_cleanup:system:${d}:${t.slice(0, 2)}`, maxAttempts: 1 })) n++
  if (pushReady() && await enqueueJob(db, 'app_push', { dedupeKey: `app_push:system:${d}:${t.slice(0, 3)}${Math.floor(Number(t.slice(3, 5)) / 5)}`, maxAttempts: 1 })) n++
  return n
}

export async function scheduleTick(db: Db): Promise<number> {
  const wss = await db.select().from(schema.workspaces).where(and(isNull(schema.workspaces.pausedAt), isNull(schema.workspaces.deletedAt)))
  let n = await scheduleSystem(db)
  for (const ws of wss) {
    const d = today(ws.timezone)
    for (const e of dueEntries([...scheduleFor(ws), ...extensionSchedule(ws) as ScheduleEntry[]], d, nowTime(ws.timezone))) {
      if (await enqueueJob(db, e.type, { workspaceId: ws.id, dedupeKey: `${e.type}:${ws.id}:${e.weekly ? startOfWeek(d) : d}` })) n++
    }
    if (await hasMailbox(db, ws.id)) {
      const t = nowTime(ws.timezone)
      const slot = `${t.slice(0, 2)}${Number(t.slice(3, 5)) < 30 ? '00' : '30'}`
      if (await enqueueJob(db, 'mail_sync', { workspaceId: ws.id, dedupeKey: `mail_sync:${ws.id}:${d}:${slot}`, maxAttempts: 1 })) n++
    }
    if (listeningSources(ws) && ws.settings?.agentEnabled !== false) {
      const t = timeOf(minutesOf(nowTime(ws.timezone)) - workspaceOffset(ws.id))
      const slot = LISTEN_SLOTS.filter(s => t >= s).pop()
      if (slot && await enqueueJob(db, 'social_listening', { workspaceId: ws.id, dedupeKey: `social_listening:${ws.id}:${d}:${slot}`, maxAttempts: 1 })) n++
    }
    if (hasTransientConn(ws)) {
      const h = nowTime(ws.timezone).slice(0, 2)
      if (await enqueueJob(db, 'conn_recheck', { workspaceId: ws.id, dedupeKey: `conn_recheck:${ws.id}:${d}:${h}`, maxAttempts: 1 })) n++
    }
    if (await hasFeeds(db, ws.id)) {
      const h = Number(nowTime(ws.timezone).slice(0, 2))
      if (await enqueueJob(db, 'feed_sync', { workspaceId: ws.id, dedupeKey: `feed_sync:${ws.id}:${d}:${h - (h % 2)}`, maxAttempts: 1 })) n++
    }
  }
  return n
}

export async function handleJob(db: Db, job: JobRow): Promise<void> {
  const ext = extensionJobHandler(job.type)
  if (ext) {
    await ext(db, job)
    return
  }
  if (job.type === 'system_mail') {
    await runSystemMailJob(job.payload)
    return
  }
  if (job.type === 'morning_mail') {
    await runMorningMail(db, String(job.payload.userId))
    return
  }
  if (job.type === 'auth_cleanup') {
    await pruneRateLimits(db)
    await pruneCalls(db)
    await warnExpiringTokens(db)
    await pruneAuthCodes(db)
    await pruneSessions(db)
    await prunePushSent(db)
    return
  }
  if (job.type === 'app_push') {
    await notifyApprovals(db)
    return
  }
  if (job.type === 'zernio_cleanup') {
    await cleanupZernio({ profileId: job.payload.profileId ? String(job.payload.profileId) : null, accountIds: Array.isArray(job.payload.accountIds) ? job.payload.accountIds.map(String) : [] })
    return
  }
  if (job.type === 'storage_usage') {
    await runStorageUsage(db, job.workspace_id)
    if (!job.workspace_id) await recordZernioUsage(db, new Date().toISOString().slice(0, 10))
    return
  }
  if (!job.workspace_id) return
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, job.workspace_id))
  if (!ws) return
  switch (job.type) {
    case 'materialize_recurrences':
      await runMaterialize(db, ws)
      await runTaskChecks(db, ws)
      break
    case 'draft_tasks': await runDraftTasks(db, ws); break
    case 'draft_task':
      await runDraftTask(db, ws, String(job.payload.taskId), undefined, { retry: !!job.payload.retry, hold: !!job.payload.hold })
      await drainTalk(db, ws, String(job.payload.taskId), undefined, { afterDraft: true }).catch(err => console.error('[talk]', err))
      break
    case 'followups': await runFollowups(db, ws); break
    case 'daily_briefing': await runDailyBriefing(db, ws, undefined, { refresh: !!job.payload.refresh }); break
    case 'weekly_report': await runWeeklyReport(db, ws); break
    case 'strategy_review': await runStrategyReview(db, ws); break
    case 'onboard_project': await runOnboardProject(db, ws, String(job.payload.projectId), { preview: job.payload.preview === true }); break
    case 'publish_post': await runPublishPost(db, ws, String(job.payload.postId)); break
    case 'publish_article': await runPublishArticle(db, ws, { taskId: String(job.payload.taskId), draftId: String(job.payload.draftId), mode: job.payload.mode ? String(job.payload.mode) : undefined, at: job.payload.at ? String(job.payload.at) : undefined, retried: !!job.payload.retried }); break
    case 'withdraw_article': await runWithdrawArticle(db, ws, { taskId: String(job.payload.taskId), retried: !!job.payload.retried }); break
    case 'publish_status': await runPublishStatus(db, ws, String(job.payload.postId)); break
    case 'social_stats': await runSocialStats(db, ws); break
    case 'conn_recheck': await runConnRecheck(db, ws); break
    case 'mail_sync': await runMailSync(db, ws); break
    case 'utm_sync': await runUtmSync(db, ws, job.payload.projectId ? String(job.payload.projectId) : null); break
    case 'search_sync': await runSearchSync(db, ws, job.payload.projectId ? String(job.payload.projectId) : null); break
    case 'feed_sync': await runFeedSync(db, ws, job.payload.projectId ? String(job.payload.projectId) : null); break
    case 'geo_check': await runGeoCheck(db, ws, job.payload.projectId ? String(job.payload.projectId) : null); break
    case 'seo_audit': await runSeoAudit(db, ws, job.payload.projectId ? String(job.payload.projectId) : null); break
    case 'site_read': await runSiteRead(db, ws, job.payload.projectId ? String(job.payload.projectId) : null); break
    case 'send_mail': await runSendMail(db, ws, String(job.payload.mailId)); break
    case 'document_digest': await digestDocument(db, ws, String(job.payload.documentId)); break
    case 'rethink_strategy': await runRethinkStrategy(db, ws, String(job.payload.projectId), { userId: job.payload.userId ? String(job.payload.userId) : null, reason: job.payload.reason ? String(job.payload.reason) : null }); break
    case 'social_listening': await runListening(db, ws); break
    case 'listening_reply': await runListeningReply(db, ws, { taskId: String(job.payload.taskId), draftId: String(job.payload.draftId) }); break
    case 'reconcile_tasks': await runReconcileTasks(db, ws, String(job.payload.projectId)); break
  }
}

export async function runStorageUsage(db: Db, workspaceId: string | null = null): Promise<number> {
  const storage = useStorage()
  const wss = await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(workspaceId ? eq(schema.workspaces.id, workspaceId) : undefined)
  for (const ws of wss) {
    const bytes = await workspaceStorageBytes(ws.id, storage)
    await db.update(schema.workspaces).set({ storageBytes: bytes, storageCountedAt: new Date() }).where(eq(schema.workspaces.id, ws.id))
  }
  return wss.length
}

export async function runOnce(db: Db, workerId: string): Promise<boolean> {
  const job = await claimJob(db, workerId)
  if (!job) return false
  try {
    await handleJob(db, job)
    await completeJob(db, job.id)
  }
  catch (err) {
    if (isLimitError(err)) await completeJob(db, job.id, 'skipped', err.message)
    else if (await failJob(db, job, (err as Error).message)) {
      await reportError({ source: 'job', message: (err as Error).message, detail: { jobId: job.id, type: job.type, workspaceId: job.workspace_id, attempts: job.attempts } })
    }
  }
  return true
}

export async function runWorker(getDb: () => Promise<Db>, opts: { signal: AbortSignal, log?: (m: string) => void, idleMs?: number, tickMs?: number, concurrency?: number }): Promise<void> {
  const log = opts.log ?? console.log
  const base = `${hostname()}:${process.pid}`
  const idle = opts.idleMs ?? 2000
  const tickEvery = opts.tickMs ?? 30_000
  const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? config.workerConcurrency))
  let lastTick = 0
  const db = await getDb()
  installBraveMeter(db)
  await requeueStale(db)
  log(`Worker ${base} läuft (${concurrency} ${concurrency === 1 ? 'Schleife' : 'Schleifen'})`)
  const loop = async (i: number) => {
    const workerId = concurrency === 1 ? base : `${base}:${i}`
    while (!opts.signal.aborted) {
      try {
        if (i === 0 && Date.now() - lastTick > tickEvery) {
          lastTick = Date.now()
          const n = await scheduleTick(db)
          if (n) log(`${n} geplante Jobs eingereiht`)
          const stale = await requeueStale(db)
          if (stale) log(`${stale} hängende Jobs zurückgesetzt`)
        }
        const worked = await runOnce(db, workerId)
        if (!worked) await sleep(idle, opts.signal)
      }
      catch (err) {
        log(`Fehler: ${(err as Error).message}`)
        await sleep(5000, opts.signal)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, i) => loop(i)))
  log('Worker beendet')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })
}
